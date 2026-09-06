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

Enrichment is cached. Every deck record carries the hash of the .txt it was
built from, so a rebuild only re-fetches decks whose file actually changed --
adding one deck costs one deck's worth of Scryfall calls, not the whole pool's.
Pass --full to re-enrich everything (refreshes prices pool-wide); a revision to
the Game Changers list invalidates the cache on its own, since gc and the
computed bracket both derive from it.

deck_db.json's schema is fixed by the TTS mod that will read it -- see the
"data contract" section of the project brief before changing field names.
"""
from __future__ import annotations

import argparse
import hashlib
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


def content_hash(text: str) -> str:
    """Short, stable digest identifying a deck file's exact contents."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


# The code that decides what ends up in a deck record. A cached record is only
# reusable while this is unchanged: otherwise a fix to enrichment would never
# reach decks whose .txt happens not to have changed, and the cache would
# preserve the very bug the fix was for. (It did, once: a Secret Lair reskin
# was overwriting the ordinary card's price for every other deck running it.)
# Comment-only edits invalidate it too -- a needless full rebuild costs ~70s,
# which is far cheaper than silently serving stale records.
_BUILDER_FILES = ("ingest_decks.py", "scripts/deck_parser.py", "scripts/scryfall.py")


def builder_hash() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    digests = []
    for rel in _BUILDER_FILES:
        path = os.path.join(here, *rel.split("/"))
        try:
            with open(path, "rb") as f:
                digests.append(hashlib.sha256(f.read()).hexdigest())
        except OSError:
            digests.append("missing")
    return content_hash("|".join(digests))


def parse_deck_file(path: str) -> dict:
    """Parse one decklist file into the pieces enrichment needs. No network.

    `reject` is set for anything rejectable without asking Scryfall, so a
    broken file never costs an API call.
    """
    with open(path, encoding="utf-8") as f:
        text = f.read()

    deck = parse_decklist_text(text)
    warnings: list[str] = [f"parse: {w}" for w in deck.warnings]

    filename_stem = os.path.splitext(os.path.basename(path))[0]
    parsed = {
        "path": path,
        "slug": filename_stem,
        "hash": content_hash(text),
        "name": deck.metadata.get("name", "").strip() or filename_stem,
        "url": deck.metadata.get("url", "").strip(),
        "source": deck.metadata.get("source", "").strip() or "community",
        "set": deck.metadata.get("set", "").strip(),
        "released": deck.metadata.get("released", "").strip(),
        "tags": sorted({t.strip().lower() for t in deck.metadata.get("tags", "").split(",") if t.strip()}),
        "bracket_override": deck.metadata.get("bracket", "").strip(),
        "commanders": deck.commander_names(),
        "quantities": aggregate_quantities(deck.deck_cards()),
        "warnings": warnings,
        "reject": None,
    }

    if not parsed["commanders"]:
        parsed["reject"] = "REJECTED: no commander detected"
        return parsed

    total_cards = sum(parsed["quantities"].values())
    if total_cards != 100:
        warnings.append(f"deck has {total_cards} cards, not 100")

    return parsed


def lookup_names_for(parsed: dict) -> list[str]:
    """Every name this deck needs resolved -- its cards plus its commander(s)."""
    return list(parsed["quantities"].keys()) + parsed["commanders"]


