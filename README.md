# Commander Deck Pool

A community-maintained pool of Magic: The Gathering Commander decklists,
stored as plain text, validated and enriched against
[Scryfall](https://scryfall.com), and published as `deck_db.json` (plus
per-deck files in `docs/tts/`) for a Tabletop Simulator mod to roll a random
deck from.

- **Browse / submit page:** `docs/` (GitHub Pages)
- **Source of truth:** `decks/*.txt`, one file per deck
- **Generated database:** `deck_db.json` (never hand-edit; rebuilt on every push to `decks/`)

## Legal

This project is unofficial Fan Content permitted under Wizards of the Coast's
[Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy).
Not approved/endorsed by Wizards. Portions of the materials used are property
of Wizards of the Coast LLC. © Wizards of the Coast LLC.

Card data and images come from [Scryfall](https://scryfall.com/docs/api),
used under its API terms -- the same terms exist specifically for fan tools
like this one. This project doesn't use the Scryfall name or logo in any way
implying Scryfall's endorsement, doesn't crop, distort, recolor, or watermark
card images, and sends an accurate `User-Agent` on every request while
respecting Scryfall's rate limits and caching results (`scripts/scryfall.py`,
`docs/js/scryfall.js`) rather than hammering the API.

Everything here -- the browse page, the submission page, the deck pool
itself -- is free: no login, paywall, survey, or subscription gates any of
it, and nothing is sold or sublicensed.

## AI disclosure

All code in this repository -- Python, JavaScript, HTML/CSS, and the GitHub
Actions workflows -- was written using AI (Claude Code). The decks themselves
are human-submitted and the card data is Scryfall-sourced; the code that
validates, builds, and serves them is AI-generated.

## Repo layout

```
decks/                one .txt per deck, the source of truth
deck_db.json          generated -- never hand-edit
ingest_decks.py       builds deck_db.json (and docs/tts/) from decks/
scripts/
  deck_parser.py      decklist text -> structured cards (no network)
  scryfall.py         all Scryfall access lives behind this one module
  validate_deck.py    the blocking/warning rules, CLI + library
  issue_to_deck.py    turns a submission issue into a decks/*.txt file
docs/                 the submission + browse page (GitHub Pages)
docs/tts/             per-deck JSON for the TTS mod, generated -- never hand-edit
.github/workflows/    build + validate + issue-to-deck automation
.github/ISSUE_TEMPLATE/add-deck.yml   the issue form
```

## Adding a deck (three ways)

