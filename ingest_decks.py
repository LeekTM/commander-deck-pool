#!/usr/bin/env python3
"""
Builds deck_db.json from the decklist .txt files in decks/.

    python ingest_decks.py decks/ --out deck_db.json

Each deck file is parsed (scripts/deck_parser.py), then enriched from Scryfall
(scripts/scryfall.py) for prices, colour identity, legality and Game Changer
status. A deck that fails a blocking check (unrecognised card, banned card,
illegal commander, card outside the commander's colour identity) is skipped
with a warning printed to stderr -- one bad file must not break the build for
everyone else. A deck whose card count isn't 100 is included with a warning;
that's a hint for review, not a build blocker.

deck_db.json's schema is fixed by the TTS mod that will read it -- see the
"data contract" section of the project brief before changing field names.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, timezone, datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))

from deck_parser import parse_decklist_text, aggregate_quantities
from scryfall import (
    lookup_cards, fetch_game_changers, is_basic_land, is_legal_commander_card,
    colors_string, compute_bracket,
)


def build_deck_record(path: str, game_changers: set[str]) -> tuple[dict | None, list[str]]:
    """Returns (record, warnings). record is None if the deck was rejected."""
    warnings: list[str] = []
    with open(path, encoding="utf-8") as f:
        text = f.read()

    deck = parse_decklist_text(text)
    warnings.extend(f"parse: {w}" for w in deck.warnings)

    filename_stem = os.path.splitext(os.path.basename(path))[0]
    name = deck.metadata.get("name", "").strip() or filename_stem
    url = deck.metadata.get("url", "").strip()
    source = deck.metadata.get("source", "").strip() or "community"
    set_code = deck.metadata.get("set", "").strip()
    released = deck.metadata.get("released", "").strip()
    tags = sorted({t.strip().lower() for t in deck.metadata.get("tags", "").split(",") if t.strip()})

    commanders = deck.commander_names()
    if not commanders:
        warnings.append("REJECTED: no commander detected")
        return None, warnings

    deck_cards = deck.deck_cards()
    quantities = aggregate_quantities(deck_cards)
    total_cards = sum(quantities.values())
    if total_cards != 100:
        warnings.append(f"deck has {total_cards} cards, not 100")

    unique_names = list(quantities.keys())
    by_name, not_found = lookup_cards(unique_names + commanders, game_changers=game_changers)

    if not_found:
        warnings.append(f"REJECTED: unrecognised card(s): {', '.join(sorted(set(not_found)))}")
        return None, warnings

    # Flagged, not blocked -- the group can playtest cards not (yet, or no
    # longer) legal in Commander. Deliberately not a rejection.
    banned = [n for n in unique_names
              if not is_basic_land(n) and not by_name[n.lower()].legal_commander]
    if banned:
        warnings.append(f"card(s) not legal in Commander (flagged, not blocked): {', '.join(sorted(set(banned)))}")

    illegal_commanders = [c for c in commanders if not is_legal_commander_card(by_name[c.lower()])]
    if illegal_commanders:
        warnings.append(
            f"REJECTED: not a legal commander (not a legendary creature, no commander text): "
            f"{', '.join(illegal_commanders)}"
        )
        return None, warnings

    commander_identity: set[str] = set()
    for c in commanders:
        commander_identity |= set(by_name[c.lower()].color_identity)

    out_of_identity = [
        n for n in unique_names
        if not set(by_name[n.lower()].color_identity).issubset(commander_identity)
    ]
    if out_of_identity:
        warnings.append(
            f"REJECTED: card(s) outside commander colour identity: {', '.join(sorted(set(out_of_identity)))}"
        )
        return None, warnings

    price_usd = 0.0
    price_eur = 0.0
    all_colors: set[str] = set()
    gc_count = 0
    cards_out = []
    for card_name, qty in sorted(quantities.items()):
        info = by_name[card_name.lower()]
        cards_out.append({"n": card_name, "q": qty})
        all_colors |= set(info.color_identity)
        if not is_basic_land(card_name):
            price_usd += (info.price_usd or 0.0) * qty
            price_eur += (info.price_eur or 0.0) * qty
            if info.is_game_changer:
                gc_count += 1

    computed_bracket = compute_bracket(gc_count)
    override = deck.metadata.get("bracket", "").strip()
    if override.isdigit():
        bracket = int(override)
    else:
        bracket = computed_bracket

    record = {
        "name": name,
        "source": source,
        "url": url,
        "set": set_code,
        "released": released,
        "commanders": commanders,
        "cards": cards_out,
        "tags": tags,
        "price_eur": round(price_eur, 2),
        "price_usd": round(price_usd, 2),
        "colors": colors_string(all_colors),
        "gc": gc_count,
        "bracket": bracket,
    }
    return record, warnings


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("decks_dir", nargs="?", default="decks", help="Folder of decklist .txt files")
    ap.add_argument("--out", default="deck_db.json", help="Output path for deck_db.json")
    args = ap.parse_args()

    if not os.path.isdir(args.decks_dir):
        print(f"No such folder: {args.decks_dir}", file=sys.stderr)
        sys.exit(1)

    paths = sorted(
        os.path.join(args.decks_dir, fn)
        for fn in os.listdir(args.decks_dir)
        if fn.lower().endswith(".txt")
    )
    if not paths:
        print(f"No .txt decklists found in {args.decks_dir}", file=sys.stderr)

    print("Fetching current Game Changers list from Scryfall...", file=sys.stderr)
    game_changers = fetch_game_changers()
    print(f"  {len(game_changers)} Game Changers", file=sys.stderr)

    decks = []
    rejected = 0
    for path in paths:
        record, warnings = build_deck_record(path, game_changers)
        for w in warnings:
            print(f"[{os.path.basename(path)}] {w}", file=sys.stderr)
        if record is None:
            rejected += 1
            continue
        decks.append(record)

    decks.sort(key=lambda d: d["name"].lower())

    db = {
        "version": 1,
        "generated": datetime.now(timezone.utc).date().isoformat(),
        "enriched": True,
        "decks": decks,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(db, f, separators=(",", ":"), ensure_ascii=False)

    print(f"Wrote {len(decks)} decks to {args.out} ({rejected} rejected)", file=sys.stderr)


if __name__ == "__main__":
    main()
