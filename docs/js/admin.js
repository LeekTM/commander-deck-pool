// Admin panel: edits/deletes deck files directly via the GitHub Contents
// API, authenticated with a token the admin pastes in. There is no other
// access control -- GitHub's own permission check on that token IS the
// access control, which is why this page is safe to leave publicly linked.
//
// Deck <-> file matching is done by the deck's *name* (exact string match
// against each file's "// name:" header, read from its raw content), not by
// re-deriving a slug from deck_db.json -- that stays correct even after an
// admin renames a deck without renaming its underlying file.

const GH_API = "https://api.github.com";
const TOKEN_KEY = "cdp_admin_token";

let ghToken = sessionStorage.getItem(TOKEN_KEY) || "";
let deckRecords = [];              // from deck_db.json
let fileByName = new Map();        // deck name -> { path, sha, fileName, content }
let editingIndex = null;
let busy = false; // true while an edit/delete request is in flight

function setTableButtonsDisabled(disabled) {
  document.querySelectorAll("#admin-tbody button").forEach((btn) => {
    btn.disabled = disabled;
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function setStatus(msg) {
  document.getElementById("admin-status").textContent = msg;
}

function base64FromUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function utf8FromBase64(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ""))));
}

async function ghApi(path, options = {}) {
  const resp = await fetch(`${GH_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  const bodyText = await resp.text();
  const body = bodyText ? JSON.parse(bodyText) : null;
  if (!resp.ok) {
    throw new Error(`GitHub API ${resp.status}: ${body && body.message ? body.message : bodyText.slice(0, 200)}`);
  }
  return body;
}

// -- header parsing/rebuilding (mirrors scripts/deck_parser.py's metadata format) --

function splitHeaderBody(text) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim().startsWith("//")) i++;
  let bodyStart = i;
  if (lines[bodyStart] !== undefined && lines[bodyStart].trim() === "") bodyStart++;
  return { headerLines: lines.slice(0, i), body: lines.slice(bodyStart).join("\n") };
}

function parseHeader(headerLines) {
  const map = {};
  for (const line of headerLines) {
    const m = line.match(/^\/\/\s*([a-zA-Z ]+?)\s*:\s*(.*)$/);
    if (m) map[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return map;
}

function rebuildHeader(map) {
  const order = ["name", "url", "source", "tags", "bracket", "set", "released"];
  return order
    .filter((k) => map[k] !== undefined && map[k] !== "")
    .map((k) => `// ${k}: ${map[k]}`)
    .join("\n");
}

// -- loading --

async function loadEverything() {
  setStatus("Loading deck_db.json...");
  const dbResp = await fetch(`deck_db.json?ts=${Date.now()}`, { cache: "no-store" });
  if (!dbResp.ok) throw new Error("Could not load deck_db.json");
  const db = await dbResp.json();
  deckRecords = db.decks || [];

  setStatus("Listing decks/ via the GitHub API...");
  const listing = await ghApi(`/repos/${REPO}/contents/decks`);

  setStatus(`Reading ${listing.length} deck file(s)...`);
  fileByName = new Map();
  await Promise.all(listing.map(async (entry) => {
    if (!entry.name.endsWith(".txt")) return;
    const resp = await fetch(entry.download_url, { cache: "no-store" });
    const content = await resp.text();
    const { headerLines } = splitHeaderBody(content);
    const header = parseHeader(headerLines);
    const name = header.name || entry.name.replace(/\.txt$/, "");
    fileByName.set(name, { path: entry.path, sha: entry.sha, fileName: entry.name, content });
  }));

  renderTable();
  setStatus(`Loaded ${deckRecords.length} deck(s) from deck_db.json, matched ${fileByName.size} file(s).`);
}

function renderTable() {
  document.getElementById("admin-table-card").hidden = false;
  document.getElementById("deck-count").textContent = deckRecords.length;
  const tbody = document.getElementById("admin-tbody");

  tbody.innerHTML = deckRecords.map((deck, i) => {
    const file = fileByName.get(deck.name);
    const actions = file
      ? `<button data-i="${i}" class="secondary btn-edit">Edit</button>
         <button data-i="${i}" class="danger btn-delete">Delete</button>`
      : `<a href="https://github.com/${REPO}/tree/main/decks" target="_blank" rel="noopener">no matching file &mdash; manage on GitHub</a>`;
    return `<tr>
      <td>${escapeHtml(deck.name)}</td>
      <td>${escapeHtml((deck.commanders || []).join(" + "))}</td>
      <td>${deck.bracket}</td>
      <td>${escapeHtml((deck.tags || []).join(", "))}</td>
      <td>€${deck.price_eur.toFixed(2)}</td>
      <td>${actions}</td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".btn-edit").forEach((btn) =>
    btn.addEventListener("click", () => openEdit(+btn.dataset.i)));
  tbody.querySelectorAll(".btn-delete").forEach((btn) =>
    btn.addEventListener("click", () => doDelete(+btn.dataset.i)));
}

// -- edit --

function openEdit(i) {
  const deck = deckRecords[i];
  const file = fileByName.get(deck.name);
  if (!file) return;
  editingIndex = i;

  const { headerLines } = splitHeaderBody(file.content);
  const header = parseHeader(headerLines);

  document.getElementById("edit-name").value = header.name || deck.name;
  document.getElementById("edit-tags").value = header.tags || "";
  document.getElementById("edit-bracket").value = header.bracket || "";
  document.getElementById("edit-card").hidden = false;
  document.getElementById("edit-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeEdit() {
  editingIndex = null;
  document.getElementById("edit-card").hidden = true;
}

async function saveEdit() {
  if (editingIndex === null || busy) return;
  const deck = deckRecords[editingIndex];
  const file = fileByName.get(deck.name);
  if (!file) return;

  const newName = document.getElementById("edit-name").value.trim();
  const newTags = document.getElementById("edit-tags").value.trim();
  const newBracket = document.getElementById("edit-bracket").value.trim();
  if (!newName) {
    setStatus("Name can't be empty.");
    return;
  }

  const { headerLines, body } = splitHeaderBody(file.content);
  const header = parseHeader(headerLines);
  header.name = newName;
  if (newTags) header.tags = newTags; else delete header.tags;
  if (newBracket) header.bracket = newBracket; else delete header.bracket;

  const newText = `${rebuildHeader(header)}\n\n${body.replace(/^\n+/, "")}`;

  busy = true;
  document.getElementById("btn-save-edit").disabled = true;
  setTableButtonsDisabled(true);
  try {
    setStatus(`Saving ${file.fileName}...`);
    await ghApi(`/repos/${REPO}/contents/${file.path}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Admin: edit ${file.fileName}`,
        content: base64FromUtf8(newText),
        sha: file.sha,
        branch: "main",
      }),
    });
    setStatus("Saved. deck_db.json rebuilds automatically in the background -- reload in ~30-60s to see it reflected.");
    closeEdit();
    await loadEverything();
  } catch (e) {
    if (e.message.includes("404")) {
      setStatus(`"${file.fileName}" is already gone (deleted or renamed elsewhere) -- refreshing the list.`);
      closeEdit();
      await loadEverything();
    } else {
      setStatus(`Save failed: ${e.message}`);
    }
  } finally {
    busy = false;
    document.getElementById("btn-save-edit").disabled = false;
    setTableButtonsDisabled(false);
  }
}

// -- delete --

async function doDelete(i) {
  if (busy) return;
  const deck = deckRecords[i];
  const file = fileByName.get(deck.name);
  if (!file) return;

  if (!confirm(`Delete "${deck.name}" (decks/${file.fileName})? This is a normal git commit, so it's recoverable from history, but won't undo from this page.`)) {
    return;
  }

  busy = true;
  setTableButtonsDisabled(true);
  try {
    setStatus(`Deleting ${file.fileName}...`);
    await ghApi(`/repos/${REPO}/contents/${file.path}`, {
      method: "DELETE",
      body: JSON.stringify({
        message: `Admin: delete ${file.fileName}`,
        sha: file.sha,
        branch: "main",
      }),
    });
    setStatus("Deleted. deck_db.json rebuilds automatically in the background -- deleting several in a row is fine, they queue into one rebuild.");
    await loadEverything();
  } catch (e) {
    if (e.message.includes("404")) {
      setStatus(`"${file.fileName}" was already gone -- probably deleted by an earlier click. Refreshing the list.`);
      await loadEverything();
    } else {
      setStatus(`Delete failed: ${e.message}`);
    }
  } finally {
    busy = false;
    setTableButtonsDisabled(false);
  }
}

// -- connect / wiring --

async function connect() {
  const input = document.getElementById("gh-token");
  const typed = input.value.trim();
  if (typed) ghToken = typed;
  if (!ghToken) {
    setStatus("Paste a token first.");
    return;
  }
  sessionStorage.setItem(TOKEN_KEY, ghToken);
  input.value = "";
  try {
    await loadEverything();
  } catch (e) {
    setStatus(`Couldn't connect: ${e.message}`);
  }
}

function forgetToken() {
  ghToken = "";
  sessionStorage.removeItem(TOKEN_KEY);
  document.getElementById("admin-table-card").hidden = true;
  document.getElementById("edit-card").hidden = true;
  setStatus("Token forgotten.");
}

document.getElementById("btn-connect").addEventListener("click", connect);
document.getElementById("btn-forget").addEventListener("click", forgetToken);
document.getElementById("btn-save-edit").addEventListener("click", saveEdit);
document.getElementById("btn-cancel-edit").addEventListener("click", closeEdit);

(function init() {
  if (typeof REPO !== "undefined" && REPO !== "OWNER/REPO") {
    document.getElementById("repo-name").textContent = REPO;
    document.getElementById("link-repo").href = `https://github.com/${REPO}`;
  }
  if (ghToken) connect();
})();