1. **The submission page** (`docs/submit.html`, published via GitHub Pages).
   Paste the commander's name into the Commander box and the other 99 cards
   into the Deck box -- no need to type "Commander"/"Deck" headers or a
   quantity for the commander, that's assembled for you -- then hit
   Validate. It checks every card against Scryfall in your browser -- typos,
   cards outside your commander's colour identity, and cards not currently
   legal in Commander (flagged, not blocked -- see below) -- and shows the
   calculated price, colours, Game Changer count and bracket. Select that
   calculated bracket number from the dropdown (it's required), pick any
   tags that fit, and "Submit via GitHub" opens a prefilled issue; you need
   a GitHub account to send it. There's no name or source-link field: the
   deck's name is generated as `<Commander> (Bracket N)`.
2. **A GitHub issue directly** -- open a "Submit a Commander deck" issue.
   Same two fields as the page: Commander (just the name) and Deck (the
   other 99 cards, no header needed). Add tags or a bracket override the
   same way a hand-written file would -- `// tags: ...` / `// bracket: N`
   as the first lines of the Deck field -- if you want them; otherwise it
   computes the bracket and leaves tags blank. A workflow validates it the
   same way the page does; if something's wrong you get a comment
   explaining what, and no file is created. If it passes, the deck file is
   committed automatically and the database rebuilds.
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

## Validation

A submission is rejected, with the offending card(s) named, if:

- any card name isn't recognised by Scryfall (almost always a typo),
- the marked commander isn't a legendary creature and has no text granting
  commander status, or
- any card falls outside the commander's colour identity.

A card on the Commander banned list is **flagged, not blocked** -- the
submission page shows it as a warning with an explicit "add it anyway"
checkbox that has to be ticked before Submit enables, so the group can
playtest a card that isn't (yet, or no longer) tournament-legal without a
human editing the file by hand afterward. `ingest_decks.py` never rejects a
deck over this either, for the same reason. A card count that isn't 100 is
also just a warning -- decks get built slightly over/under for all sorts of
legitimate reasons.

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
nothing countable can measure. Add `// bracket: N` to a deck file to
override the computed value; it's a sorting hint for the group, not a
ruling.

The page/issue-form Bracket dropdown is deliberately **not** an "always
recompute" auto option -- validating shows the calculated number, and
you're expected to select that number yourself rather than leave it on
"Calculate" (the field is required, precisely to force this). Once a
digit is selected there, it's written to the file as a real `// bracket:`
override, same as if you'd typed it into the file by hand -- which means
it's a snapshot, not a live computation: if the Game Changers list changes
later, that deck's bracket won't move with it unless someone edits the
override. Leaving it on "Calculate" still works and does behave as a true
live computation (forever recomputed on every rebuild) -- it's just no
longer the expected path for page/issue submissions.

## Prices and colours

- Prices come from whichever printing Scryfall returns for the card's *name*
  via `/cards/collection` (`prices.eur` / `prices.usd`), excluding basic lands.
  That's Scryfall's own default printing, which is usually the most recent one
  and **not** the cheapest -- Sol Ring prices as its newest printing (~EUR
  1.62) rather than its cheapest (~EUR 0.69, and it has 130 paper printings).
  Pricing every card at its cheapest printing would need a `unique=prints`
  search per card -- thousands of calls -- which isn't worth it for what is
  explicitly a sorting hint.
- **EUR is the default currency** (`price_eur`) since this group is UK-based
  and Cardmarket tracks real cost better than TCGplayer USD -- `price_usd` is
  stored too, but EUR is what the page and the TTS mod default to.
- Colour identity is the union of every card's `color_identity`, same
  Scryfall call.
- Treat both as a floor, not a market quote.

## Tags

There's no fixed tag vocabulary -- tags are whatever the group has used so
far. The submission page shows every tag already present in the pool as a
clickable chip (pulled live from `deck_db.json`), so reuse one if it fits, or
type a new one. Consistency is just a matter of picking an existing tag over
inventing a near-duplicate, not a rule anything enforces. Submitting directly
via a GitHub issue or a PR works the same way -- just type comma-separated
tags in the file's `// tags:` line; check `docs/index.html` or the existing
`decks/*.txt` files for what's already in use.

## Duplicate decks

There's no automatic dedupe. A same-commander deck can legitimately be built
several different ways (budget vs. optimized, different sub-themes), so
matching on commander + bracket and overwriting silently would occasionally
destroy a real, different deck -- worse than the problem it solves. Instead,
the submission page warns (not blocks) when the commander being submitted
already appears elsewhere in the pool, naming the existing deck(s), and
leaves the call to a human. If it turns out to be a genuine duplicate, delete
the old one from the admin panel.

## Admin panel

`docs/admin.html` edits and deletes deck files directly via the GitHub
Contents API. There's no separate login -- a GitHub token *is* the access
control, so the page is safe to leave publicly linked: without a token that
has write access to the repo, nothing on it can do anything.

To use it, create a
[fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
scoped to just this repository, with Contents set to Read and write, and a
short expiry, then paste it in. It's kept in that tab's `sessionStorage` only
(gone when the tab closes) and used solely for calls straight from the
browser to `api.github.com` and `raw.githubusercontent.com` -- it never goes
anywhere else, including to me or into this repo.

It currently supports editing a deck's name/tags/bracket-override (a
metadata-only change -- the card list itself isn't touched, and the
underlying filename doesn't change even if the name does) and deleting a
deck file outright. Both are normal commits to `main`, which `build-db.yml`
then picks up to rebuild `deck_db.json` same as any other change.

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

**It's incremental.** Every deck record stores a hash of the `.txt` it was
built from, so a rebuild only re-fetches decks whose file actually changed and
pools those lookups into one batch. Adding a single deck costs one deck's
worth of Scryfall calls (~2s) instead of the whole pool's (~70s and climbing),
which is what keeps submission time flat as the pool grows. Nothing changed
means no card lookups at all.

The catch is prices: an untouched deck keeps its stored prices until something
re-enriches it. `--full` ignores the cache and re-prices everything --

```bash
python ingest_decks.py decks/ --out deck_db.json --full
```

-- and `build-db.yml` runs exactly that on a weekly schedule. A change to the
Game Changers list invalidates the whole cache by itself, since `gc` and the
computed bracket derive from it.

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
  (Pages only serves `docs/`), and commits both if changed. Also runs weekly
  on a schedule with `--full` to refresh prices across the pool; the same run
  can be triggered by hand from the Actions tab.
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

## The Tabletop Simulator mod

The mod itself -- the Lua object script that reads this data in-game -- lives
outside this repo (it's a local TTS Saved Object, not a web asset). This repo
only builds and serves the data it reads: `deck_db.json` and the per-deck
files in `docs/tts/` (both written by `ingest_decks.py --tts-dir docs/tts`
and committed by `build-db.yml`). See `deck_db.json`'s schema (in the project
brief) before changing any field name or type -- the mod reads it in Lua with
no schema tolerance.

## Constraints (don't rediscover these)

- MTGGoldfish and Moxfield have no public API and prohibit/block scraping --
  exporting is a manual, human step.
- Archidekt has a usable public JSON API (`/api/decks/v3/`,
  `/api/decks/{id}/`), no auth needed -- useful for offline bulk-import if
  ever wanted, never called from the browser page.
- Scryfall is the only card-data source. Respect its rate limit
  (`scripts/scryfall.py` and `docs/js/scryfall.js` both do).
- Scryfall's bulk-data files can't reproduce these prices, so don't "optimise"
  the rebuild onto them expecting the numbers to stay put. Measured, on this
  pool: `oracle_cards` (23 MB) holds one printing per card, and for ~23 of the
  pool's cards that printing is MTGO-only with no paper price at all
  (`Lotus Petal`, `Strip Mine`, `Plateau`...). `default_cards` (78 MB) has
  every printing, but nothing in the data marks *which* one
  `/cards/collection` returns for a name, and the closest rule ("newest
  non-promo paper printing") comes out a median 12.7% low, ranging -52% to
  +77%, matching only 4 of 83 decks. Also beware art-series printings: they
  are separate objects whose front-face name collides with the real card
  (`Deflecting Swat` art card, EUR 0.00, vs the real one at EUR 61.38), so any
  name index built from bulk has to drop `layout: art_series` /
  `set_type: memorabilia`. Bulk is still the correct answer if lookups ever
  need to be genuinely rapid or high-volume -- it just is not a drop-in for
  pricing.
