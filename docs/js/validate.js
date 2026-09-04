// Client-side twin of scripts/validate_deck.py -- same blocking rules, same
// warnings, run against Scryfall directly from the browser. Keep the two in
// sync; this is what the brief calls "the most important part of the page".

/**
 * @param {string} decklistText
 * @param {Set<string>} gameChangers
 * @returns {Promise<object>} result with {errors, warnings, commanders, totalCards, priceUsd, priceEur, colors, gameChangerCount, bracket, bracketOverridden}
 */
async function validateDecklist(decklistText, gameChangers, bracketOverride) {
  const result = {
    errors: [],
    warnings: [],
    commanders: [],
    totalCards: 0,
    priceUsd: 0,
    priceEur: 0,
    colors: "",
    gameChangerCount: 0,
    bracket: 2,
    bracketOverridden: false,
  };

  const { cards, parseWarnings } = parseDecklistText(decklistText);
  result.warnings.push(...parseWarnings);

  const cardsInDeck = deckCards(cards);
  const quantities = aggregateQuantities(cardsInDeck);
  const uniqueNames = [...quantities.keys()];

  result.totalCards = [...quantities.values()].reduce((a, b) => a + b, 0);
  if (result.totalCards !== 100) {
    result.warnings.push(`Deck has ${result.totalCards} cards, not the expected 100.`);
  }

  const commanders = commanderNames(cards);
  if (commanders.length === 0) {
    result.errors.push(
      "No commander detected. Mark it with a 'Commander' section header, or tag the line with *CMDR*."
    );
    return result;
  }
  result.commanders = commanders;

  const { byName, notFound } = await lookupCards([...uniqueNames, ...commanders], gameChangers);

  if (notFound.length) {
    result.errors.push(`Card name(s) not recognised by Scryfall: ${[...new Set(notFound)].sort().join(", ")}`);
  }

  const banned = [];
  for (const name of uniqueNames) {
    const info = byName.get(name.toLowerCase());
    if (!info) continue;
    if (!isBasicLand(name) && !info.legalCommander) banned.push(name);
  }
  if (banned.length) {
    result.errors.push(`Card(s) not legal in Commander: ${[...new Set(banned)].sort().join(", ")}`);
  }

  for (const cmdrName of commanders) {
    const info = byName.get(cmdrName.toLowerCase());
    if (!info) continue;
    if (!isLegalCommanderCard(info)) {
      result.errors.push(
        `'${cmdrName}' is not a legendary creature and has no text granting commander status.`
      );
    }
  }

  const commanderIdentity = new Set();
  for (const cmdrName of commanders) {
    const info = byName.get(cmdrName.toLowerCase());
    if (info) for (const c of info.colorIdentity) commanderIdentity.add(c);
  }

  if (commanderIdentity.size > 0 || commanders.length) {
    const outOfIdentity = [];
    for (const name of uniqueNames) {
      const info = byName.get(name.toLowerCase());
      if (!info) continue;
      const cardColors = info.colorIdentity || [];
      if (!cardColors.every((c) => commanderIdentity.has(c))) outOfIdentity.push(name);
    }
    if (outOfIdentity.length) {
      result.errors.push(
        `Card(s) outside the commander's colour identity: ${[...new Set(outOfIdentity)].sort().join(", ")}`
      );
    }
  }

  let priceUsd = 0;
  let priceEur = 0;
  const allColors = new Set();
  let gcCount = 0;
  for (const [name, qty] of quantities) {
    const info = byName.get(name.toLowerCase());
    if (!info) continue;
    for (const c of info.colorIdentity) allColors.add(c);
    if (!isBasicLand(name)) {
      priceUsd += (info.priceUsd || 0) * qty;
      priceEur += (info.priceEur || 0) * qty;
      if (info.isGameChanger) gcCount += 1;
    }
  }

  result.priceUsd = Math.round(priceUsd * 100) / 100;
  result.priceEur = Math.round(priceEur * 100) / 100;
  result.colors = colorsString(allColors);
  result.gameChangerCount = gcCount;

  const computedBracket = computeBracket(gcCount);
  if (bracketOverride && /^[1-5]$/.test(String(bracketOverride).trim())) {
    result.bracket = parseInt(bracketOverride, 10);
    result.bracketOverridden = true;
  } else {
    result.bracket = computedBracket;
  }

  return result;
}
