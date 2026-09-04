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

FIELD_LABELS = {
    "decklist": "Decklist",
    "tags": "Tags (comma-separated)",
    "bracket": "Bracket",
}

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
    decklist = _clean_value(fields.get(FIELD_LABELS["decklist"]))
    tags_field = _clean_value(fields.get(FIELD_LABELS["tags"]))
    bracket_field = _clean_value(fields.get(FIELD_LABELS["bracket"]))

    if not decklist:
        return {"ok": False, "errors": ["Decklist is missing."], "warnings": [], "path": None}

    # The submission page embeds tags/bracket as // comments at the top of
    # the decklist itself, because GitHub's query-param prefill has proven
    # unreliable for the separate Tags/Bracket form fields (dropdown/input),
    # while the decklist textarea's prefill is reliable. parse_decklist_text
    # picks embedded metadata up the same way it would for a hand-written
    # file. Someone filling this form out directly on GitHub (not via the
    # page) has no embedded metadata, so fall back to the plain fields.
    parsed = parse_decklist_text(decklist)
    embedded_tags = parsed.metadata.get("tags", "").strip()
    embedded_bracket = parsed.metadata.get("bracket", "").strip()

    tags = embedded_tags or tags_field

    bracket_digits = ""
    if embedded_bracket.isdigit():
        bracket_digits = embedded_bracket
    elif bracket_field and bracket_field.strip().lower() not in ("", "auto", "auto (recommended)"):
        bracket_digits = re.sub(r"\D", "", bracket_field)
        # Wasn't embedded, so re-parse with it injected the same way a
        # hand-written file would carry it, so validate_parsed sees it.
        parsed = parse_decklist_text(f"// bracket: {bracket_digits}\n{decklist}")

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
