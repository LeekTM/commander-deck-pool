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
import urllib.parse
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
    scryfall_id: str = ""
    # Set only on a reskin printing (Secret Lair): the name on the physical
    # card, where `name` is the card it actually is.
    flavor_name: str | None = None
    keywords: tuple[str, ...] = ()


# Scryfall occasionally rate-limits or 5xxs under load. Without a retry a
# single blip aborts the whole pool rebuild, so a transient failure is worth
# a few backed-off attempts. 404 is deliberately not retried -- it is how
# search pagination signals "no more pages".
_RETRY_STATUSES = {429, 500, 502, 503, 504}
_MAX_ATTEMPTS = 4


def _request_json(url: str, data: bytes | None = None) -> dict:
    last_error: Exception | None = None

    for attempt in range(_MAX_ATTEMPTS):
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
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code not in _RETRY_STATUSES:
                raise
            last_error = e
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_error = e

        if attempt < _MAX_ATTEMPTS - 1:
            time.sleep(REQUEST_DELAY_SECONDS * (2 ** attempt))

    raise last_error  # type: ignore[misc]


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
        scryfall_id=card.get("id", ""),
        flavor_name=card.get("flavor_name"),
        price_usd=_price(prices.get("usd")),
        price_eur=_price(prices.get("eur")),
        color_identity=color_identity,
        keywords=tuple(card.get("keywords") or ()),
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

        # Scryfall should account for every identifier in either data or
        # not_found. When a response comes back short it does neither, and the
        # name then exists in no map at all -- callers indexing by_name[...]
        # blow up with a KeyError far from the cause. Treat anything
        # unaccounted for as not found, which callers already handle.
        for n in batch:
            if n.lower() not in by_name and n not in not_found:
                not_found.append(n)

        if i + COLLECTION_BATCH_SIZE < len(unique_names):
            time.sleep(REQUEST_DELAY_SECONDS)

    # Secret Lair reskins are printed with a flavour name over a real card:
    # "Miku, Lost but Singing" IS "Azusa, Lost but Seeking". /cards/collection
    # matches the real name only, so retry the leftovers one at a time against
    # /cards/named?exact=, which does match a flavour name. Deliberately exact
    # rather than fuzzy: a genuine typo still 404s instead of being silently
    # resolved to whatever card it happens to resemble.
    if not_found:
        still_missing = []
        for name in not_found:
            try:
                card = _request_json(
                    f"{API_BASE}/cards/named?exact={urllib.parse.quote(name)}"
                )
            except urllib.error.HTTPError:
                still_missing.append(name)
                time.sleep(REQUEST_DELAY_SECONDS)
                continue

            info = _card_to_info(card, game_changers)
            # The flavour name is what this lookup was for, so it maps to the
            # reskin printing outright.
            by_name[name.lower()] = info
            # The real card underneath does NOT get clobbered if the batch
            # above already resolved it. A reskin is one specific printing
            # (Secret Lair Azusa, EUR 20.88); a deck running the ordinary card
            # must keep the ordinary printing's price (EUR 8.51). Only fill the
            # real name in when nothing else has, so the reskin still resolves
            # when it is the only way this card was asked for.
            by_name.setdefault(info.name.lower(), info)
            if info.front_face_name:
                by_name.setdefault(info.front_face_name.lower(), info)
            time.sleep(REQUEST_DELAY_SECONDS)
        not_found = still_missing

    return by_name, not_found


def is_legal_commander_card(info: CardInfo) -> bool:
    """Legendary creature, a Background, or text granting commander status."""
    tl = info.type_line.lower()
    if "legendary" in tl and "creature" in tl:
        return True
    # Backgrounds are "Legendary Enchantment - Background" and carry no text
    # granting commander status -- the permission comes from the "Choose a
    # Background" creature they pair with, so the subtype is the only signal.
    if "background" in tl:
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
