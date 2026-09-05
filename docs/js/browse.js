// Loads deck_db.json and renders a filterable pool. Also doubles as the best
// test that the database is well-formed, per the brief.

let ALL_DECKS = [];
let RENDERED_DECKS = []; // the currently-filtered subset, indexed by data-i

// deck_db.json deliberately stores only name + quantity per card, so type,
// image and price come from Scryfall the first time a deck is expanded and
// are cached here (lowercase name -> {group, image, priceEur}) for the rest
// of the session. Keeps the data contract the TTS mod reads untouched, and
// costs no extra API calls: one /cards/collection response already carries
// all three.
//
// Images themselves are hotlinked from cards.scryfall.io, which Scryfall
// documents as having no rate limit ("The direct file origins located at
// *.scryfall.io do not have rate limits") and serves with year-long cache
// headers -- so we store no images ourselves and revisits cost nothing.
const CARD_CACHE = new Map();

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
  return deck.cards.every((c) => CARD_CACHE.has(c.n.toLowerCase()));
}

async function ensureCardDataFor(deck) {
  const missing = deck.cards
    .map((c) => c.n)
    .filter((n) => !CARD_CACHE.has(n.toLowerCase()));
  if (missing.length === 0) return;
  // An empty Game Changers set is fine -- deck.gc already comes from
  // deck_db.json, so there's no need to spend a request fetching that list.
  const { byName } = await lookupCards(missing, new Set());
  for (const name of missing) {
    const info = byName.get(name.toLowerCase());
    CARD_CACHE.set(name.toLowerCase(), {
      group: info ? typeGroupFor(info.typeLine) : "Other",
      image: info ? info.imageUrl : null,
      large: info ? info.largeUrl : null,
      priceEur: info ? info.priceEur : null,
    });
  }
}

// Splits a deck into its ordered type groups, with the commander(s) pulled
// out of their type group into one of their own.
function groupDeck(deck) {
  const commanders = new Set((deck.commanders || []).map((c) => c.toLowerCase()));
  const groups = new Map();

  for (const card of deck.cards) {
    const key = card.n.toLowerCase();
    const cached = CARD_CACHE.get(key);
    const group = commanders.has(key) ? "Commander" : ((cached && cached.group) || "Other");
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(card);
  }

  return TYPE_GROUP_ORDER
    .filter((g) => groups.has(g))
    .map((g) => {
      const cards = groups.get(g).sort((a, b) => cardLabel(a).localeCompare(cardLabel(b)));
      return {
        name: g,
        cards,
        count: cards.reduce((sum, c) => sum + c.q, 0),
        priceEur: cards.reduce((sum, c) => {
          const cached = CARD_CACHE.get(c.n.toLowerCase());
          return sum + (cached && cached.priceEur ? cached.priceEur * c.q : 0);
        }, 0),
      };
    });
}

function groupHeading(group) {
  return `<h4>${group.name} (${group.count})<span class="group-price">€${group.priceEur.toFixed(2)}</span></h4>`;
}

function groupedCardsHtml(deck) {
  return groupDeck(deck)
    .map((group) => {
      const items = group.cards
        .map((c) => `<div>${c.q}&times; ${escapeHtml(cardLabel(c))}</div>`)
        .join("");
      return `<div class="card-group">${groupHeading(group)}${items}</div>`;
    })
    .join("");
}

function visualCardsHtml(deck) {
  return groupDeck(deck)
    .map((group) => {
      const items = group.cards.map((c) => {
        const cached = CARD_CACHE.get(c.n.toLowerCase());
        const name = escapeHtml(cardLabel(c));
        // loading="lazy" so only the cards actually scrolled into view are
        // ever fetched; the CDN's year-long cache headers make revisits free.
        const img = cached && cached.image
          ? `<img src="${escapeHtml(cached.image)}" alt="${name}" title="${name}" loading="lazy" decoding="async" width="488" height="680" />`
          : `<div class="card-image-missing">${name}</div>`;
        const qty = c.q > 1 ? `<span class="card-qty">${c.q}&times;</span>` : "";
        const large = cached && (cached.large || cached.image);
        // data-large drives the tap/click pop-out (delegated in wireLightbox).
        const popout = large ? ` data-large="${escapeHtml(large)}" data-name="${name}"` : "";
        return `<div class="card-image"${popout} tabindex="0" role="button" aria-label="Enlarge ${name}">${img}${qty}</div>`;
      }).join("");
      return `<div class="card-group">${groupHeading(group)}<div class="card-image-grid">${items}</div></div>`;
    })
    .join("");
}

function flatCardsHtml(deck) {
  return deck.cards
    .slice()
    .sort((a, b) => cardLabel(a).localeCompare(cardLabel(b)))
    .map((c) => `<div>${c.q}&times; ${escapeHtml(cardLabel(c))}</div>`)
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

// A partner pair's name is long enough to push the pills onto a second line,
// which reads as broken layout. Break it where the two commanders join so the
// name stacks instead. Escaping runs first, so this only ever splits on the
// literal " + " the deck name was built with.
// A card entry stores the name Scryfall knows as "n", and what the submitter
// wrote as "as" when the two differ -- a Secret Lair reskin such as
// "Miku, Lost but Singing" over "Azusa, Lost but Seeking". Look cards up by
// "n"; show people the name they submitted.
function cardLabel(c) {
  return c.as || c.n;
}

function deckNameHtml(name) {
  return escapeHtml(name).split(" + ").join("<br>");
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
    const cardsHtml = grouped ? cardsHtmlFor(deck) : flatCardsHtml(deck);
    const tagsHtml = (deck.tags || []).map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join("");

    return `
      <details class="deck-row" data-i="${i}" data-grouped="${grouped ? "1" : "0"}">
        <summary>
          <span class="name">${deckNameHtml(deck.name)}</span>
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
        <div class="deck-cardlist${grouped && currentView() === "visual" ? " visual" : ""}">${cardsHtml}</div>
      </details>
    `;
  }).join("");

  RENDERED_DECKS = decks;
  container.querySelectorAll("details.deck-row").forEach((el) => {
    el.addEventListener("toggle", () => onDeckToggle(el));
  });
}

