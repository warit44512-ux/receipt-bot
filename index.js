const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LINE_TOKEN    = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CLAUDE_KEY    = process.env.CLAUDE_API_KEY;
const SHEET_ID      = process.env.GOOGLE_SHEET_ID;

// Google Sheets client via service account
let sheets;
try {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheets = google.sheets({ version: 'v4', auth });
} catch (e) {
  console.error('Google Sheets init failed:', e.message);
}

// Temporary in-memory state (survives between messages, resets on restart)
const userStates = {};

// ── Health check ────────────────────────────────────────────
app.get('/', (req, res) => res.send('Receipt Tracker Bot is running!'));

// ── LINE webhook ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // respond immediately so LINE doesn't retry

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
    await reply(replyToken, '📝 Got your receipt! What\'s this for?\n\n(e.g. "Lunch at cafe" or "Groceries")');
    return;
  }

  if (event.message.type === 'text') {
    const state = userStates[userId];

    if (state && state.imageMessageId) {
      const description    = event.message.text;
      const imageMessageId = state.imageMessageId;
      delete userStates[userId];

      await reply(replyToken, '⏳ Reading your receipt...');
      await processReceipt(userId, imageMessageId, description);
      return;
    }

    await reply(replyToken, '📸 Send me a receipt photo first!');
  }
}

// ── Process receipt ───────────────────────────────────────────
async function processReceipt(userId, imageMessageId, description) {
  try {
    // 1. Fetch image from LINE
    const imgRes = await axios.get(
      `https://api-data.line.me/v2/bot/message/${imageMessageId}/content`,
      { headers: { Authorization: `Bearer ${LINE_TOKEN}` }, responseType: 'arraybuffer' }
    );
    const imageBase64 = Buffer.from(imgRes.data).toString('base64');
    const mimeType    = imgRes.headers['content-type'] || 'image/jpeg';

    // 2. Ask Claude to read the receipt
    const data = await callClaude(imageBase64, mimeType, description);

    // 3. Save to Google Sheets
    await saveToSheet(userId, description, data);

    // 4. Tell the user it worked
    await push(userId,
      `✅ Saved!\n\nDescription: ${description}\nDate: ${data.date}\nTotal: ${data.total}`
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
          `Analyze this Thai receipt or bank slip image.\n\n` +
          `Find ONLY these 2 things:\n` +
          `- date: the transaction date, convert Buddhist Era to Gregorian (e.g. 2569 → 2026), format as YYYY-MM-DD\n` +
          `- total: the final total amount as a number only (e.g. 45.00)\n\n` +
          `Reply ONLY with valid JSON, no other text:\n` +
          `{"date":"YYYY-MM-DD","total":0.00}`
        }
      ]
    }]
  });

  const text  = msg.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  return { date: today(), total: 0 };
}

// ── Google Sheets ─────────────────────────────────────────────
async function saveToSheet(userId, description, data) {
  if (!sheets) throw new Error('Google Sheets not configured');

  const check = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'A1' });
  if (!check.data.values) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: 'A1', valueInputOption: 'RAW',
      requestBody: { values: [['Description','Date','Total']] }
    });
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: 'A1', valueInputOption: 'RAW',
    requestBody: { values: [[description, data.date || '', data.total || 0]] }
  });
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
