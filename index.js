const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const PORT            = process.env.PORT || 3000;
const LINE_TOKEN      = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CLAUDE_KEY      = process.env.CLAUDE_API_KEY;
const MASTER_SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Google Sheets client
let sheets;
try {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheets = google.sheets({ version: 'v4', auth });
} catch (e) {
  console.error('Google Sheets init failed:', e.message);
}

const userStates = {};


// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => res.send('Receipt Tracker Bot is running!'));

// ── Weekly trigger endpoint (called by external cron) ─────────
app.get('/weekly-trigger', async (req, res) => {
  res.send('Weekly trigger fired');
  try {
    const userIds = await getAllUserIds();
    for (const userId of userIds) {
      const sheetId = await getUserSheetId(userId);
      if (!sheetId) continue;
      const summary = await generateSummary(sheetId, 'week');
      await push(userId, summary);
    }
  } catch (err) {
    console.error('Weekly trigger error:', err.message);
  }
});

// ── Daily ELI5 trigger (called by external cron) ─────────────
app.get('/daily-eli5', async (req, res) => {
  res.send('Daily ELI5 triggered');
  try {
    const eli5 = await generateELI5();
    const userIds = await getAllUserIds();
    for (const userId of userIds) {
      await push(userId, eli5);
    }
  } catch (err) {
    console.error('Daily ELI5 error:', err.message);
  }
});

// ── LINE webhook ──────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  for (const event of events) {
    try { await handleEvent(event); }
    catch (err) { console.error('handleEvent error:', err.message); }
  }
});

// ── Event handler ─────────────────────────────────────────────
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const userId     = event.source.userId;
  const replyToken = event.replyToken;

  if (event.message.type === 'image') {
    userStates[userId] = { imageMessageId: event.message.id };
    await push(userId, '📝 Got your receipt! What\'s this for?\n\n(e.g. "Lunch at cafe" or "Groceries")');
    return;
  }

  if (event.message.type === 'text') {
    const text = event.message.text.trim();

    // Register command
    if (text.toLowerCase().startsWith('register ')) {
      const sheetId = text.split(' ')[1]?.trim();
      if (!sheetId) { await push(userId, '❌ Please send: register YOUR_SHEET_ID'); return; }
      await registerUser(userId, sheetId);
      return;
    }

    // Manual add command: add AMOUNT DESCRIPTION
    // e.g. "add 500 TrueMoney top-up"
    if (text.toLowerCase().startsWith('add ')) {
      const parts = text.split(' ');
      const amount = parseFloat(parts[1]);
      const description = parts.slice(2).join(' ');

      if (isNaN(amount) || !description) {
        await push(userId, '❌ Wrong format. Use:\nadd AMOUNT DESCRIPTION\n\nExample:\nadd 500 TrueMoney top-up');
        return;
      }

      const userSheetId = await getUserSheetId(userId);
      if (!userSheetId) { await push(userId, '❌ Not registered. Type: register YOUR_SHEET_ID'); return; }

      const now = new Date();
      const data = {
        date: now.toISOString().split('T')[0],
        time: now.toTimeString().substring(0, 5),
        total: amount,
        recipient: ''
      };

      await saveToSheet(userSheetId, description, data);
      await push(userId, `✅ Added manually!\n\nDescription: ${description}\nDate: ${data.date} ${data.time}\nTotal: ฿${amount}`);
      return;
    }

    // Summary command
    if (text.toLowerCase() === 'summary' || text === 'สรุป') {
      const sheetId = await getUserSheetId(userId);
      if (!sheetId) { await push(userId, '❌ Not registered yet. Type: register YOUR_SHEET_ID'); return; }
      await push(userId, '⏳ Generating summary...');
      const summary = await generateSummary(sheetId, 'month');
      await push(userId, summary);
      return;
    }

    // Description after photo
    const state = userStates[userId];
    if (state && state.imageMessageId) {
      const description    = text;
      const imageMessageId = state.imageMessageId;
      delete userStates[userId];
      await push(userId, '⏳ Reading your receipt...');
      await processReceipt(userId, imageMessageId, description);
      return;
    }

    await push(userId, '📸 Send me a receipt photo!\n\nCommands:\n• register SHEET_ID\n• summary / สรุป');
  }
}

// ── Register user ─────────────────────────────────────────────
async function registerUser(userId, sheetId) {
  try {
    const spreadsheet    = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID });
    const existingSheets = spreadsheet.data.sheets.map(s => s.properties.title);

    if (!existingSheets.includes('users')) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'users' } } }] }
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: MASTER_SHEET_ID, range: 'users!A1', valueInputOption: 'RAW',
        requestBody: { values: [['user_id', 'sheet_id']] }
      });
    }

    const res  = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: 'users!A:B' });
    const rows = res.data.values || [];
    let found  = false;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === userId) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: MASTER_SHEET_ID, range: `users!B${i + 1}`,
          valueInputOption: 'RAW', requestBody: { values: [[sheetId]] }
        });
        found = true; break;
      }
    }
    if (!found) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: MASTER_SHEET_ID, range: 'users!A1', valueInputOption: 'RAW',
        requestBody: { values: [[userId, sheetId]] }
      });
    }
    await push(userId, '✅ Registered! Send a receipt photo to get started!');
  } catch (err) {
    console.error('registerUser error:', err.message);
    await push(userId, '❌ Registration failed. Make sure you shared your sheet with:\nreceipt-bot@line-stupid-receipt.iam.gserviceaccount.com');
  }
}

