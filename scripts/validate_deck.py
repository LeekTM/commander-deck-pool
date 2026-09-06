"""
Validates a decklist against Scryfall. This is the server-side (Python) twin
of the checks docs/submit.js runs in the browser -- used by the issue-to-deck
workflow and by CI when a pull request touches decks/. Keep the two rule sets
in sync; see docs/js/validate.js for the JS version.

Usage:
    python validate_deck.py path/to/deck.txt
    python validate_deck.py --stdin < deck.txt

Exit code 0 = passes all blocking checks (warnings may still be printed).
Exit code 1 = blocked; blocking errors are printed and, with --json, returned
              as structured data for the calling workflow.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # allow running from anywhere

from deck_parser import parse_decklist_text, aggregate_quantities
from scryfall import (
    lookup_cards, fetch_game_changers, is_basic_land, is_legal_commander_card,
    is_companion_card, colors_string, compute_bracket,
)


@dataclass
class ValidationResult:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    banned_cards: list[str] = field(default_factory=list)
    commanders: list[str] = field(default_factory=list)
    companion: str | None = None
    total_cards: int = 0
    price_usd: float = 0.0
    price_eur: float = 0.0
    colors: str = ""
    game_changer_count: int = 0
    bracket: int = 2
    bracket_overridden: bool = False

    @property
    def ok(self) -> bool:
        return not self.errors


def validate_parsed(deck, game_changers: set[str] | None = None) -> ValidationResult:
    result = ValidationResult()
    deck_cards = deck.deck_cards()
    quantities = aggregate_quantities(deck_cards)
    unique_names = list(quantities.keys())

    result.total_cards = sum(quantities.values())
    if result.total_cards != 100:
        result.warnings.append(
            f"Deck has {result.total_cards} cards, not the expected 100."
        )

    commanders = deck.commander_names()
    if not commanders:
        result.errors.append("No commander detected. Mark it in a Commander section, "
                              "with *CMDR*, or add '// commander: <name>'.")
        return result
    result.commanders = commanders

    # The companion is optional and almost always absent; when there is none,
    # nothing about this lookup or the checks below changes.
    companion = deck.companion_name()
    by_name, not_found = lookup_cards(
        unique_names + commanders + ([companion] if companion else []),
        game_changers=game_changers,
    )

    if not_found:
        result.errors.append(
            "Card name(s) not recognised by Scryfall: " + ", ".join(sorted(set(not_found)))
        )

    banned = []
    for name in unique_names:
        info = by_name.get(name.lower())
        if info is None:
            continue  # already reported as not_found
        if not is_basic_land(name) and not info.legal_commander:
            banned.append(name)
    if banned:
        # Flagged, not blocked -- deliberately not an error, so the group can
        # playtest cards not yet (or no longer) legal in Commander. Exposed
        # separately from `warnings` too, so a caller can require an explicit
        # bypass for this specific case rather than just noting it in passing.
        result.banned_cards = sorted(set(banned))
        result.warnings.append(
            "Card(s) not legal in Commander (flagged, not blocked): " + ", ".join(result.banned_cards)
        )

    for cmdr_name in commanders:
        info = by_name.get(cmdr_name.lower())
        if info is None:
            continue  # already reported as not_found
        if not is_legal_commander_card(info):
            result.errors.append(
                f"'{cmdr_name}' is not a legendary creature and has no text "
                f"granting commander status."
            )

    commander_identity: set[str] = set()
    for cmdr_name in commanders:
        info = by_name.get(cmdr_name.lower())
        if info:
            commander_identity |= set(info.color_identity)

    # Rulebreaker commanders each carve out their own exemption from colour
    # identity ("Angel cards of any color identity", "artifact creature and
    # Equipment cards of any color identity", and so on). The exemption is
    # written in prose per card, so rather than parse it, skip the check and
    # say so -- a false block is worse here than an unchecked deck.
    rulebreaker = any(
        "rulebreaker" in {k.lower() for k in (info.keywords or ())}
        for info in (by_name.get(c.lower()) for c in commanders)
        if info is not None
    )

    if rulebreaker:
        result.warnings.append(
            "Colour identity not checked: this commander has Rulebreaker, "
            "which lets the deck include cards outside its identity."
        )
    elif commander_identity:
        out_of_identity = []
        for name in unique_names:
            info = by_name.get(name.lower())
            if info is None:
                continue
            card_colors = set(info.color_identity)
            if not card_colors.issubset(commander_identity):
                out_of_identity.append(name)
        if out_of_identity:
            result.errors.append(
                "Card(s) outside the commander's colour identity: "
                + ", ".join(sorted(set(out_of_identity)))
            )

    price_usd = 0.0
    price_eur = 0.0
    all_colors: set[str] = set()
    gc_count = 0
    for name, qty in quantities.items():
        info = by_name.get(name.lower())
        if info is None:
            continue
        if not is_basic_land(name):
            price_usd += (info.price_usd or 0.0) * qty
            price_eur += (info.price_eur or 0.0) * qty
            if info.is_game_changer:
                gc_count += 1
        all_colors |= set(info.color_identity)

    # The companion is the 101st card: outside the 100, so it is checked and
    # priced here rather than in the loop above. You have to own it to play it,
    # so it counts toward the price.
    if companion:
        info = by_name.get(companion.lower())
        if info is None:
            result.warnings.append(f"Companion '{companion}' was not recognised.")
        else:
            result.companion = info.name
            if not is_companion_card(info):
                result.warnings.append(
                    f"'{companion}' has no companion ability (flagged, not blocked)."
                )
            if (not rulebreaker and commander_identity
                    and not set(info.color_identity).issubset(commander_identity)):
                result.errors.append(
                    f"Companion '{companion}' is outside the commander's colour identity."
                )
            price_usd += info.price_usd or 0.0
            price_eur += info.price_eur or 0.0

    result.price_usd = round(price_usd, 2)
    result.price_eur = round(price_eur, 2)
    result.colors = colors_string(all_colors)
    result.game_changer_count = gc_count

    computed_bracket = compute_bracket(gc_count)
    override = deck.metadata.get("bracket", "").strip()
    if override.isdigit():
        result.bracket = int(override)
        result.bracket_overridden = True
    else:
        result.bracket = computed_bracket

    return result


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", help="Path to a decklist .txt file")
    ap.add_argument("--stdin", action="store_true", help="Read decklist from stdin")
    ap.add_argument("--json", action="store_true", help="Print result as JSON")
    args = ap.parse_args()

    if args.stdin:
        text = sys.stdin.read()
    elif args.path:
        with open(args.path, encoding="utf-8") as f:
            text = f.read()
    else:
        ap.error("Provide a path or --stdin")
        return

    deck = parse_decklist_text(text)
    result = validate_parsed(deck)

    if args.json:
        print(json.dumps({
            "ok": result.ok,
            "errors": result.errors,
            "warnings": result.warnings,
            "banned_cards": result.banned_cards,
            "commanders": result.commanders,
            "companion": result.companion,
            "total_cards": result.total_cards,
            "price_usd": result.price_usd,
            "price_eur": result.price_eur,
            "colors": result.colors,
            "game_changer_count": result.game_changer_count,
            "bracket": result.bracket,
            "bracket_overridden": result.bracket_overridden,
        }, indent=2))
    else:
        for w in deck.warnings:
            print(f"PARSE WARNING: {w}")
        for w in result.warnings:
            print(f"WARNING: {w}")
        for e in result.errors:
            print(f"ERROR: {e}")
        if result.ok:
            print(f"OK: {', '.join(result.commanders)} | {result.total_cards} cards | "
                  f"{('companion ' + result.companion + ' | ') if result.companion else ''}"
                  f"{result.colors or 'C'} | GC={result.game_changer_count} | "
                  f"bracket={result.bracket}{' (override)' if result.bracket_overridden else ''} | "
                  f"€{result.price_eur} / ${result.price_usd}")

    sys.exit(0 if result.ok else 1)


if __name__ == "__main__":
    main()
