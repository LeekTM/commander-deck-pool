// Loads deck_db.json and renders a filterable pool. Also doubles as the best
// test that the database is well-formed, per the brief.

let ALL_DECKS = [];
let RENDERED_DECKS = []; // the currently-filtered subset, indexed by data-i

// deck_db.json deliberately stores only name + quantity per card, so card
// types are fetched from Scryfall the first time a deck is expanded and
// cached here (lowercase name -> group) for the rest of the session. Keeps
// the data contract the TTS mod reads untouched.
const TYPE_CACHE = new Map();

// Display order. Creatures are never subdivided by creature subtype -- that
// would shatter a tribal deck into dozens of one-card groups -- but the
// artifact/enchantment subtypes that actually matter in play get their own.
const TYPE_GROUP_ORDER = [
  "Commander", "Creatures", "Planeswalkers", "Instants", "Sorceries",
  "Artifacts", "Equipment", "Enchantments", "Auras", "Sagas", "Vehicles",
  "Battles", "Lands", "Other",
];

function typeGroupFor(typeLine) {
  // Split/MDFC cards group by their front face ("Sorcery // Land" -> Sorcery).
  const front = String(typeLine || "").split(" // ")[0].toLowerCase();
  // Subtype breakouts first, so "Artifact - Equipment" lands in Equipment
  // rather than the generic Artifacts bucket.
  if (front.includes("equipment")) return "Equipment";
  if (front.includes("aura")) return "Auras";
  if (front.includes("vehicle")) return "Vehicles";
  if (front.includes("saga")) return "Sagas";
  if (front.includes("creature")) return "Creatures";
  if (front.includes("planeswalker")) return "Planeswalkers";
  if (front.includes("land")) return "Lands";
  if (front.includes("instant")) return "Instants";
  if (front.includes("sorcery")) return "Sorceries";
  if (front.includes("battle")) return "Battles";
  if (front.includes("artifact")) return "Artifacts";
  if (front.includes("enchantment")) return "Enchantments";
  return "Other";
}

function allTypesKnown(deck) {
  return deck.cards.every((c) => TYPE_CACHE.has(c.n.toLowerCase()));
}

async function ensureTypesFor(deck) {
  const missing = deck.cards
    .map((c) => c.n)
    .filter((n) => !TYPE_CACHE.has(n.toLowerCase()));
  if (missing.length === 0) return;
  // An empty Game Changers set is fine -- deck.gc already comes from
  // deck_db.json, so there's no need to spend a request fetching that list.
  const { byName } = await lookupCards(missing, new Set());
  for (const name of missing) {
    const info = byName.get(name.toLowerCase());
    TYPE_CACHE.set(name.toLowerCase(), info ? typeGroupFor(info.typeLine) : "Other");
  }
}

function groupedCardsHtml(deck) {
  const commanders = new Set((deck.commanders || []).map((c) => c.toLowerCase()));
  const groups = new Map();

  for (const card of deck.cards) {
    const key = card.n.toLowerCase();
    const group = commanders.has(key) ? "Commander" : (TYPE_CACHE.get(key) || "Other");
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(card);
  }

  return TYPE_GROUP_ORDER
    .filter((g) => groups.has(g))
    .map((g) => {
      const cards = groups.get(g).sort((a, b) => a.n.localeCompare(b.n));
      const count = cards.reduce((sum, c) => sum + c.q, 0);
      const items = cards.map((c) => `<div>${c.q}&times; ${escapeHtml(c.n)}</div>`).join("");
      return `<div class="card-group"><h4>${g} (${count})</h4>${items}</div>`;
    })
    .join("");
}

function flatCardsHtml(deck) {
  return deck.cards
    .slice()
    .sort((a, b) => a.n.localeCompare(b.n))
    .map((c) => `<div>${c.q}&times; ${escapeHtml(c.n)}</div>`)
    .join("");
}

async function loadDeckDb() {
  // Production (GitHub Pages serving docs/ as root): the build workflow
  // mirrors deck_db.json into docs/. Local dev (serving the repo root):
  // fall back to the root copy.
  for (const path of ["deck_db.json", "../deck_db.json"]) {
    try {
      const resp = await fetch(path, { cache: "no-store" });
      if (resp.ok) return await resp.json();
    } catch (e) {
      // try next path
    }
  }
  throw new Error("Could not load deck_db.json from docs/ or the repo root.");
}

function colorPills(colors) {
  if (!colors) return '<span class="pill">Colourless</span>';
  return [...colors]
    .map((c) => `<span class="pill mana-${c}">${c}</span>`)
    .join("");
}

