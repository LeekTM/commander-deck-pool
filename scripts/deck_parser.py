"""
Parses a decklist .txt file (MTGGoldfish / Moxfield / Archidekt / EDHREC export
format, or the format the submission page produces) into a structured deck.

This module does no network calls -- it is pure text parsing, shared by
ingest_decks.py (building deck_db.json from decks/) and validate_deck.py
(checking a submission before it becomes a file).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

SECTION_HEADERS = {
    "commander": "commander",
    "deck": "deck",
    "mainboard": "deck",
    "main": "deck",
    "sideboard": "sideboard",
    "companion": "companion",
    "maybeboard": "maybeboard",
    "maybe board": "maybeboard",
    "tokens": "tokens",
}

# Sections whose cards do not count toward the 100-card deck.
EXCLUDED_SECTIONS = {"sideboard", "maybeboard", "tokens", "companion"}

METADATA_KEYS = {"name", "url", "commander", "companion", "bracket", "tags", "set", "released", "source"}

_METADATA_RE = re.compile(r"^//\s*([a-zA-Z ]+?)\s*:\s*(.*)$")
_SECTION_RE = re.compile(r"^([A-Za-z][A-Za-z ]*?)\s*:?\s*(?:\(\d+\))?\s*$")
_SB_PREFIX_RE = re.compile(r"^(SB|Sideboard)\s*:\s*", re.IGNORECASE)
# The "x" only counts as a multiplier when whitespace follows it, so
# "3 Xenagos, God of Revels" keeps its X. Whitespace after the count is
# optional, so a pasted "1Rograkh, Son of Rohgahh" is not silently dropped.
_CARD_LINE_RE = re.compile(r"^(\d+)\s*(?:[xX]\s+)?\s*(.+)$")
_CMDR_MARKER_RE = re.compile(r"\*\s*(CMDR|CMD|COMMANDER)\s*\*", re.IGNORECASE)
# Trailing set code / collector number, e.g. "(LTC) 285", "[M11]", "(M11) 123 *F*".
# Captured rather than merely stripped: with both halves present it names one
# exact printing, which is the only way to ask for a specific piece of art.
_SET_CRUFT_RE = re.compile(
    r"\s*[\(\[]([A-Za-z0-9]{2,6})[\)\]](?:\s*([A-Za-z0-9\-★]+))?(?:\s*\*F\*)?\s*$"
)


@dataclass
class ParsedCard:
    name: str
    quantity: int
    section: str  # "commander" | "deck" | "sideboard" | "companion" | "maybeboard" | "tokens"
    is_commander_marked: bool = False
    set_code: str | None = None
    collector_number: str | None = None


@dataclass
class ParsedDeck:
    metadata: dict = field(default_factory=dict)
    cards: list[ParsedCard] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def deck_cards(self) -> list[ParsedCard]:
        """Cards that count toward the 100 -- excludes sideboard/maybe/tokens/companion."""
        return [c for c in self.cards if c.section not in EXCLUDED_SECTIONS]

    def commander_names(self) -> list[str]:
        names = []
        for c in self.cards:
            if c.section == "commander" or c.is_commander_marked:
                if c.name not in names:
                    names.append(c.name)
        meta_cmdr = self.metadata.get("commander", "")
        for n in [x.strip() for x in meta_cmdr.split(",") if x.strip()]:
            if n not in names:
                names.append(n)
        return names

    def companion_name(self) -> str | None:
        """The deck's companion, if it declared one -- otherwise None.

        A companion is the 101st card: it lives outside the 100, which is why
        its section is excluded from deck_cards() and it has to be read back
        here instead. Only ever one is legal, so a second is ignored. Written
        either as a `Companion` section or `// companion: <name>`.
        """
        for c in self.cards:
            if c.section == "companion":
                return c.name
        return self.metadata.get("companion", "").strip() or None


def _split_printing(text: str) -> tuple[str, str | None, str | None]:
    """Split "Rick, Steadfast Leader (SLD) 143" into name, set code, number.

    Only the innermost trailing group names a printing; anything further out is
    stripped as cruft. Both halves are needed -- a bare "(M11)" identifies a set
    but not a card.
    """
    set_code = collector = None
    prev = None
    while prev != text:
        prev = text
        m = _SET_CRUFT_RE.search(text)
        if not m:
            break
        if set_code is None and m.group(2):
            set_code, collector = m.group(1), m.group(2)
        text = text[:m.start()].strip()
    return text, set_code, collector


def parse_decklist_text(text: str) -> ParsedDeck:
    deck = ParsedDeck()
    current_section = "deck"

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        meta_match = _METADATA_RE.match(line)
        if meta_match:
            key = meta_match.group(1).strip().lower()
            value = meta_match.group(2).strip()
            if key in METADATA_KEYS:
                deck.metadata[key] = value
            continue

        if line.startswith("//"):
            continue  # plain comment, ignore

        section_override = None
        sb_match = _SB_PREFIX_RE.match(line)
        if sb_match:
            section_override = "sideboard"
            line = line[sb_match.end():].strip()

        header_match = _SECTION_RE.match(line)
        if header_match and not _CARD_LINE_RE.match(line):
            candidate = header_match.group(1).strip().lower()
            if candidate in SECTION_HEADERS:
                current_section = SECTION_HEADERS[candidate]
                continue

        card_match = _CARD_LINE_RE.match(line)
        if not card_match:
            deck.warnings.append(f"Could not parse line: {raw_line!r}")
            continue

        quantity = int(card_match.group(1))
        rest = card_match.group(2).strip()

        is_commander_marked = bool(_CMDR_MARKER_RE.search(rest))
        rest = _CMDR_MARKER_RE.sub("", rest).strip()
        rest, set_code, collector_number = _split_printing(rest)
        name = rest.strip()
        if not name:
            deck.warnings.append(f"Could not extract card name: {raw_line!r}")
            continue

        section = section_override or current_section
        deck.cards.append(ParsedCard(
            name=name,
            quantity=quantity,
            set_code=set_code,
            collector_number=collector_number,
            section=section,
            is_commander_marked=is_commander_marked,
        ))

    return deck


def aggregate_quantities(cards: list[ParsedCard]) -> dict[str, int]:
    """Sum quantities for identically-named cards within a list."""
    totals: dict[str, int] = {}
    for c in cards:
        totals[c.name] = totals.get(c.name, 0) + c.quantity
    return totals
