// Parses a pasted decklist into cards + detected commander(s). Mirrors the
// card-line and section-header handling in scripts/deck_parser.py (metadata
// `//` comments are intentionally not handled here -- the page collects
// name/url/tags/bracket as separate form fields instead).

const SECTION_HEADERS = {
  commander: "commander",
  deck: "deck",
  mainboard: "deck",
  main: "deck",
  sideboard: "sideboard",
  companion: "companion",
  maybeboard: "maybeboard",
  "maybe board": "maybeboard",
  tokens: "tokens",
};

const EXCLUDED_SECTIONS = new Set(["sideboard", "maybeboard", "tokens", "companion"]);

const SB_PREFIX_RE = /^(SB|Sideboard)\s*:\s*/i;
// The "x" only counts as a multiplier when whitespace follows it, so
// "3 Xenagos, God of Revels" keeps its X. Whitespace after the count is
// optional, so a pasted "1Rograkh, Son of Rohgahh" is not silently dropped.
const CARD_LINE_RE = /^(\d+)\s*(?:[xX]\s+)?\s*(.+)$/;
const CMDR_MARKER_RE = /\*\s*(CMDR|CMD|COMMANDER)\s*\*/i;
const SET_CRUFT_RE = /\s*[([][A-Za-z0-9]{2,6}[)\]](\s*[A-Za-z0-9\-★]+)?(\s*\*F\*)?\s*$/;
const SECTION_LINE_RE = /^([A-Za-z][A-Za-z ]*?)\s*:?\s*(?:\(\d+\))?\s*$/;

function stripSetCruft(text) {
  let prev = null;
  while (prev !== text) {
    prev = text;
    text = text.replace(SET_CRUFT_RE, "").trim();
  }
  return text;
}

/**
 * @returns {{cards: {name:string, quantity:number, section:string, isCommanderMarked:boolean}[], parseWarnings:string[]}}
 */
function parseDecklistText(text) {
  const cards = [];
  const parseWarnings = [];
  let currentSection = "deck";

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;

    let sectionOverride = null;
    const sbMatch = line.match(SB_PREFIX_RE);
    if (sbMatch) {
      sectionOverride = "sideboard";
      line = line.slice(sbMatch[0].length).trim();
    }

    const headerMatch = line.match(SECTION_LINE_RE);
    if (headerMatch && !CARD_LINE_RE.test(line)) {
      const candidate = headerMatch[1].trim().toLowerCase();
      if (candidate in SECTION_HEADERS) {
        currentSection = SECTION_HEADERS[candidate];
        continue;
      }
    }

    const cardMatch = line.match(CARD_LINE_RE);
    if (!cardMatch) {
      parseWarnings.push(`Could not parse line: ${rawLine}`);
      continue;
    }

    const quantity = parseInt(cardMatch[1], 10);
    let rest = cardMatch[2].trim();
    const isCommanderMarked = CMDR_MARKER_RE.test(rest);
    rest = rest.replace(CMDR_MARKER_RE, "").trim();
    rest = stripSetCruft(rest);
    const name = rest.trim();
    if (!name) {
      parseWarnings.push(`Could not extract card name: ${rawLine}`);
      continue;
    }

    cards.push({ name, quantity, section: sectionOverride || currentSection, isCommanderMarked });
  }

  return { cards, parseWarnings };
}

function deckCards(cards) {
  return cards.filter((c) => !EXCLUDED_SECTIONS.has(c.section));
}

function commanderNames(cards) {
  const names = [];
  for (const c of cards) {
    if ((c.section === "commander" || c.isCommanderMarked) && !names.includes(c.name)) {
      names.push(c.name);
    }
  }
  return names;
}

function aggregateQuantities(cards) {
  const totals = new Map();
  for (const c of cards) totals.set(c.name, (totals.get(c.name) || 0) + c.quantity);
  return totals;
}