// ── Get user sheet ID ─────────────────────────────────────────
async function getUserSheetId(userId) {
  try {
    const res  = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: 'users!A:B' });
    const rows = res.data.values || [];
    for (const row of rows) { if (row[0] === userId) return row[1]; }
  } catch (e) {}
  return null;
}

// ── Get all user IDs (for weekly trigger) ─────────────────────
async function getAllUserIds() {
  try {
    const res  = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: 'users!A:A' });
    const rows = res.data.values || [];
    return rows.slice(1).map(r => r[0]).filter(Boolean);
  } catch (e) { return []; }
}

// ── Process receipt ───────────────────────────────────────────
async function processReceipt(userId, imageMessageId, description) {
  try {
    const userSheetId = await getUserSheetId(userId);
    if (!userSheetId) {
      await push(userId, '❌ Not registered!\n\nType: register YOUR_SHEET_ID');
      return;
    }

    const imgRes = await axios.get(
      `https://api-data.line.me/v2/bot/message/${imageMessageId}/content`,
      { headers: { Authorization: `Bearer ${LINE_TOKEN}` }, responseType: 'arraybuffer' }
    );
    const imageBase64 = Buffer.from(imgRes.data).toString('base64');
    const mimeType    = imgRes.headers['content-type'] || 'image/jpeg';

    const data = await callClaude(imageBase64, mimeType, description);
    await saveToSheet(userSheetId, description, data);

    await push(userId,
      `✅ Saved!\n\nDescription: ${description}\nDate: ${data.date} ${data.time}\nTotal: ฿${data.total}\nRecipient: ${data.recipient || '-'}`
    );
  } catch (err) {
    console.error('processReceipt error:', err.message);
    await push(userId, '❌ Something went wrong. Please try again.');
  }
}

// ── Claude Vision ─────────────────────────────────────────────
async function callClaude(imageBase64, mimeType, description) {
  const client = new Anthropic({ apiKey: CLAUDE_KEY });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
        { type: 'text', text:
          `Analyze this Thai receipt or bank slip. User says it is for: "${description}".\n\n` +
          `Extract these 4 things:\n` +
          `- date: raw date text as it appears (e.g. "27 พ.ค. 2569"), do not convert\n` +
          `- time: transaction time HH:MM (24hr), or ""\n` +
          `- total: final amount as number only\n` +
          `- recipient: merchant/company name that received money (NOT bank name, NOT Thai person name). Return "" if none.\n\n` +
          `Reply ONLY with valid JSON:\n` +
          `{"date":"...","time":"...","total":0.00,"recipient":"..."}`
        }
      ]
    }]
  });

  const text  = msg.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    const parsed = JSON.parse(match[0]);
    parsed.date = convertThaiDate(parsed.date);
    return parsed;
  }
  return { date: today(), time: '', total: 0, recipient: '' };
}

function convertThaiDate(raw) {
  if (!raw) return today();

  const s = String(raw).normalize('NFC').trim();

  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Match Thai month: abbreviation (dots optional) OR full name. Order matters.
  const monthPatterns = [
    [/มี\.?ค\.?|มีนา/,   '03'],  // March  (check before ม.ค.)
    [/ม\.?ค\.?|มกรา/,    '01'],  // January
    [/ก\.?พ\.?|กุมภา/,   '02'],  // February
    [/เม\.?ย\.?|เมษา/,   '04'],  // April
    [/พฤษภา|พ\.?ค\.?/,   '05'],  // May
    [/มิ\.?ย\.?|มิถุนา/, '06'],  // June
    [/ก\.?ค\.?|กรกฎา/,   '07'],  // July
    [/ส\.?ค\.?|สิงหา/,   '08'],  // August
    [/ก\.?ย\.?|กันยา/,   '09'],  // September
    [/ต\.?ค\.?|ตุลา/,    '10'],  // October
    [/พฤศจิกา|พ\.?ย\.?/, '11'],  // November
    [/ธ\.?ค\.?|ธันวา/,   '12'],  // December
  ];

  let month = null;
  for (const [pattern, num] of monthPatterns) {
    if (pattern.test(s)) { month = num; break; }
  }
  if (!month) return today();  // couldn't parse — fall back, never store junk

  // Day = first 1-2 digit number; Year = 4-digit number
  const dayMatch  = s.match(/\b(\d{1,2})\b/);
  const yearMatch = s.match(/\b(\d{4})\b/);
  if (!dayMatch || !yearMatch) return today();

  const day  = dayMatch[1].padStart(2, '0');
  let   year = parseInt(yearMatch[1]);
  if (year > 2400) year -= 543;  // Buddhist Era → Gregorian

  return `${year}-${month}-${day}`;
}

