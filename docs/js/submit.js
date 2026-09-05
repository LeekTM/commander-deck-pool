// Drives the submission form: validate against Scryfall, show the results,
// then hand off to a prefilled GitHub issue (matching the field ids in
// .github/ISSUE_TEMPLATE/add-deck.yml).

let gameChangersCache = null;
let lastResult = null;
let lastComputedName = null;

function computeDeckName(result) {
  return `${result.commanders.join(" + ")} (Bracket ${result.bracket})`;
}

// Assembles the Commander/Deck boxes into the "Commander\n...\n\nDeck\n..."
// text the parser expects, so the user never has to type those headers
// themselves. A commander line with no quantity prefix gets "1 " added;
// leaving the Commander box empty falls back to using the Deck box as-is
// (still works if someone pastes a full export, headers and all, into it).
function buildDecklistText() {
  const commanderRaw = document.getElementById("commander-input").value;
  const deckRaw = document.getElementById("deck-input").value;

  const commanderLines = commanderRaw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/^\d/.test(l) ? l : `1 ${l}`));

  if (commanderLines.length === 0) return deckRaw;
  return `Commander\n${commanderLines.join("\n")}\n\nDeck\n${deckRaw}`;
}
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

let existingDecks = [];

async function loadPoolData() {
  const hint = document.getElementById("tag-hint");
  for (const path of ["deck_db.json", "../deck_db.json"]) {
    try {
      const resp = await fetch(path, { cache: "no-store" });
      if (resp.ok) {
        const db = await resp.json();
        existingDecks = db.decks || [];
        for (const deck of existingDecks) {
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

// Same commander already in the pool isn't necessarily a duplicate -- decks
// get rebuilt differently -- so this is a warning to prompt a human look,
// never something that blocks or auto-replaces a submission.
function findSameCommanderDecks(commanders) {
  const wanted = new Set(commanders.map((c) => c.toLowerCase()));
  return existingDecks.filter((d) =>
    (d.commanders || []).some((c) => wanted.has(c.toLowerCase())));
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

  if (result.bannedCards.length) {
    html += `<div class="result-block warn">
      <strong>Not currently legal in Commander:</strong>
      <ul class="issue-list">${result.bannedCards.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
      <label style="display:flex; align-items:center; gap:0.5rem; font-weight:600; margin-top:0.5rem;">
        <input type="checkbox" id="bypass-banned" />
        Add it anyway -- I'm playtesting a card not (yet, or no longer) legal in Commander.
      </label>
    </div>`;
  }

  if (result.commanders.length) {
    html += `<div class="stat-grid">
      ${statBlock("Deck name (auto)", escapeHtml(computeDeckName(result)))}
      ${statBlock("Cards", result.totalCards)}
      ${statBlock("Colours", result.colors || "Colourless")}
      ${statBlock("Game Changers", result.gameChangerCount)}
      ${statBlock("Bracket", result.bracket + (result.bracketOverridden ? " (override)" : " (computed)"))}
      ${statBlock("Price", `€${result.priceEur.toFixed(2)} / $${result.priceUsd.toFixed(2)}`)}
    </div>`;
  }

  body.innerHTML = html;

  const bypassCheckbox = document.getElementById("bypass-banned");
  if (bypassCheckbox) {
    bypassCheckbox.addEventListener("change", updateSubmitEnabled);
  }
  updateSubmitEnabled();
}

// Three things must all be true before Submit enables: no blocking errors,
// a banned-card flag (if any) explicitly bypassed via its checkbox, and the
// Bracket dropdown moved off "Calculate" onto the number Validate reported
// -- everything else that's merely a warning (card count, duplicate
// commander, etc.) doesn't gate it.
function updateSubmitEnabled() {
  const btnSubmit = document.getElementById("btn-submit");
  if (!lastResult) {
    btnSubmit.disabled = true;
    return;
  }
  const bypassCheckbox = document.getElementById("bypass-banned");
  const bannedOk = lastResult.bannedCards.length === 0 || (bypassCheckbox && bypassCheckbox.checked);
  const bracketChosen = document.getElementById("bracket").value !== "";
  btnSubmit.disabled = lastResult.errors.length > 0 || !bannedOk || !bracketChosen;
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
  const decklist = buildDecklistText();
  const bracketOverride = document.getElementById("bracket").value;

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
    if (result.commanders.length) {
      const same = findSameCommanderDecks(result.commanders);
      if (same.length) {
        result.warnings.push(
          `${same.length} existing deck(s) already use this commander: ` +
          `${same.map((d) => d.name).join(", ")}. That's fine if this is a ` +
          `different build -- just flagging it in case it's an accidental duplicate.`
        );
      }
    }
    lastResult = result;
    lastComputedName = result.commanders.length ? computeDeckName(result) : null;
    renderResults(result); // also sets btnSubmit's disabled state via updateSubmitEnabled()
    if (result.errors.length) {
      statusEl.textContent = "Fix the issues above, then validate again.";
    } else if (result.bannedCards.length) {
      statusEl.textContent = "Check the box below to confirm you want to add a card not legal in Commander.";
    } else if (!bracketOverride) {
      statusEl.textContent = `Select ${result.bracket} in the Bracket dropdown above (don't leave it on "Calculate"), then submit.`;
    } else {
      statusEl.textContent = "Ready to submit.";
    }
  } catch (e) {
    statusEl.textContent = `Validation failed: ${e.message}`;
  } finally {
    btnValidate.disabled = false;
  }
}

function buildIssueUrl() {
  // A tag typed into the "add new tag" box but never clicked "Add" would
  // otherwise be silently lost on submit -- commit it now rather than
  // dropping whatever's still sitting in that field.
  const pendingTag = sanitizeTag(document.getElementById("tag-new-input").value);
  if (pendingTag) selectedTags.add(pendingTag);
  const tags = [...selectedTags].join(", ");

  const bracketSel = document.getElementById("bracket");
  const bracketDigits = bracketSel.value; // "" for Calculate, else "1".."5"
  const commanderRaw = document.getElementById("commander-input").value;
  const deckRaw = document.getElementById("deck-input").value;

  // GitHub's query-param prefill for dropdown/input form fields has proven
  // unreliable in practice -- Tags and Bracket showed up empty (or bled
  // through to their placeholder text / a "None" state) even though a
  // textarea's prefill is reliable. So tags/bracket ride along as //
  // comments at the top of the Deck field instead -- the same header
  // format decks/*.txt files already use. issue_to_deck.py picks them up
  // from anywhere in the combined text, position doesn't matter.
  const metaLines = [];
  if (tags) metaLines.push(`// tags: ${tags}`);
  if (bracketDigits) metaLines.push(`// bracket: ${bracketDigits}`);
  const deckWithMeta = metaLines.length ? `${metaLines.join("\n")}\n\n${deckRaw}` : deckRaw;

  const params = new URLSearchParams();
  params.set("template", "add-deck.yml");
  params.set("labels", "deck-submission");
  params.set("title", `[Deck] ${lastComputedName}`);
  params.set("commander", commanderRaw);
  params.set("decklist", deckWithMeta);

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
document.getElementById("bracket").addEventListener("change", updateSubmitEnabled);
document.getElementById("tag-add-btn").addEventListener("click", addNewTag);
document.getElementById("tag-new-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addNewTag();
  }
});

loadPoolData();
