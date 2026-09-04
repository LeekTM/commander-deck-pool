"""
Shared Scryfall access for the deck pool.

Every card-data need (prices, colour identity, legality, commander-eligibility,
game-changer status) goes through this module. Keep it that way: when the pool
grows past ~1000 decks the brief calls for switching to a single bulk-data
download instead of batched /cards/collection calls, and that swap should only
touch this file.

Scryfall API etiquette (see https://scryfall.com/docs/api):
- send a distinctive User-Agent and Accept: application/json
- keep requests to roughly 10/second -> we sleep ~100ms between calls
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

API_BASE = "https://api.scryfall.com"
USER_AGENT = "MTGCommanderDeckPool/1.0 (+github community project)"
REQUEST_DELAY_SECONDS = 0.1
COLLECTION_BATCH_SIZE = 75

BASIC_LAND_NAMES = {
    "plains", "island", "swamp", "mountain", "forest", "wastes",
    "snow-covered plains", "snow-covered island", "snow-covered swamp",
    "snow-covered mountain", "snow-covered forest", "snow-covered wastes",
}

COLOR_ORDER = "WUBRG"


def is_basic_land(name: str) -> bool:
    return name.strip().lower() in BASIC_LAND_NAMES


@dataclass
class CardInfo:
    name: str
    price_usd: float | None
    price_eur: float | None
    color_identity: list[str]
    legal_commander: bool  # legalities.commander == "legal"
    type_line: str
    oracle_text: str
    games: list[str]
    edhrec_rank: int | None
    is_game_changer: bool
    front_face_name: str | None = None  # for split/MDFC cards


def _request_json(url: str, data: bytes | None = None) -> dict:
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_game_changers() -> set[str]:
    """Live-fetch the current Game Changers list (lowercased names).

    Never hardcode this list -- WotC/Scryfall revise it every few months.
    """
    names: set[str] = set()
    url = f"{API_BASE}/cards/search?q=is%3Agamechanger&unique=cards"
    while url:
        try:
            data = _request_json(url)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                break
            raise
        for card in data.get("data", []):
            names.add(card["name"].lower())
        url = data.get("next_page") if data.get("has_more") else None
        if url:
            time.sleep(REQUEST_DELAY_SECONDS)
    return names


def _card_to_info(card: dict, game_changers: set[str]) -> CardInfo:
    name = card["name"]
    front_face_name = None
    color_identity = card.get("color_identity", [])
    type_line = card.get("type_line", "")
    oracle_text = card.get("oracle_text", "")

    faces = card.get("card_faces")
    if faces:
        front_face_name = faces[0].get("name")
        if not oracle_text:
            oracle_text = " // ".join(f.get("oracle_text", "") for f in faces)
        if not type_line:
            type_line = faces[0].get("type_line", "")

    prices = card.get("prices", {}) or {}

    def _price(v):
        return float(v) if v not in (None, "") else None

    return CardInfo(
        name=name,
        price_usd=_price(prices.get("usd")),
        price_eur=_price(prices.get("eur")),
        color_identity=color_identity,
        legal_commander=card.get("legalities", {}).get("commander") == "legal",
        type_line=type_line,
        oracle_text=oracle_text or "",
        games=card.get("games", []),
        edhrec_rank=card.get("edhrec_rank"),
        is_game_changer=name.lower() in game_changers,
        front_face_name=front_face_name,
    )


def lookup_cards(names: list[str], game_changers: set[str] | None = None) -> tuple[dict[str, CardInfo], list[str]]:
    """Look up a batch of card names via /cards/collection.

    Returns (by_lower_name, not_found_names). Front faces of split/MDFC cards
    are indexed under their own lowercased name too, so a lookup by the front
    face alone still hits.
    """
    if game_changers is None:
        game_changers = fetch_game_changers()

    unique_names = sorted({n.strip() for n in names if n.strip()})
    by_name: dict[str, CardInfo] = {}
    not_found: list[str] = []

    # Scryfall's /cards/collection name-identifier match is unreliable against
    # the combined "Front // Back" form for split/split-adventure/MDFC cards,
    # but matches reliably on the front face alone -- and returns the full
    # card (with the combined name) either way. So query by front face only;
    # _card_to_info's caller indexes the result under both the full name and
    # the front face name, which covers a decklist line written either way.
    def query_name(n: str) -> str:
        return n.split(" // ", 1)[0] if " // " in n else n

    for i in range(0, len(unique_names), COLLECTION_BATCH_SIZE):
        batch = unique_names[i:i + COLLECTION_BATCH_SIZE]
        original_by_query = {query_name(n).lower(): n for n in batch}
        payload = json.dumps({"identifiers": [{"name": query_name(n)} for n in batch]}).encode("utf-8")
        result = _request_json(f"{API_BASE}/cards/collection", data=payload)
        for card in result.get("data", []):
            info = _card_to_info(card, game_changers)
            by_name[info.name.lower()] = info
            if info.front_face_name:
                by_name.setdefault(info.front_face_name.lower(), info)
        for miss in result.get("not_found", []):
            queried = miss.get("name", "?")
            not_found.append(original_by_query.get(queried.lower(), queried))
        if i + COLLECTION_BATCH_SIZE < len(unique_names):
            time.sleep(REQUEST_DELAY_SECONDS)

    return by_name, not_found


def is_legal_commander_card(info: CardInfo) -> bool:
    """Legendary creature, or oracle text explicitly granting commander status."""
    tl = info.type_line.lower()
    if "legendary" in tl and "creature" in tl:
        return True
    ot = info.oracle_text.lower()
    return "can be your commander" in ot


def colors_string(color_identity_letters: set[str]) -> str:
    return "".join(c for c in COLOR_ORDER if c in color_identity_letters)


def compute_bracket(game_changer_count: int) -> int:
    if game_changer_count >= 4:
        return 4
    if game_changer_count >= 1:
        return 3
    return 2