const VIEW_PREF_KEY = "cdp_view";

// -- pop-out ----------------------------------------------------------------
// Hovering enlarges a card in place (desktop only, via CSS). Tapping or
// clicking opens this full-size overlay, which is the only way to get a
// readable card on touch, where there's no hover to speak of.

function openLightbox(url, name) {
  let box = document.getElementById("lightbox");
  if (!box) {
    box = document.createElement("div");
    box.id = "lightbox";
    box.className = "lightbox";
    box.addEventListener("click", closeLightbox);
    document.body.appendChild(box);
  }
  box.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" />`;
  box.classList.add("open");
}

function closeLightbox() {
  const box = document.getElementById("lightbox");
  if (box) {
    box.classList.remove("open");
    box.innerHTML = ""; // don't keep a full-size image around once it's closed
  }
}

function wireLightbox() {
  // Delegated, because the deck list is re-rendered on every filter change.
  const container = document.getElementById("decks");
  container.addEventListener("click", (e) => {
    const card = e.target.closest(".card-image[data-large]");
    if (card) openLightbox(card.dataset.large, card.dataset.name);
  });
  container.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".card-image[data-large]");
    if (!card) return;
    e.preventDefault();
    openLightbox(card.dataset.large, card.dataset.name);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });
}

function currentView() {
  const el = document.getElementById("f-view");
  return el ? el.value : "visual";
}

// Remember the list/images choice across visits. Images are the default:
// decks render collapsed, and lazy loading means no image is fetched until
// a deck is actually expanded, so defaulting to them costs nothing on load.
function restoreViewPref() {
  const el = document.getElementById("f-view");
  if (!el) return;
  let saved = null;
  try {
    saved = localStorage.getItem(VIEW_PREF_KEY);
  } catch (e) {
    // private browsing / storage blocked -- just use the default
  }
  if (saved === "list" || saved === "visual") el.value = saved;
  el.addEventListener("change", () => {
    try {
      localStorage.setItem(VIEW_PREF_KEY, el.value);
    } catch (e) {
      // not worth surfacing -- the view still works, it just won't persist
    }
  });
}

function cardsHtmlFor(deck) {
  return currentView() === "visual" ? visualCardsHtml(deck) : groupedCardsHtml(deck);
}

async function onDeckToggle(el) {
  if (!el.open || el.dataset.grouped === "1" || el.dataset.loading === "1") return;
  const deck = RENDERED_DECKS[Number(el.dataset.i)];
  if (!deck) return;

  const listEl = el.querySelector(".deck-cardlist");
  el.dataset.loading = "1";
  const previous = listEl.innerHTML;
  listEl.innerHTML = '<p class="hint">Loading card data...</p>';

  try {
    await ensureCardDataFor(deck);
    listEl.innerHTML = cardsHtmlFor(deck);
    listEl.classList.toggle("visual", currentView() === "visual");
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
  const sort = document.getElementById("f-sort").value;
  return { search, bracket, maxPrice: Number.isFinite(maxPrice) ? maxPrice : null, colors, sort };
}

// Price sorts on EUR, the currency the brief makes the default for this
// group. Every sort falls back to name so equal values (two bracket-3 decks,
// say) come out in a stable, predictable order rather than shuffling.
const SORTERS = {
  "name-asc": (a, b) => a.name.localeCompare(b.name),
  "name-desc": (a, b) => b.name.localeCompare(a.name),
  "price-asc": (a, b) => a.price_eur - b.price_eur || a.name.localeCompare(b.name),
  "price-desc": (a, b) => b.price_eur - a.price_eur || a.name.localeCompare(b.name),
  "bracket-asc": (a, b) => a.bracket - b.bracket || a.name.localeCompare(b.name),
  "bracket-desc": (a, b) => b.bracket - a.bracket || a.name.localeCompare(b.name),
  "gc-asc": (a, b) => a.gc - b.gc || a.name.localeCompare(b.name),
  "gc-desc": (a, b) => b.gc - a.gc || a.name.localeCompare(b.name),
};

function applyFilters() {
  const filters = readFilters();
  const filtered = ALL_DECKS.filter((d) => deckMatchesFilters(d, filters));
  filtered.sort(SORTERS[filters.sort] || SORTERS["name-asc"]);
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
  wireLightbox();
  restoreViewPref(); // before the first render, so it paints in the right view
  const status = document.getElementById("load-status");
  try {
    const db = await loadDeckDb();
    ALL_DECKS = db.decks || [];
    status.textContent = `${ALL_DECKS.length} decks · generated ${db.generated}`;
    applyFilters();
  } catch (e) {
    status.textContent = `Could not load the deck database: ${e.message}`;
  }

  for (const id of ["f-search", "f-bracket", "f-price", "f-colors", "f-sort", "f-view"]) {
    document.getElementById(id).addEventListener("input", applyFilters);
  }
}

init();
