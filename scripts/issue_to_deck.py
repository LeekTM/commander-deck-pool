"""
Turns a filled-out "Submit a Commander deck" issue form into a decks/*.txt
file. Used by .github/workflows/issue-to-deck.yml; also runnable standalone
for testing against a saved issue body.

GitHub renders an issue-form textarea with `render: text` as a fenced code
block under its "### <label>" heading, and an unanswered optional field as
"_No response_". This parses that rendered markdown back into field values.

Usage:
    python issue_to_deck.py --body-file body.md --issue 42 --out-dir decks --json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from validate_deck import validate_parsed
from deck_parser import parse_decklist_text
from scryfall import fetch_game_changers

COMMANDER_LABEL = "Commander"
DECKLIST_LABEL = "Deck"

_HEADING_RE = re.compile(r"^###\s+(.+?)\s*$", re.MULTILINE)


def parse_issue_body(body: str) -> dict[str, str]:
    """Splits a GitHub-issue-form body into {label: raw_value}."""
    body = body.replace("\r\n", "\n")
    matches = list(_HEADING_RE.finditer(body))
    fields: dict[str, str] = {}
    for i, m in enumerate(matches):
        label = m.group(1).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        value = body[start:end].strip()
        fields[label] = value
    return fields


def _clean_value(raw: str | None) -> str:
    if raw is None:
        return ""
    raw = raw.strip()
    if raw == "_No response_":
        return ""
    fence = re.match(r"^```[a-zA-Z]*\n([\s\S]*?)\n?```$", raw)
    if fence:
        return fence.group(1).strip()
    return raw


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "deck"


def unique_path(out_dir: str, slug: str, issue_number: int) -> str:
    path = os.path.join(out_dir, f"{slug}.txt")
    if not os.path.exists(path):
        return path
    return os.path.join(out_dir, f"{slug}-{issue_number}.txt")


_EMBEDDED_METADATA_RE = re.compile(
    r"^//\s*(tags|bracket|name|url|source|set|released)\s*:", re.IGNORECASE
)


def strip_embedded_metadata(text: str) -> str:
    """Removes leading // metadata comment lines the submission page embeds
    in the decklist (see docs/js/submit.js) -- the final file gets its own
    canonical header from build_deck_text instead."""
    lines = text.split("\n")
    kept = [line for line in lines if not _EMBEDDED_METADATA_RE.match(line.strip())]
    while kept and kept[0].strip() == "":
        kept.pop(0)
    return "\n".join(kept)


def build_full_decklist(commander_raw: str, deck_raw: str) -> str:
    """Assembles the separate Commander/Deck form fields into the
    "Commander\\n...\\n\\nDeck\\n..." text the parser expects (mirrors
    docs/js/submit.js's buildDecklistText()) -- so the submitter never has
    to type those section headers themselves. An empty Commander field
    falls back to the Deck field as-is, still supporting a full paste
    (headers included) into that one field alone."""
    commander_lines = [line.strip() for line in commander_raw.splitlines() if line.strip()]
    commander_lines = [line if re.match(r"^\d", line) else f"1 {line}" for line in commander_lines]
    if not commander_lines:
        return deck_raw
    return "Commander\n" + "\n".join(commander_lines) + f"\n\nDeck\n{deck_raw}"


def build_deck_text(deck_name: str, tags: str, bracket_digits: str, decklist: str) -> str:
    lines = [
        f"// name: {deck_name}",
        "// source: community",
    ]
    if tags:
        lines.append(f"// tags: {tags}")
    if bracket_digits:
        lines.append(f"// bracket: {bracket_digits}")
    lines.append("")
    lines.append(decklist.strip())
    lines.append("")
    return "\n".join(lines)


def process(body: str, issue_number: int, out_dir: str) -> dict:
    fields = parse_issue_body(body)
    commander_raw = _clean_value(fields.get(COMMANDER_LABEL))
    deck_raw = _clean_value(fields.get(DECKLIST_LABEL))

    if not deck_raw:
        return {"ok": False, "errors": ["Decklist is missing."], "warnings": [], "path": None}

    # Commander and Deck are separate form fields so the submitter never
    # has to type "Commander"/"Deck" section headers themselves -- reunite
    # them into the text the parser expects. Tags/bracket ride as // comments
    # at the top of the Deck field (the submission page does this
    # automatically; a hand-written direct-to-GitHub submission can too, per
    # the field's description) -- parse_decklist_text picks metadata up from
    # anywhere in the combined text, so position doesn't matter. validate_parsed
    # already applies a // bracket: override from .metadata internally --
    # bracket_digits here is only needed to decide whether the final file
    # gets a // bracket: line at all.
    decklist = build_full_decklist(commander_raw, deck_raw)
    parsed = parse_decklist_text(decklist)
    tags = parsed.metadata.get("tags", "").strip()
    bracket_digits = parsed.metadata.get("bracket", "").strip()
    if bracket_digits not in ("1", "2", "3", "4", "5"):
        bracket_digits = ""

    game_changers = fetch_game_changers()
    result = validate_parsed(parsed, game_changers=game_changers)

    if not result.ok:
        return {"ok": False, "errors": result.errors, "warnings": result.warnings, "path": None}

    deck_name = f"{' + '.join(result.commanders)} (Bracket {result.bracket})"
    deck_text = build_deck_text(deck_name, tags, bracket_digits, strip_embedded_metadata(decklist))

    slug = slugify(deck_name)
    path = unique_path(out_dir, slug, issue_number)
    os.makedirs(out_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(deck_text)

    return {
        "ok": True,
        "errors": [],
        "warnings": result.warnings,
        "path": path,
        "name": deck_name,
        "commanders": result.commanders,
        "companion": result.companion,
        "total_cards": result.total_cards,
        "price_eur": result.price_eur,
        "price_usd": result.price_usd,
        "colors": result.colors,
        "gc": result.game_changer_count,
        "bracket": result.bracket,
        "bracket_overridden": result.bracket_overridden,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--body-file", required=True, help="File containing the raw issue body")
    ap.add_argument("--issue", type=int, required=True, help="Issue number")
    ap.add_argument("--out-dir", default="decks")
    args = ap.parse_args()

    with open(args.body_file, encoding="utf-8") as f:
        body = f.read()

    result = process(body, args.issue, args.out_dir)
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