function deckMatchesFilters(deck, filters) {
  if (filters.bracket && String(deck.bracket) !== filters.bracket) return false;
  if (filters.maxPrice !== null && deck.price_eur > filters.maxPrice) return false;
  if (filters.colors) {
    for (const c of filters.colors) {
      if (!deck.colors.includes(c)) return false;
    }
  }
  if (filters.search) {
    const haystack = [
      deck.name,
      ...(deck.commanders || []),
      ...(deck.tags || []),
    ].join(" ").toLowerCase();
    if (!haystack.includes(filters.search)) return false;
  }
  return true;
}

function renderDecks(decks) {
  const container = document.getElementById("decks");
  document.getElementById("result-count").textContent =
    `${decks.length} deck${decks.length === 1 ? "" : "s"}`;

  if (decks.length === 0) {
    container.innerHTML = '<p class="hint">No decks match those filters.</p>';
    return;
  }

  container.innerHTML = decks.map((deck, i) => {
    // Group straight away if every card's type is already cached (a deck
    // opened earlier this session, or one sharing cards with it); otherwise
    // render flat now and regroup on first expand, so the list is never
    // blocked on a network call.
    const grouped = allTypesKnown(deck);
    const cardsHtml = grouped ? groupedCardsHtml(deck) : flatCardsHtml(deck);
    const tagsHtml = (deck.tags || []).map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join("");

    return `
      <details class="deck-row" data-i="${i}" data-grouped="${grouped ? "1" : "0"}">
        <summary>
          <span class="name">${escapeHtml(deck.name)}</span>
          ${colorPills(deck.colors)}
          <span class="pill">Bracket ${deck.bracket}</span>
          <span class="pill">GC ${deck.gc}</span>
          <span class="pill">€${deck.price_eur.toFixed(2)} / $${deck.price_usd.toFixed(2)}</span>
        </summary>
        <p class="hint">
          Commander: ${escapeHtml((deck.commanders || []).join(" + "))}
          ${deck.url ? ` · <a href="${escapeHtml(deck.url)}" target="_blank" rel="noopener">source</a>` : ""}
          ${deck.source ? ` · ${escapeHtml(deck.source)}` : ""}
        </p>
        <div>${tagsHtml}</div>
        <div class="deck-cardlist">${cardsHtml}</div>
      </details>
    `;
  }).join("");

  RENDERED_DECKS = decks;
  container.querySelectorAll("details.deck-row").forEach((el) => {
    el.addEventListener("toggle", () => onDeckToggle(el));
  });
}

async function onDeckToggle(el) {
  if (!el.open || el.dataset.grouped === "1" || el.dataset.loading === "1") return;
  const deck = RENDERED_DECKS[Number(el.dataset.i)];
  if (!deck) return;

  const listEl = el.querySelector(".deck-cardlist");
  el.dataset.loading = "1";
  const previous = listEl.innerHTML;
  listEl.innerHTML = '<p class="hint">Grouping by card type...</p>';

  try {
    await ensureTypesFor(deck);
    listEl.innerHTML = groupedCardsHtml(deck);
    el.dataset.grouped = "1";
  } catch (e) {
    // Scryfall unreachable or rate-limited -- the flat list is still useful,
    // so fall back to it rather than leaving the deck unreadable.
    listEl.innerHTML = previous;
  } finally {
    delete el.dataset.loading;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function readFilters() {
  const search = document.getElementById("f-search").value.trim().toLowerCase();
  const bracket = document.getElementById("f-bracket").value;
  const priceRaw = document.getElementById("f-price").value.trim();
  const maxPrice = priceRaw ? parseFloat(priceRaw) : null;
  const colors = document.getElementById("f-colors").value.trim().toUpperCase().replace(/[^WUBRG]/g, "");
  return { search, bracket, maxPrice: Number.isFinite(maxPrice) ? maxPrice : null, colors };
}

function applyFilters() {
  const filters = readFilters();
  const filtered = ALL_DECKS.filter((d) => deckMatchesFilters(d, filters));
  filtered.sort((a, b) => a.name.localeCompare(b.name));
  renderDecks(filtered);
}

function wireRepoLinks() {
  if (typeof REPO === "undefined" || REPO === "OWNER/REPO") return;
  const ingest = document.getElementById("link-ingest");
  const decks = document.getElementById("link-decks");
  if (ingest) ingest.href = `https://github.com/${REPO}/blob/main/ingest_decks.py`;
  if (decks) decks.href = `https://github.com/${REPO}/tree/main/decks`;
}

async function init() {
  wireRepoLinks();
  const status = document.getElementById("load-status");
  try {
    const db = await loadDeckDb();
    ALL_DECKS = db.decks || [];
    status.textContent = `${ALL_DECKS.length} decks · generated ${db.generated}`;
    applyFilters();
  } catch (e) {
    status.textContent = `Could not load the deck database: ${e.message}`;
  }

  for (const id of ["f-search", "f-bracket", "f-price", "f-colors"]) {
    document.getElementById(id).addEventListener("input", applyFilters);
  }
}

init();
