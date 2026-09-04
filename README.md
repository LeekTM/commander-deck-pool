# Commander Deck Pool

A community-maintained pool of Magic: The Gathering Commander decklists,
stored as plain text, validated and enriched against
[Scryfall](https://scryfall.com), and published as `deck_db.json` for a
Tabletop Simulator mod (later phase) to roll a random deck from.

- **Browse / submit page:** `docs/` (GitHub Pages)
- **Source of truth:** `decks/*.txt`, one file per deck
- **Generated database:** `deck_db.json` (never hand-edit; rebuilt on every push to `decks/`)

## Repo layout

```
decks/                  one .txt per deck, the source of truth
deck_db.json            generated -- never hand-edit
ingest_decks.py         builds deck_db.json from decks/
scripts/
  deck_parser.py        decklist text -> structured cards (no network)
  scryfall.py           all Scryfall access lives behind this one module
  validate_deck.py      the blocking/warning rules, CLI + library
  issue_to_deck.py       turns a submission issue into a decks/*.txt file
docs/                   the submission + browse page (GitHub Pages)
.github/workflows/      build + validate + issue-to-deck automation
.github/ISSUE_TEMPLATE/add-deck.yml   the issue form
```

## Adding a deck (three ways)

1. **The submission page** (`docs/submit.html`, published via GitHub Pages).
   Paste a decklist, fill in name/tags/bracket, hit Validate. It checks every
   card against Scryfall in your browser -- typos, banned cards, cards outside
   your commander's colour identity -- and shows the computed price, colours,
   Game Changer count and bracket before you submit. "Submit via GitHub" opens
   a prefilled issue; you need a GitHub account to send it.
2. **A GitHub issue directly** -- open a "Submit a Commander deck" issue and
   fill in the form. A workflow validates it the same way the page does; if
   something's wrong you get a comment explaining what, and no file is
   created. If it passes, the deck file is committed automatically and the
   database rebuilds.
3. **A pull request** -- add `decks/your-deck-name.txt` yourself (see format
   below) and open a PR. A workflow validates it and comments the result, but
   **does not** commit `deck_db.json` for you -- that only happens once the
   PR is merged to `main`. This path is for review, or for adding several
   decks at once.

## Decklist file format

```
// name: Atraxa Superfriends
// url: https://www.mtggoldfish.com/deck/6543210
// tags: superfriends, planeswalkers, grindy
// bracket: 4                             (optional; overrides the computed value)

Commander
1 Atraxa, Praetors' Voice

Deck
1 Sol Ring
1x Arcane Signet
1 Swords to Plowshares [STA]
4 Lightning Bolt (M11) 123
1 Krenko, Mob Boss *CMDR*

Sideboard
1 Lightning Bolt
```

- Exports from MTGGoldfish ("Exact Card Versions"), Moxfield, Archidekt
  (export-to-text), and EDHREC all parse -- set codes, collector numbers, and
  `1x`-style quantities are stripped/handled automatically.
- Section headers (`Commander`, `Deck`/`Mainboard`, `Sideboard`, `Companion`,
  `Maybeboard`, `Tokens`) control placement. Sideboard, maybeboard, tokens and
  companion cards don't count toward the deck.
- Mark your commander with a `Commander` section, a `*CMDR*` tag on the line,
  or `// commander: <name>` in the header -- any one of the three works.
- Split and modal-DFC cards (`Fire // Ice`) are recognised by either the full
  name or the front face alone.

## Validation (blocking)

A submission is rejected, with the offending card(s) named, if:

- any card name isn't recognised by Scryfall (almost always a typo),
- any card isn't legal in Commander (the banned list),
- the marked commander isn't a legendary creature and has no text granting
  commander status, or
- any card falls outside the commander's colour identity.

A card count that isn't 100 is a warning, not a rejection -- decks get built
slightly over/under for all sorts of legitimate reasons.

## Brackets

Bracket is *computed* from the count of cards on Scryfall's live
[Game Changers list](https://scryfall.com/search?q=is%3Agamechanger)
(`is:gamechanger` -- never hardcoded, since WotC revises it every few months):

| Game Changers in deck | computed bracket |
|---|---|
| 0 | 2 |
| 1-3 | 3 |
| 4+ | 4 |

This can't distinguish bracket 1 from 2, or 4 from 5 -- and since the October
2025 rework, brackets are partly defined by expected game length, which
nothing countable can measure. Add `// bracket: N` to a deck file (or set it
on the submission page/issue form) to override the computed value; it's a
sorting hint for the group, not a ruling.

## Prices and colours

- Prices come from Scryfall's cheapest known printing (`prices.eur` /
  `prices.usd`) via `/cards/collection`, excluding basic lands. **EUR is the
  default currency** (`price_eur`) since this group is UK-based and Cardmarket
  tracks real cost better than TCGplayer USD -- `price_usd` is stored too, but
  EUR is what the page and (later) the TTS mod default to.
- Colour identity is the union of every card's `color_identity`, same
  Scryfall call.
- Treat both as a floor, not a market quote.

## Tag vocabulary

Tags are the one field nothing else can derive, so the list is deliberately
small -- pick whichever apply, and don't invent new ones without updating this
list first.

**Archetype:** `aggro` `control` `combo` `midrange` `stax` `tokens`
`aristocrats` `spellslinger` `voltron` `reanimator` `lands` `artifacts`
`tribal` `enchantress` `storm` `mill` `burn` `ramp` `superfriends`
`group-hug` `group-slug`

**Feel / pace:** `grindy` `fast` `glass-cannon` `value`

**Power tier (in addition to bracket):** `budget` `precon` `high-power`

## Running it locally

Requires Python 3.10+, stdlib only (no extra packages).

```bash
python ingest_decks.py decks/ --out deck_db.json
```

This fetches the current Game Changers list once, then batches
`/cards/collection` lookups (75 names/call, ~100ms between calls, per
Scryfall's rate-limit guidance). A deck that fails a blocking check is
skipped with a warning printed to stderr -- one bad file doesn't break the
build for everyone else.

Validate a single decklist (used by the issue-to-deck workflow, and handy
while writing one by hand):

```bash
python scripts/validate_deck.py decks/atraxa-superfriends.txt
```

To preview the page locally, copy the database into `docs/` (the build
workflow does this automatically for GitHub Pages) and serve the `docs/`
folder:

```bash
cp deck_db.json docs/deck_db.json
python -m http.server 8000 --directory docs
```

Then open `http://localhost:8000`. Before publishing the page for real, set
`REPO` in `docs/config.js` to `your-username/your-repo-name` -- that's what
builds the "Submit via GitHub" link.

## Publishing the page

GitHub repo settings -> Pages -> Deploy from a branch -> `main` / `/docs`.

## Automation

- **`build-db.yml`** -- on push to `main` touching `decks/`, `ingest_decks.py`,
  or `scripts/`: rebuilds `deck_db.json`, mirrors it to `docs/deck_db.json`
  (Pages only serves `docs/`), and commits both if changed.
- **`validate-deck-pr.yml`** -- on a PR touching `decks/`: validates each
  changed file and comments the result. Never commits.
- **`issue-to-deck.yml`** -- on a new "Submit a Commander deck" issue:
  validates the submission; if valid, writes `decks/<slug>.txt`, commits it to
  `main`, comments the computed stats, and closes the issue. If invalid,
  comments what's wrong and labels the issue `needs-changes` -- no file is
  written.

None of these need a secret beyond the default `GITHUB_TOKEN`, and there's no
hosted database or auth -- GitHub is the backend. `build-db.yml` and
`issue-to-deck.yml` push straight to `main`, so leave it unprotected (or grant
the Actions bot a bypass) -- a required-review branch rule would block them.

## Out of scope (for now)

The Tabletop Simulator mod that reads `deck_db.json` is a later phase. This
repo only builds and serves the database. See `deck_db.json`'s schema (in the
project brief) before changing any field name or type -- the mod will read it
in Lua with no schema tolerance.

## Constraints (don't rediscover these)

- MTGGoldfish and Moxfield have no public API and prohibit/block scraping --
  exporting is a manual, human step.
- Archidekt has a usable public JSON API (`/api/decks/v3/`,
  `/api/decks/{id}/`), no auth needed -- useful for offline bulk-import if
  ever wanted, never called from the browser page.
- Scryfall is the only card-data source. Respect its rate limit
  (`scripts/scryfall.py` and `docs/js/scryfall.js` both do).