def enrich_deck(parsed: dict, by_name: dict, not_found: set[str]) -> tuple[dict | None, list[str]]:
    """Returns (record, warnings). record is None if the deck was rejected.

    Card data comes from `by_name`, fetched once for the whole batch rather
    than per deck: Commander lists overlap heavily (most of them run Sol Ring),
    so pooling the names across every stale deck collapses most of the calls.
    `not_found` is the pool-wide miss set, lowercased -- a name missing from it
    rejects only the decks that actually reference it.
    """
    warnings = list(parsed["warnings"])
    commanders = parsed["commanders"]
    quantities = parsed["quantities"]
    unique_names = list(quantities.keys())

    missing = sorted({n for n in lookup_names_for(parsed) if n.lower() in not_found})
    if missing:
        warnings.append(f"REJECTED: unrecognised card(s): {', '.join(missing)}")
        return None, warnings

    # Flagged, not blocked -- the group can playtest cards not (yet, or no
    # longer) legal in Commander. Deliberately not a rejection.
    # by_name is guaranteed complete by the not_found return above; these
    # membership checks are belt and braces so a gap can never take down the
    # rebuild for every other deck too.
    banned = [n for n in unique_names
              if not is_basic_land(n) and n.lower() in by_name
              and not by_name[n.lower()].legal_commander]
    if banned:
        warnings.append(f"card(s) not legal in Commander (flagged, not blocked): {', '.join(sorted(set(banned)))}")

    illegal_commanders = [c for c in commanders
                          if c.lower() in by_name
                          and not is_legal_commander_card(by_name[c.lower()])]
    if illegal_commanders:
        warnings.append(
            f"REJECTED: not a legal commander (not a legendary creature, no commander text): "
            f"{', '.join(illegal_commanders)}"
        )
        return None, warnings

    commander_identity: set[str] = set()
    for c in commanders:
        info = by_name.get(c.lower())
        if info is not None:
            commander_identity |= set(info.color_identity)

    # Rulebreaker commanders each grant their own exemption from colour
    # identity, written in prose per card, so skip the check rather than parse
    # it. Kept in step with validate_deck.py and docs/js/validate.js.
    rulebreaker = any(
        "rulebreaker" in {k.lower() for k in (by_name[c.lower()].keywords or ())}
        for c in commanders
        if c.lower() in by_name
    )

    if rulebreaker:
        warnings.append(
            "colour identity not checked: commander has Rulebreaker"
        )
    else:
        out_of_identity = [
            n for n in unique_names
            if n.lower() in by_name
            and not set(by_name[n.lower()].color_identity).issubset(commander_identity)
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
        info = by_name.get(card_name.lower())

        # Store the name Scryfall actually knows, and keep what the submitter
        # wrote alongside it as "as". Secret Lair reskins are why: "Miku, Lost
        # but Singing" IS "Azusa, Lost but Seeking", and only the real name
        # resolves in a lookup -- but the pool should still show the Miku name.
        if info is not None and info.name != card_name:
            entry = {"n": info.name, "q": qty, "as": card_name}
            # A reskin is a specific printing with its own art, so pin the
            # printing: importing "Miku, the Renowned" should put the Miku
            # card on the table, not the default Feather art. Only a genuine
            # flavour name gets pinned -- a split card written by its front
            # face also lands here, and has no particular printing to prefer.
            if (info.flavor_name or "").lower() == card_name.lower() and info.scryfall_id:
                entry["id"] = info.scryfall_id
            cards_out.append(entry)
        else:
            cards_out.append({"n": card_name, "q": qty})

        if info is None:
            continue
        all_colors |= set(info.color_identity)
        if not is_basic_land(card_name):
            price_usd += (info.price_usd or 0.0) * qty
            price_eur += (info.price_eur or 0.0) * qty
            if info.is_game_changer:
                gc_count += 1

    computed_bracket = compute_bracket(gc_count)
    override = parsed["bracket_override"]
    if override.isdigit():
        bracket = int(override)
    else:
        bracket = computed_bracket

    record = {
        "slug": parsed["slug"],
        # Hash of the .txt this was built from. The next rebuild reuses this
        # record wholesale for as long as the file still hashes to the same
        # thing -- see main().
        "hash": parsed["hash"],
        "name": parsed["name"],
        "source": parsed["source"],
        "url": parsed["url"],
        "set": parsed["set"],
        "released": parsed["released"],
        "commanders": commanders,
        "cards": cards_out,
        "tags": parsed["tags"],
        "price_eur": round(price_eur, 2),
        "price_usd": round(price_usd, 2),
        "colors": colors_string(all_colors),
        "gc": gc_count,
        "bracket": bracket,
    }
    return record, warnings


# Fields the TTS device needs to list, filter and sort -- everything except
# the card lists, which are what make deck_db.json big.
INDEX_FIELDS = ("slug", "name", "commanders", "tags", "bracket",
                "colors", "price_eur", "price_usd", "gc")


def write_tts_files(tts_dir: str, db: dict, decks: list[dict]) -> None:
    """Split the database into a small index and one file per deck.

    TTS decodes JSON in Lua, which is slow enough that parsing the whole
    database at table load takes many seconds. The index is a fraction of the
    size, and a deck's cards are fetched only when that deck is imported.
    """
    os.makedirs(tts_dir, exist_ok=True)

    index = [{k: d[k] for k in INDEX_FIELDS} for d in decks]
    with open(os.path.join(tts_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(
            {"version": 1, "generated": db["generated"], "decks": index},
            f, separators=(",", ":"), ensure_ascii=False,
        )

    for d in decks:
        with open(os.path.join(tts_dir, f"{d['slug']}.json"), "w", encoding="utf-8") as f:
            json.dump(
                {"name": d["name"], "commanders": d["commanders"], "cards": d["cards"]},
                f, separators=(",", ":"), ensure_ascii=False,
            )

    # Drop files for decks that have since been deleted, so the folder can't
    # accumulate orphans the index no longer references.
    keep = {f"{d['slug']}.json" for d in decks} | {"index.json"}
    for fn in os.listdir(tts_dir):
        if fn.endswith(".json") and fn not in keep:
            os.remove(os.path.join(tts_dir, fn))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("decks_dir", nargs="?", default="decks", help="Folder of decklist .txt files")
    ap.add_argument("--out", default="deck_db.json", help="Output path for deck_db.json")
    ap.add_argument(
        "--tts-dir",
        help="Also write a slim browse index plus one card list per deck here. "
             "The TTS mod reads these instead of deck_db.json: it parses JSON "
             "in Lua, where the full database is slow to decode.",
    )
    ap.add_argument(
        "--full",
        action="store_true",
        help="Re-enrich every deck instead of reusing cached records for "
             "unchanged files. This is what refreshes prices pool-wide, so "
             "run it on a schedule; a one-deck submission does not need it.",
    )
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

    # Records from the previous build, keyed by slug. Each carries the hash of
    # the .txt it came from, so an unchanged file can be reused verbatim
    # instead of re-fetched. This is what stops a single-deck submission from
    # paying to re-enrich the entire pool -- the cost of adding a deck stays
    # flat as the pool grows.
    cache: dict[str, dict] = {}
    cached_gc_hash = ""
    build_id = builder_hash()
    if not args.full and os.path.exists(args.out):
        try:
            with open(args.out, encoding="utf-8") as f:
                previous = json.load(f)
            cached_gc_hash = previous.get("gc_hash", "")
            cache = {
                d["slug"]: d for d in previous.get("decks", [])
                if d.get("slug") and d.get("hash")
            }
            if cache and previous.get("builder") != build_id:
                print("Enrichment code has changed -- re-enriching every deck.", file=sys.stderr)
                cache = {}
        except (OSError, ValueError) as e:
            print(f"Could not reuse {args.out} ({e}) -- rebuilding everything.", file=sys.stderr)
            cache = {}

    parsed_decks = [parse_deck_file(p) for p in paths]

    print("Fetching current Game Changers list from Scryfall...", file=sys.stderr)
    game_changers = fetch_game_changers()
    print(f"  {len(game_changers)} Game Changers", file=sys.stderr)
    gc_hash = content_hash(",".join(sorted(game_changers)))

    # gc and the computed bracket are both derived from that list, so a
    # revision to it makes every cached record stale, not just changed files.
    if cache and cached_gc_hash and cached_gc_hash != gc_hash:
        print("Game Changers list has changed -- re-enriching every deck.", file=sys.stderr)
        cache = {}

    stale = [
        p for p in parsed_decks
        if p["reject"] is None and cache.get(p["slug"], {}).get("hash") != p["hash"]
    ]

    # One pooled lookup covering every stale deck at once, rather than a
    # separate round of calls per deck.
    by_name: dict = {}
    not_found_lower: set[str] = set()
    if stale:
        names = sorted({n for p in stale for n in lookup_names_for(p)})
        print(
            f"Looking up {len(names)} distinct cards for {len(stale)} changed deck(s)...",
            file=sys.stderr,
        )
        by_name, not_found = lookup_cards(names, game_changers=game_changers)
        not_found_lower = {n.lower() for n in not_found}
    else:
        print("No deck files changed -- reusing every cached record.", file=sys.stderr)

    decks = []
    rejected = 0
    reused = 0
    for p in parsed_decks:
        base = os.path.basename(p["path"])

        if p["reject"] is not None:
            for w in p["warnings"] + [p["reject"]]:
                print(f"[{base}] {w}", file=sys.stderr)
            rejected += 1
            continue

        cached = cache.get(p["slug"])
        if cached is not None and cached.get("hash") == p["hash"]:
            decks.append(cached)
            reused += 1
            continue

        record, warnings = enrich_deck(p, by_name, not_found_lower)
        for w in warnings:
            print(f"[{base}] {w}", file=sys.stderr)
        if record is None:
            rejected += 1
            continue
        decks.append(record)

    decks.sort(key=lambda d: d["name"].lower())

    db = {
        "version": 1,
        "generated": datetime.now(timezone.utc).date().isoformat(),
        "gc_hash": gc_hash,
        "builder": build_id,
        "enriched": True,
        "decks": decks,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(db, f, separators=(",", ":"), ensure_ascii=False)

    print(
        f"Wrote {len(decks)} decks to {args.out} "
        f"({reused} reused, {len(decks) - reused} enriched, {rejected} rejected)",
        file=sys.stderr,
    )

    if args.tts_dir:
        write_tts_files(args.tts_dir, db, decks)
        print(f"Wrote TTS index + {len(decks)} deck files to {args.tts_dir}", file=sys.stderr)


if __name__ == "__main__":
    main()
