// Shared Scryfall access for the browser pages. Mirrors scripts/scryfall.py --
// keep the two in sync. See https://scryfall.com/docs/api for rate-limit
// guidance: stay near 10 req/s, so we sleep ~100ms between batched calls.

const SCRYFALL = {
  API_BASE: "https://api.scryfall.com",
  BATCH_SIZE: 75,
  DELAY_MS: 100,
  COLOR_ORDER: "WUBRG",
  BASIC_LANDS: new Set([
    "plains", "island", "swamp", "mountain", "forest", "wastes",
    "snow-covered plains", "snow-covered island", "snow-covered swamp",
    "snow-covered mountain", "snow-covered forest", "snow-covered wastes",
  ]),
};

function isBasicLand(name) {
  return SCRYFALL.BASIC_LANDS.has(name.trim().toLowerCase());
}

function colorsString(colorSet) {
  return [...SCRYFALL.COLOR_ORDER].filter((c) => colorSet.has(c)).join("");
}

function computeBracket(gameChangerCount) {
  if (gameChangerCount >= 4) return 4;
  if (gameChangerCount >= 1) return 3;
  return 2;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Live-fetches the current Game Changers list. Never hardcode it. */
async function fetchGameChangers() {
  const names = new Set();
  let url = `${SCRYFALL.API_BASE}/cards/search?q=is%3Agamechanger&unique=cards`;
  while (url) {
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) {
      if (resp.status === 404) break;
      throw new Error(`Scryfall search failed: ${resp.status}`);
    }
    const data = await resp.json();
    for (const card of data.data || []) names.add(card.name.toLowerCase());
    url = data.has_more ? data.next_page : null;
    if (url) await sleep(SCRYFALL.DELAY_MS);
  }
  return names;
}

function cardToInfo(card, gameChangers) {
  let colorIdentity = card.color_identity || [];
  let typeLine = card.type_line || "";
  let oracleText = card.oracle_text || "";
  let frontFaceName = null;

  if (card.card_faces && card.card_faces.length) {
    frontFaceName = card.card_faces[0].name;
    if (!oracleText) {
      oracleText = card.card_faces.map((f) => f.oracle_text || "").join(" // ");
    }
    if (!typeLine) typeLine = card.card_faces[0].type_line || "";
  }

  // Transform/MDFC cards carry no top-level image_uris -- each face has its
  // own -- so fall back to the front face. "grid" is the WebP equivalent of
  // "normal" (same 488x680, roughly half the bytes); "normal" is the JPG
  // fallback if a card somehow lacks the WebP variant.
  const faceImages = (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris) || {};
  const images = card.image_uris || faceImages;
  const imageUrl = images.grid || images.normal || images.large || null;
  const thumbUrl = images.thumb || images.small || imageUrl;
  // Bigger still, for the hover/tap pop-out where the rules text has to be
  // readable: "display" is the WebP equivalent of "large" (672x936, ~50KB).
  const largeUrl = images.display || images.large || images.png || imageUrl;

  const prices = card.prices || {};
  const toPrice = (v) => (v === null || v === undefined || v === "" ? null : parseFloat(v));

  return {
    name: card.name,
    imageUrl,
    thumbUrl,
    largeUrl,
    priceUsd: toPrice(prices.usd),
    priceEur: toPrice(prices.eur),
    colorIdentity,
    keywords: card.keywords || [],
    legalCommander: (card.legalities || {}).commander === "legal",
    typeLine,
    oracleText: oracleText || "",
    games: card.games || [],
    edhrecRank: card.edhrec_rank ?? null,
    isGameChanger: gameChangers.has(card.name.toLowerCase()),
    frontFaceName,
  };
}

function isLegalCommanderCard(info) {
  const tl = info.typeLine.toLowerCase();
  if (tl.includes("legendary") && tl.includes("creature")) return true;
  // Backgrounds are "Legendary Enchantment - Background" and carry no text
  // granting commander status -- the permission comes from the "Choose a
  // Background" creature they pair with, so the subtype is the only signal.
  if (tl.includes("background")) return true;
  return info.oracleText.toLowerCase().includes("can be your commander");
}

/**
 * Looks up a batch of card names via /cards/collection.
 * Returns { byName: Map<lowercaseName, CardInfo>, notFound: string[] }.
 * Split/MDFC cards are queried by front face (Scryfall's collection endpoint
 * doesn't reliably match the combined "Front // Back" form) and indexed under
 * both the full name and the front face name in the result.
 */
async function lookupCards(names, gameChangers) {
  const uniqueNames = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort();
  const byName = new Map();
  const notFound = [];

  const queryName = (n) => (n.includes(" // ") ? n.split(" // ")[0] : n);

  for (let i = 0; i < uniqueNames.length; i += SCRYFALL.BATCH_SIZE) {
    const batch = uniqueNames.slice(i, i + SCRYFALL.BATCH_SIZE);
    const originalByQuery = new Map(batch.map((n) => [queryName(n).toLowerCase(), n]));
    const resp = await fetch(`${SCRYFALL.API_BASE}/cards/collection`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ identifiers: batch.map((n) => ({ name: queryName(n) })) }),
    });
    if (!resp.ok) throw new Error(`Scryfall collection lookup failed: ${resp.status}`);
    const result = await resp.json();

    for (const card of result.data || []) {
      const info = cardToInfo(card, gameChangers);
      byName.set(info.name.toLowerCase(), info);
      if (info.frontFaceName && !byName.has(info.frontFaceName.toLowerCase())) {
        byName.set(info.frontFaceName.toLowerCase(), info);
      }
    }
    for (const miss of result.not_found || []) {
      const queried = (miss.name || "?").toLowerCase();
      notFound.push(originalByQuery.get(queried) || miss.name);
    }

    if (i + SCRYFALL.BATCH_SIZE < uniqueNames.length) await sleep(SCRYFALL.DELAY_MS);
  }

  // Secret Lair reskins are printed with a flavour name over a real card:
  // "Miku, Lost but Singing" IS "Azusa, Lost but Seeking". /cards/collection
  // matches the real name only, so retry the leftovers one at a time against
  // /cards/named?exact=, which does match a flavour name. Deliberately exact
  // rather than fuzzy: a genuine typo still 404s instead of being silently
  // resolved to whatever card it happens to resemble.
  const stillMissing = [];
  for (const name of notFound) {
    const resp = await fetch(
      `${SCRYFALL.API_BASE}/cards/named?exact=${encodeURIComponent(name)}`,
      { headers: { Accept: "application/json" } }
    );
    if (!resp.ok) {
      stillMissing.push(name);
      await sleep(SCRYFALL.DELAY_MS);
      continue;
    }
    const info = cardToInfo(await resp.json(), gameChangers);
    // The flavour name is what this lookup was for, so it maps to the reskin
    // printing outright. The real card underneath must not clobber an entry
    // the batch above already resolved -- a reskin is one specific printing
    // (Secret Lair Azusa) and the ordinary card keeps its own price. This page
    // validates a single deck, which cannot legally hold both (Miku IS Azusa,
    // and Commander is singleton), but it stays in step with
    // scripts/scryfall.py, where pooled lookups make it load-bearing.
    byName.set(name.toLowerCase(), info);
    if (!byName.has(info.name.toLowerCase())) byName.set(info.name.toLowerCase(), info);
    if (info.frontFaceName && !byName.has(info.frontFaceName.toLowerCase())) {
      byName.set(info.frontFaceName.toLowerCase(), info);
    }
    await sleep(SCRYFALL.DELAY_MS);
  }

  return { byName, notFound: stillMissing };
}