// ── Google Sheets ─────────────────────────────────────────────
async function saveToSheet(sheetId, description, data) {
  if (!sheets) throw new Error('Google Sheets not configured');
  const month = (data.date || today()).substring(0, 7);

  const spreadsheet    = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existingSheets = spreadsheet.data.sheets.map(s => s.properties.title);

  if (!existingSheets.includes(month)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: month } } }] }
    });
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId, range: `${month}!A1`, valueInputOption: 'RAW',
      requestBody: { values: [['Description', 'Date', 'Time', 'Total', 'Recipient']] }
    });
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId, range: `${month}!A1`, valueInputOption: 'RAW',
    requestBody: { values: [[
      description, data.date || '', data.time || '',
      data.total || 0, data.recipient || ''
    ]] }
  });
}

// ── Generate summary ──────────────────────────────────────────
async function generateSummary(sheetId, period = 'month') {
  try {
    const month = today().substring(0, 7);
    const res   = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${month}!A:F` });
    const rows  = res.data.values || [];

    if (rows.length <= 1) return `📊 No receipts found for ${month}.`;

    const now       = new Date();
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0, 0, 0, 0);

    let grandTotal = 0;
    let count      = 0;
    let rows_msg   = '';

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[1]) continue;

      if (period === 'week') {
        const rowDate = new Date(row[1]);
        if (rowDate < weekStart) continue;
      }

      const amount      = parseFloat(row[3]) || 0;
      const description = row[0] || '-';
      grandTotal += amount;
      count++;
      rows_msg += `• ${description}: ฿${amount.toFixed(2)}\n`;
    }

    if (count === 0) return period === 'week'
      ? '📊 No receipts this week yet.'
      : `📊 No receipts found for ${month}.`;

    const periodLabel = period === 'week'
      ? `This week (${weekStart.toLocaleDateString('en-GB')})`
      : month;

    const msg = `📊 Spending Summary\n${periodLabel}\n━━━━━━━━━━━━━━━━\n${rows_msg}━━━━━━━━━━━━━━━━\n💰 Total: ฿${grandTotal.toFixed(2)} (${count} receipts)`;

    return msg;
  } catch (err) {
    return '📊 Could not generate summary. Make sure you have receipts saved.';
  }
}

// ── ELI5 generator ───────────────────────────────────────────
const ELI5_TOPICS = [
  'How does Wi-Fi work?',
  'What are black holes?',
  'How does soap clean things?',
  'Why do we dream?',
  'How do planes stay up in the air?',
  'Why is the sky blue?',
  'How does electricity work?',
  'What is DNA?',
  'How do magnets work?',
  'Why do we have seasons?',
  'How does the internet work?',
  'What causes thunder and lightning?',
  'How do our eyes see color?',
  'Why does ice float on water?',
  'How do vaccines work?',
  'What is gravity?',
  'How do computers think?',
  'Why do onions make you cry?',
  'What causes rainbows?',
  'How do batteries store energy?',
  'Why do stars twinkle?',
  'How does GPS know where you are?',
  'What is blockchain?',
  'How do airplanes know where to go?',
  'Why does the moon change shape?',
  'How does your stomach digest food?',
  'What is AI and how does it learn?',
  'Why do we get hiccups?',
  'How do touchscreens work?',
  'What causes earthquakes?',
];

async function generateELI5() {
  const topic = ELI5_TOPICS[Math.floor(Math.random() * ELI5_TOPICS.length)];
  const client = new Anthropic({ apiKey: CLAUDE_KEY });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content:
        `Explain this topic like I'm 5 years old: "${topic}"\n\n` +
        `Rules:\n` +
        `- Use simple analogies a child would understand\n` +
        `- Keep it fun and use 1-2 emojis max\n` +
        `- Total length under 500 characters (this is for a LINE chat message)\n` +
        `- Start with the topic as a header like: 🧒 ELI5: ${topic}\n` +
        `- End with a one-line fun fact`
    }]
  });
  return msg.content[0].text;
}

// ── LINE helpers ──────────────────────────────────────────────
async function reply(replyToken, text) {
  await axios.post('https://api.line.me/v2/bot/message/reply',
    { replyToken, messages: [{ type: 'text', text }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
  );
}

async function push(userId, text) {
  await axios.post('https://api.line.me/v2/bot/message/push',
    { to: userId, messages: [{ type: 'text', text }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
  );
}

function today() { return new Date().toISOString().split('T')[0]; }

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
