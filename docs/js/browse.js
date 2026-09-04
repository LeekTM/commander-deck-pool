// Loads deck_db.json and renders a filterable pool. Also doubles as the best
// test that the database is well-formed, per the brief.

let ALL_DECKS = [];

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

  container.innerHTML = decks.map((deck) => {
    const cardsHtml = deck.cards
      .slice()
      .sort((a, b) => a.n.localeCompare(b.n))
      .map((c) => `<div>${c.q}&times; ${escapeHtml(c.n)}</div>`)
      .join("");
    const tagsHtml = (deck.tags || []).map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join("");

    return `
      <details class="deck-row">
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
