# /// script
# requires-python = ">=3.11"
# dependencies = ["anthropic"]
# ///

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import anthropic

SCRIPT_DIR = Path(__file__).parent
HISTORY_FILE = SCRIPT_DIR / "word_history.json"
WRITING_DIR = SCRIPT_DIR / "writing"

STOP_WORDS = {
    "a", "an", "the", "and", "but", "or", "nor", "for", "yet", "so",
    "is", "are", "was", "were", "be", "been", "being", "am",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "must", "can", "could",
    "i", "me", "my", "myself", "we", "our", "ours", "ourselves",
    "you", "your", "yours", "yourself", "yourselves",
    "he", "him", "his", "himself", "she", "her", "hers", "herself",
    "it", "its", "itself", "they", "them", "their", "theirs", "themselves",
    "what", "which", "who", "whom", "this", "that", "these", "those",
    "to", "of", "in", "on", "at", "by", "up", "as", "into", "through",
    "with", "about", "against", "between", "during", "without",
    "before", "after", "above", "below", "from", "out", "off", "over",
    "under", "again", "further", "then", "once", "here", "there",
    "when", "where", "why", "how", "all", "both", "each", "few", "more",
    "most", "other", "some", "such", "no", "not", "only", "own", "same",
    "than", "too", "very", "just", "because", "if", "while", "although",
    "though", "since", "until", "unless", "also", "well", "even",
    "back", "any", "could", "been", "come", "made", "make", "like",
    "time", "know", "take", "see", "look", "want", "give", "use",
    "find", "tell", "ask", "seem", "feel", "try", "leave", "call",
    "still", "never", "every", "much", "need", "said", "says", "say",
    "went", "come", "came", "going", "get", "got", "put", "set",
    "let", "keep", "held", "last", "long", "great", "little", "own",
    "right", "old", "big", "high", "next", "early", "young", "important",
    "public", "private", "real", "best", "free", "able", "new",
}

MIN_WORD_LEN = 4


def extract_sentences(text: str) -> list[str]:
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    return [s.strip() for s in sentences if s.strip()]


def extract_words(text: str) -> list[str]:
    return re.findall(r"\b[a-zA-Z]+\b", text)


def is_content_word(word: str) -> bool:
    w = word.lower()
    return len(w) >= MIN_WORD_LEN and w not in STOP_WORDS


def map_words_to_sentences(sentences: list[str]) -> dict[str, list[str]]:
    word_sentences: dict[str, list[str]] = defaultdict(list)
    for sentence in sentences:
        words = extract_words(sentence)
        seen_in_sentence: set[str] = set()
        for word in words:
            w = word.lower()
            if is_content_word(w) and w not in seen_in_sentence:
                word_sentences[w].append(sentence)
                seen_in_sentence.add(w)
    return dict(word_sentences)


def load_history() -> dict:
    if HISTORY_FILE.exists():
        return json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
    return {}


def save_history(history: dict) -> None:
    HISTORY_FILE.write_text(
        json.dumps(history, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def update_history(
    history: dict, word_sentences: dict[str, list[str]], file_path: str
) -> None:
    today = date.today().isoformat()
    for word, sentences in word_sentences.items():
        if word not in history:
            history[word] = []
        for sentence in sentences:
            history[word].append(
                {"sentence": sentence, "date": today, "file": file_path}
            )


def get_rewrite(client: anthropic.Anthropic, word: str, sentence: str) -> str:
    resp = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=256,
        system=[
            {
                "type": "text",
                "text": (
                    "You are a writing coach helping a writer build vocabulary. "
                    "Given a sentence and an overused word, rewrite ONLY that sentence "
                    "with a more precise or varied word choice. "
                    "Preserve the meaning and tone. "
                    "Return only the rewritten sentence — no explanation, no quotes."
                ),
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[
            {
                "role": "user",
                "content": f'Overused word: "{word}"\nSentence: {sentence}',
            }
        ],
    )
    return resp.content[0].text.strip()


def print_section(title: str) -> None:
    print(f"\n{'═' * 60}")
    print(f"  {title}")
    print(f"{'═' * 60}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Vocabulary expander")
    parser.add_argument(
        "file",
        nargs="?",
        help="Path to a text/markdown file (defaults to today's file in writing/)",
    )
    args = parser.parse_args()

    if args.file:
        target = Path(args.file)
    else:
        target = WRITING_DIR / f"{date.today().isoformat()}.md"

    if not target.exists():
        print(f"File not found: {target}", file=sys.stderr)
        if not args.file:
            print(
                f"Tip: create {target} to use the default behavior.", file=sys.stderr
            )
        sys.exit(1)

    text = target.read_text(encoding="utf-8")
    sentences = extract_sentences(text)
    word_sentences = map_words_to_sentences(sentences)

    overused = {
        word: sents for word, sents in word_sentences.items() if len(sents) >= 3
    }

    history = load_history()
    update_history(history, word_sentences, str(target))
    save_history(history)

    client = anthropic.Anthropic()

    # ── Section 1: overused in this file ──────────────────────────
    print_section(f"WORDS OVERUSED IN THIS FILE  ({target.name})")

    if not overused:
        print("\n  No words used 3+ times. Great variety!")
    else:
        for word, sents in sorted(overused.items(), key=lambda x: -len(x[1])):
            print(f"\n▸ {word.upper()}  (×{len(sents)})")
            for sentence in sents:
                rewrite = get_rewrite(client, word, sentence)
                print(f"    Original : {sentence}")
                print(f"    Rewrite  : {rewrite}")
                print()

    # ── Section 2: long-term patterns ─────────────────────────────
    print_section("LONG-TERM OVERUSE PATTERNS  (all-time top 5)")

    word_totals = {word: len(entries) for word, entries in history.items()}
    top5 = sorted(word_totals.items(), key=lambda x: -x[1])[:5]

    if not top5:
        print("\n  No history yet.")
    else:
        for rank, (word, count) in enumerate(top5, 1):
            entries = history[word]
            recent = entries[-2:] if len(entries) >= 2 else entries
            print(f"\n  {rank}. {word.upper()}  (total: {count}×)")
            for entry in recent:
                print(f"     [{entry['date']}] {entry['sentence']}")


if __name__ == "__main__":
    main()
