// Drives the submission form: validate against Scryfall, show the results,
// then hand off to a prefilled GitHub issue (matching the field ids in
// .github/ISSUE_TEMPLATE/add-deck.yml).

let gameChangersCache = null;
let lastResult = null;
const allTags = new Set();      // every tag offered as a chip (existing + newly added)
const selectedTags = new Set(); // the subset currently toggled on

function sanitizeTag(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function renderTagChips() {
  const container = document.getElementById("tag-existing");
  container.innerHTML = [...allTags].sort().map((t) => {
    const selected = selectedTags.has(t);
    return `<button type="button" class="tag-chip${selected ? " selected" : ""}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`;
  }).join("");

  container.querySelectorAll(".tag-chip").forEach((el) => {
    el.addEventListener("click", () => {
      const tag = el.dataset.tag;
      if (selectedTags.has(tag)) selectedTags.delete(tag);
      else selectedTags.add(tag);
      el.classList.toggle("selected");
    });
  });
}

async function loadExistingTags() {
  const hint = document.getElementById("tag-hint");
  for (const path of ["deck_db.json", "../deck_db.json"]) {
    try {
      const resp = await fetch(path, { cache: "no-store" });
      if (resp.ok) {
        const db = await resp.json();
        for (const deck of db.decks || []) {
          for (const t of deck.tags || []) allTags.add(t);
        }
        break;
      }
    } catch (e) {
      // try next path
    }
  }
  if (allTags.size === 0 && hint) {
    hint.textContent = "Couldn't load existing tags -- add your own below.";
  }
  renderTagChips();
}

function addNewTag() {
  const input = document.getElementById("tag-new-input");
  const tag = sanitizeTag(input.value);
  input.value = "";
  if (!tag) return;
  allTags.add(tag);
  selectedTags.add(tag);
  renderTagChips();
}

async function getGameChangers(statusEl) {
  if (gameChangersCache) return gameChangersCache;
  statusEl.textContent = "Fetching the current Game Changers list from Scryfall...";
  gameChangersCache = await fetchGameChangers();
  return gameChangersCache;
}

function statBlock(label, value) {
  return `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

function renderResults(result) {
  const panel = document.getElementById("results");
  const body = document.getElementById("results-body");
  panel.hidden = false;

  let html = "";

  if (result.errors.length) {
    html += `<div class="result-block err"><strong>Blocked &mdash; fix before submitting:</strong>
      <ul class="issue-list">${result.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
    </div>`;
  } else {
    html += `<div class="result-block ok"><strong>Looks good.</strong> No blocking issues found.</div>`;
  }

  if (result.warnings.length) {
    html += `<div class="result-block warn"><strong>Warnings:</strong>
      <ul class="issue-list">${result.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
    </div>`;
  }

  if (result.commanders.length) {
    html += `<div class="stat-grid">
      ${statBlock("Commander", escapeHtml(result.commanders.join(" + ")))}
      ${statBlock("Cards", result.totalCards)}
      ${statBlock("Colours", result.colors || "Colourless")}
      ${statBlock("Game Changers", result.gameChangerCount)}
      ${statBlock("Bracket", result.bracket + (result.bracketOverridden ? " (override)" : " (computed)"))}
      ${statBlock("Price", `€${result.priceEur.toFixed(2)} / $${result.priceUsd.toFixed(2)}`)}
    </div>`;
  }

  body.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function onValidate() {
  const statusEl = document.getElementById("validate-status");
  const btnValidate = document.getElementById("btn-validate");
  const btnSubmit = document.getElementById("btn-submit");
  const decklist = document.getElementById("decklist").value;
  const name = document.getElementById("deck-name").value.trim();
  const bracketOverride = document.getElementById("bracket").value;

  if (!name) {
    statusEl.textContent = "Enter a deck name first.";
    return;
  }
  if (!decklist.trim()) {
    statusEl.textContent = "Paste a decklist first.";
    return;
  }

  btnValidate.disabled = true;
  btnSubmit.disabled = true;
  try {
    const gameChangers = await getGameChangers(statusEl);
    statusEl.textContent = "Checking cards against Scryfall...";
    const result = await validateDecklist(decklist, gameChangers, bracketOverride);
    lastResult = result;
    renderResults(result);
    statusEl.textContent = result.errors.length
      ? "Fix the issues above, then validate again."
      : "Ready to submit.";
    btnSubmit.disabled = result.errors.length > 0;
  } catch (e) {
    statusEl.textContent = `Validation failed: ${e.message}`;
  } finally {
    btnValidate.disabled = false;
  }
}

function buildIssueUrl() {
  const name = document.getElementById("deck-name").value.trim();
  const url = document.getElementById("deck-url").value.trim();
  const tags = [...selectedTags].join(", ");
  const bracketSel = document.getElementById("bracket");
  const bracketLabel = bracketSel.value ? bracketSel.value : "Auto (recommended)";
  const decklist = document.getElementById("decklist").value;

  const params = new URLSearchParams();
  params.set("template", "add-deck.yml");
  params.set("labels", "deck-submission");
  params.set("title", `[Deck] ${name}`);
  params.set("deck-name", name);
  params.set("deck-url", url);
  params.set("decklist", decklist);
  params.set("tags", tags);
  params.set("bracket", bracketLabel);

  return `https://github.com/${REPO}/issues/new?${params.toString()}`;
}

function onSubmit() {
  const statusEl = document.getElementById("validate-status");
  if (!lastResult || lastResult.errors.length) {
    statusEl.textContent = "Validate the deck first and fix any blocking issues.";
    return;
  }
  if (REPO === "OWNER/REPO") {
    statusEl.textContent =
      "The site owner hasn't set docs/config.js yet (REPO is still a placeholder) -- can't build the GitHub link.";
    return;
  }

  const issueUrl = buildIssueUrl();
  if (issueUrl.length > 7500) {
    statusEl.textContent =
      "Heads up: this decklist is long enough that GitHub may truncate the prefilled issue -- " +
      "double-check the pasted decklist once the issue form opens, and paste it again if needed.";
  }
  window.open(issueUrl, "_blank", "noopener");
}

document.getElementById("btn-validate").addEventListener("click", onValidate);
document.getElementById("btn-submit").addEventListener("click", onSubmit);
document.getElementById("tag-add-btn").addEventListener("click", addNewTag);
document.getElementById("tag-new-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addNewTag();
  }
});

loadExistingTags();
