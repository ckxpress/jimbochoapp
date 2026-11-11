# 神保町 · jimbocho.app

A static site for browsing and searching book metadata from Hong Kong and
Taiwan — **446,090 books** across 16 datasets, aiming eventually at every book
published in both places.

Two audiences, one mechanism. A reader marks what they own and what they would
part with; an independent bookshop puts up a selection as a portfolio. Both are
the same shelf, shared as a link — see [The bookshelf](#the-bookshelf).

| | |
|---|---|
| 臺灣出版新書預告書訊 | 169,808 books, 2024–2026 |
| 香港印刷書刊目錄 | 118,422 books, 2017–2026 |
| 國家圖書館館藏書目資訊 | 118,153 books |
| Open Library (pre-2017 Hong Kong) | 21,188 books |
| 全國圖書書目資訊網 NBINet 圖書聯合目錄 | 18,519 books |
| with a real cover | 56,509 (13%) |
| database | 496.2 MB, queried by byte range |

Chinese 348,946 · English 59,727 · ten languages in all.

No framework, no npm dependencies, no server. A Node script imports datasets and
the browser does the rest — reading plain JSON, or querying a SQLite database by
byte range once the catalogue outgrows memory (see
[Two query backends](#two-query-backends)).

```bash
npm start        # serve site/ at http://localhost:8080 — no build needed
npm run import   # fetch + normalise the datasets in datasets.json
```

Node 12+, and `sqlite3` with FTS5 for database work. Every script uses only Node
built-ins.

**Contributing, and working from an iPad: [CONTRIBUTING.md](CONTRIBUTING.md).**
It covers the one-click Codespace, the four constraints that shape the
architecture, and how to add a dataset.

> The figures above come from `site/data/manifest.json` and are current as of
> 6 November 2026. They change with every import.

---

## What you get

**Browse** a cover grid or a detail list, sorted by relevance, title, year or
publisher.

**Traditional Chinese throughout.** The interface is in Traditional Chinese,
and the catalogue leads with Chinese titles: the source publishes separate
Chinese and English volumes, and 25,468 of the English records carry the Chinese
form of their title as a parallel title, so that form is displayed and the other
language is shown beneath it. Title ordering groups Chinese ahead of Latin —
otherwise the 46,755 Latin-first titles sort ahead of everything in any standard
collation. A fresh visit opens on the 348,946 Chinese-language records, with
English — 59,727 of them — a click away in
the Language filter; a search that finds nothing because of it offers to search
every language.

**Search** across title (both language forms), subtitle, authors, publisher,
series, category, ISBN and registration number. Chinese queries work without spaces (`香港` → ~1,600
hits) and so do partial words. All terms must match; matches are highlighted.
Pasting a full ISBN finds that book directly.

**Filter** by dataset, language, category, publisher, year, quarterly release,
availability and whether a record carries an ISBN. Counts update against the
other active filters, so options never lead to zero results.

**Every view is a URL.** Searches, filters and sort live in the address bar, and
each book has a permalink — both are shareable and survive a reload.

Also: light/dark themes, `/` to focus search, keyboard and screen-reader
friendly, works down to phone width.

## The metadata

| Field | Source |
| --- | --- |
| Title, subtitle, parallel title, statement of responsibility | Split from the catalogue's ISBD title string; the Chinese form is shown first |
| Authors (up to 10) | Source columns, with inverted names shown naturally (`Cheung, Ysabelle` → Ysabelle Cheung) |
| Publisher, place, year, edition, series, frequency | Source columns |
| ISBN / ISSN | Parsed from free text; every ISBN on a record is kept with its qualifier (pbk., 精裝, 全12冊), plus normalised ISBN-13 and ISBN-10 |
| Physical description | Raw string plus parsed page count and dimensions |
| Category, notes | Source columns |
| Price, availability | Parsed amount + currency; "Unpriced"/非賣品 recorded as not for sale |
| Registration number, catalogue serial, source file, release | Provenance for every record |
| **Description** | *Derived* — composed from the catalogue fields, in the record's own language |
| **Copyright** | *Derived* — publisher plus year of publication |
| **Cover** | *Not in the dataset* — resolved by ISBN at render time |

The two derived fields are labelled **derived** in the UI wherever they appear.
The source is a registration catalogue: it has no abstracts and no rights
statement, so these are composed rather than reported. Everything else is
verbatim from the dataset.

### Covers

Covers are **resolved once at build time**, not looked up per visitor:

```bash
npm run covers
```

That probes Google Books for every ISBN on every record, detects the
placeholder bitmap it returns instead of a 404, and writes the URL into the
data for the ones that resolve. Results are cached in `cache/covers.json`
(committed — it represents 538,066 requests), so re-runs only probe what is new.
`npm run build` does it as part of the pipeline.

**56,509 of 446,090 records have a real cover — 13%.** The rest get a generated cover built from the title and a
colour seeded by the record id, so every book shows something and nothing
renders broken.

That number is the ceiling, not a shortfall in effort. Measured across sources:

| Source | Hit rate | Notes |
| --- | --- | --- |
| Google Books | 13% | the only source that works |
| Open Library | 0% | effectively no Hong Kong ISBNs |
| Amazon | 3% | doesn't carry these titles |
| TAAZE | 0% | returns a placeholder for every ISBN |
| 博客來 books.com.tw | — | HTTP 403, blocks automated access |
| hkbookcity | — | connection refused |

The catalogue is largely listed-company annual reports, textbooks and
government publications, which were never scanned. The shops that do stock the
trade titles refuse automated requests, and this project does not work around
that.

Resolving at build time also means a reader loads **one request per book that
has a cover, and none for the books that don't** — previously every card fired
one or two lookups that mostly failed.

### Availability on 3ook.com

A book page links to the ebook on [3ook.com](https://3ook.com) when there is
one:

```bash
npm run 3ook
```

3ook is a decentralised bookstore, so its URLs are keyed by an on-chain
contract address and carry no ISBN — the ISBN is in each page's JSON-LD, in a
block typed `["Book","Product"]`. This reads the sitemap 3ook advertises, then
those pages, and writes `site/data/3ook.json`. Cached in `cache/3ook.json`
(committed, like the covers) so a rebuild only fetches books added since.

Measured across the whole of 3ook:

| | |
|---|---|
| store pages | 1,908 |
| carrying a usable ISBN | 1,314 (69%) |
| distinct ISBNs | 1,311 |
| also in this catalogue | **930** |
| book pages that gain a link | 944 |

So **49% of 3ook's catalogue** is reachable from here. The 31% with no ISBN are
invisible to this and there is no honest way around it: matching on title and
author would produce false positives, and a wrong "available" is worse than a
missing one.

The whole map ships as one 78 KB file — 61 bytes a book — loaded on the first
book page and never for a visitor who only browses. That is the point of doing
it this way: a book page asks 3ook nothing, so there is no CORS arrangement to
maintain, nothing to be slow or down, and no record of what anyone reads here
leaving this site.

The link says 電子版 deliberately. These records come from print
bibliographies; a shared ISBN means an edition exists on 3ook, not that it is
the same object in the hand.

## The bookshelf

Any book can be marked **＋ 我有** from the corner of its cover, and 我的書架
lists what has been added.

Adding one asks what it should sell for, pre-filled with the catalogue price
where the record has one (2,243 records are unpriced annual reports and the
like, so the field can be left blank — those show as 未定價). The price is
editable from the shelf, which totals what has been priced, and it travels with
the share link.

That makes a shared shelf a sale list for a reader clearing out their shelves,
and a portfolio for an independent bookshop showing what it carries. The site
does not distinguish the two, and deliberately so: both are a set of books with
optional prices, published as an unlisted link. A bookshop needs no account and
no listing fee to put one up, and nothing about it is uploaded here.

What the shelf is *not* yet, for either of them, is a shopfront — there is no
cart, no payment, and no way for a buyer to do anything but read the list and
contact whoever shared it.

**There are no accounts.** The site is static files on GitHub Pages — there is
no server to authenticate against and nowhere to keep a profile — so the shelf
is stored in the reader's own browser. That is honest but limited, and the UI
says so: the shelf belongs to one device and one browser, and clearing site
data loses it.

Two ways out of that, both working today:

- **匯出 / 匯入 JSON** — a backup the reader controls, which also moves a shelf
  between devices. Importing merges rather than replaces.
- **分享書架** — a link with the shelf packed into the URL fragment
  (`#/shelf?s=…`, dataset written once, then registration numbers). Whoever
  opens it sees that shelf read-only, and can add any of those books to their
  own. Nothing is uploaded; the link *is* the data.

That share link is as close to a public profile as a static site honestly gets:
it is a snapshot, not a live profile, and it is unlisted rather than
discoverable.

### Adding real accounts later

`Shelf` in [`site/app.js`](site/app.js) is deliberately four functions —
`all`, `has`, `toggle`, `save` — with the rest of the UI going through them.
Email sign-in, cross-device sync and live public profiles mean replacing those
four with calls to a hosted backend (Supabase is the obvious fit: free tier,
Postgres, email magic links, row-level security, and it works from a static
page). The ownership UI, the shelf page and the share link do not change.

Two things to decide before that: you would be holding readers' email
addresses, which carries obligations under the PDPO; and public profiles make
reading habits visible, which is a product decision as much as a technical one.

## Adding more datasets

Datasets are declared in [`datasets.json`](datasets.json) and imported by
[`tools/import.js`](tools/import.js).

```bash
npm run import                                   # everything registered
npm run import -- hkpl-2025                      # one dataset
npm run import -- --add-hkpl-year 2026           # next year of the HK catalogue
npm run import -- --file examples/sample-books.csv --id my-shelf --title "My shelf"
npm run import -- --url https://host/books.json --id x --title "X"
npm run import -- --list                         # what is registered / imported
npm run import -- --remove my-shelf              # drop a dataset and its files
npm run import -- --refresh                      # ignore the download cache
```

`--file` / `--url` imports are written back into `datasets.json`, so
`npm run import` re-imports them later. Add `--no-save` for a one-off.
Other options: `--adapter --description --provider --homepage --license
--region --language --label --currency`.

Try it with the four-book sample:

```bash
npm run import -- --file examples/sample-books.csv --id sample-shelf --title "Sample shelf"
```

The site picks up new datasets on reload — nothing to rebuild. Multiple datasets
coexist, and a **Dataset** filter appears once there is more than one.

### A note on fetching

The importer sends a browser user-agent. In November 2026 hkpl.gov.hk began
answering this project's own identifier with its 404 page — including for files
it had served the day before — while serving the same URLs normally to a
browser. The catalogue is published on DATA.GOV.HK for programmatic reuse, so
this looks like a blanket WAF rule rather than a policy decision. It is stated
in `tools/lib/fetch.js` rather than left as an unexplained string.

The current year is published a quarter at a time, so `--add-hkpl-year` skips
quarters that return 404 and imports what exists. Re-run it when the next
quarter appears; the download cache means only the new file is fetched.

### Adapters

| Adapter | For |
| --- | --- |
| `hkpl-bro` | The Hong Kong quarterly catalogue CSVs (the default for `--add-hkpl-year`) |
| `generic-csv` | Any book CSV — columns auto-mapped by name |
| `json` | A JSON array of book objects — keys auto-mapped the same way |

`generic-csv` and `json` recognise the usual names for title, subtitle, author,
publisher, year, ISBN, description, category, price, cover and more, in English
or Chinese, so most exports import with no configuration. Columns that aren't
recognised are preserved per-record and shown in the detail view, so nothing is
silently dropped.

Column names drift between releases upstream — 2025 Q3 renamed nearly every
header (`ISBN` for `International Standard Book Number`, prefixes like
`B: Author 1`) — so every field is matched by alias, not by position.

To support a genuinely different format, add a module to `tools/adapters/`
exporting `parse(ctx)` that returns records built by `tools/lib/record.js`, and
register it in the `ADAPTERS` map in `tools/import.js`.

## Data source

[A Catalogue of Books Printed in Hong Kong](https://data.gov.hk/en-data/dataset/hk-lcsd-lib-lib-bro)
— Books Registration Office, Hong Kong Public Libraries (Leisure and Cultural
Services Department), published quarterly on DATA.GOV.HK as one CSV per quarter
per language, under the
[DATA.GOV.HK terms of use](https://data.gov.hk/en/terms-and-conditions).
Field definitions are in the
[data dictionary](https://www.hkpl.gov.hk/en/common/attachments/about-us/services/book-registration/catalogueHK_datadic_en.pdf).

## Icon

`site/icons/icon-1600.png` is the master — the supplied artwork cropped to its
panel and flattened to a full-bleed square, since iOS and Android apply their
own rounding and a pre-rounded icon ends up with dark corners inside their
mask. Everything else is derived from it with `sips`:

```bash
for s in 512 192 180 64 48 32 16; do
  sips -Z $s site/icons/icon-1600.png --out site/icons/icon-$s.png
done
cp site/icons/icon-180.png site/apple-touch-icon.png
cp site/icons/icon-32.png  site/favicon.png
```

`icon-maskable-512.png` is a separate build for Android's adaptive masks,
which crop to a circle inscribed in the middle 80%. The artwork is scaled to
410px and padded back out to 512 with the same `#BE4E30`, so the mask only ever
eats panel colour:

```bash
sips -Z 410 site/icons/icon-1600.png --out /tmp/inner.png
sips -p 512 512 --padColor BE4E30 /tmp/inner.png --out site/icons/icon-maskable-512.png
```

The panel colour `#BE4E30` is the manifest's `theme_color` and
`background_color`, so the Android splash screen is the same terracotta the
icon sits on. The `theme-color` **meta** tags are deliberately different — see
below.

## Installing it as an app

The site is a progressive web app: it can be added to a phone's home screen or
a Mac's Dock and then opens in its own window, with no browser chrome.

`site/sw.js` is the service worker, and it is **network-first for everything**.
A cache-first worker would load faster, but this project regenerates its whole
data set on every import, and a worker that served last week's `app.js` against
this week's `manifest.json` would break the page in a way an ordinary visitor
has no way to clear. So every request tries the network first and falls back to
the cache after four seconds or on failure. The cache is there for the MTR
tunnel, not for speed. Verified: with the dev server stopped outright, the app
still opens and renders all 446,090 books.

Only same-origin requests are cached. Cover thumbnails come from Google and
arrive as opaque responses, which some browsers charge several megabytes each
against the storage quota — not worth it for a thumbnail. Range requests are
passed straight through, because putting a 206 into the Cache API corrupts it
and that is how the SQLite backend reads the database.

`site/install.js` does the asking, and the two browser families need opposite
handling:

- **Chromium** (Chrome, Edge, Brave, Samsung) fires `beforeinstallprompt`. That
  event is stashed, Chrome's own mini-infobar is suppressed, and the real
  install dialog opens on a tap of our button instead.
- **Safari** has no API at all, on either iOS or macOS — Apple's choice. All
  that can be done is tell the visitor which menu to open, so the sheet names
  the actual menu items: 「分享」→「加入主畫面」on iOS, 「檔案」→「加入 Dock…」
  on macOS Sonoma or later.

The nagging is kept in check: nothing is shown when already running installed
(`display-mode: standalone`), the banner waits for the second visit and never
returns once dismissed, and the top-bar 安裝 button is always there for anyone
who wants it sooner.

Two more details worth knowing:

- The `theme-color` metas track the **top bar** (`#ffffff` / `#1e1e18`), not the
  brand terracotta, so in an installed window the status bar blends into the
  page instead of sitting on it as a stripe. A browser uses the first
  `theme-color` whose `media` matches, so the only way to express "the visitor
  overrode the system theme" is to give both tags the same colour — which is
  what `syncThemeColor()` in `app.js` does.
- `screenshots` in the manifest are what make Chrome show a rich install dialog
  with a preview rather than a bare one-line prompt. Their declared `sizes`
  must match the files exactly or Chrome silently ignores them.

## Deploying

The site is static files, so it needs no server and no build at serve time.

```bash
npm run deploy
```

That publishes the contents of `site/` to the `gh-pages` branch, which is what
GitHub Pages serves at **https://jimbocho.app**. `site/CNAME` carries the custom
domain; it must stay in `site/` so it lands at the root of the published branch,
which is where GitHub looks for it. `main`
holds the source; `gh-pages` holds only what is inside `site/`, at its root,
because branch-based Pages can serve from the root or `/docs` and nothing else.
Push `main` as usual — that alone does not update the site.

The command compares the two trees first and exits without pushing when they
already match, so running it twice is harmless.

It deliberately avoids `git subtree push`. That command maintains a separate
split history, and once both methods have been used on the same branch, every
later subtree push is rejected as a non-fast-forward. One way in, no choice to
get wrong.

Hash routing means no rewrite rules are needed, and every path is relative, so
a project subpath works without configuration.

## Two query backends

The site reads its data one of two ways, chosen automatically by what's in
`site/data/manifest.json`. The UI, the record shape and the importer are
identical either way.

| | **JSON shards** (default) | **SQLite over HTTP** |
| --- | --- | --- |
| How | every record loaded into memory | `books.db` queried by byte range |
| Built by | `npm run import` | `npm run build:db` |
| Good for | up to ~50k books | millions |
| First load | grows with the catalogue | ~100 KB regardless of size |
| Search | in-memory scan | FTS5 index |

```bash
npm run build
```

That runs the import and then the database build. `npm run build:db` alone
rebuilds only the database.

**`site/data/books.db` is not committed.** It is derived from the shards, it is
496 MB, and git would keep every rebuild of it forever. Run `npm run build:db`
to produce it locally; the deploy only publishes what is committed, so the
database is absent from the published site until you host it deliberately —
which for a catalogue large enough to need it means object storage anyway, not
Pages. It needs the `sqlite3` CLI with FTS5 — macOS ships
with it, `apt install sqlite3` elsewhere — and it checks before writing
anything. Delete `books.db` and remove the `db` key from the manifest to go
back to the JSON path.

Measured in 2026 on a 10,912-record catalogue, which is why the JSON path wins
here and no longer does — the catalogue is now 446,090 books and the SQLite
backend is what ships:

| | JSON shards | SQLite |
| --- | --- | --- |
| Opening the site | 491 KB, 4 files | **104 KB, 17 range requests** |
| A search | 43 ms | 92–151 ms |
| Opening a book | one 365 KB shard | one indexed lookup |
| Hosted size | 16 MB | 21 MB |

At this size the JSON path is simply better — it is smaller and faster, and
this is what the repo ships with. SQLite wins only once the catalogue no longer
fits in a browser's memory, which is the point of having both.

### Chinese search

Chinese has no spaces, so an ordinary tokenizer indexes a whole title as a
single token and `香港` matches nothing. FTS5's `trigram` tokenizer handles
substrings but needs three characters, which fails the most common query length
of two.

So CJK text is indexed as overlapping **bigrams** — 中國文化 becomes
`中國 國文 文化` — and queries are tokenised by the same code, in
[`site/tokenize.js`](site/tokenize.js). A two-character query is then one exact
token, and a single character becomes a prefix search. Latin text tokenises on
word boundaries as usual. The builder and the browser share that one file
deliberately: an index built by different rules than the query uses would return
nothing, silently.

### What makes it fast, and what to watch

Range requests punish two things: touching many scattered rows, and issuing many
dependent round trips. Four choices follow from that, and each was worth
megabytes when measured:

- **Full records live in a separate `docs` table.** They are 70% of the file but
  are only read when a book is opened. Left inline, every facet count and sort
  dragged them across the network.
- **Unfiltered facet counts are precomputed at build time.** The opening view
  needs all eight at once; aggregating them live cost 4.1 MB, reading them back
  costs a few KB.
- **Searches rank inside the FTS index, then fetch only the page's rows.**
  Joining first made SQLite walk a row per match to show sixty results.
- **A 32 MB page cache** (`PRAGMA cache_size`), because an evicted page is
  another HTTP request, not a memory read.

Search-time facet counts are capped at `FACET_SCAN_CAP` matches and are
approximate beyond it. A search still transfers ~2.7 MB at this size; the next
optimisation, if it's needed, is a narrow dictionary-encoded facet table so
counting stops touching full rows.

### Hosting the database

The database is read by HTTP range request, so the host must return ranges of
the file *as stored*. Two things go wrong in practice, and only the first is
obvious:

**GitHub Pages compresses it and ranges the compressed stream.** Asking for
bytes 4096–8191 returns those bytes of a gzip stream, not of the database:

```
Accept-Encoding: identity  ->  content-range: bytes 4096-8191/21653504   correct
Accept-Encoding: gzip      ->  content-range: bytes 4096-8191/3781511    compressed
```

Browsers always send `gzip` and cannot opt out — `Accept-Encoding` is a
forbidden header. The result is a database that opens and answers queries
*wrongly*, which is worse than failing outright. So the build records a known
row in the manifest and the site reads it back on startup; if it does not
match, the site says so on the About page and serves the JSON shards instead.
**On GitHub Pages the site therefore runs on the JSON backend**, which is the
better choice at this size anyway.

To actually run the database, host it somewhere that serves binary files
untouched — Cloudflare R2, S3, Backblaze B2 — and point the manifest at it
with an absolute URL (CORS required); the site stays on Pages:

```json
"db": { "url": "https://pub-xxxx.r2.dev/books.db", "bytes": 21653504, ... }
```

That is also the answer past **GitHub's 100 MB per-file limit** and
**Cloudflare Pages' 25 MB**, which at roughly 2 KB per record arrive at about
50k and 12k books. The client library also supports splitting the database
into chunks (`serverMode: "chunked"`) if you would rather keep everything on
one host.

## How it fits together

```
datasets.json          what to import, and with which adapter
tools/import.js        CLI: fetch → parse → normalise → shard → manifest
tools/build-sqlite.js  builds books.db (FTS5 + precomputed facet counts)
tools/serve.js         static dev server (gzip, no-store, byte ranges)
tools/adapters/        one module per source format
tools/lib/             CSV parser, downloader/cache, field matching,
                       ISBD/ISBN/price parsing, record assembly
site/                  index.html + styles.css + app.js, no framework
site/tokenize.js       search tokenizer, shared with the build
site/schema.js         facet SQL, shared with the build
site/sw.js             service worker: network-first, offline fallback
site/install.js        add-to-home-screen / add-to-Dock prompting
site/site.webmanifest  app name, icons, shortcuts, install screenshots
site/vendor/           sql.js-httpvfs (MIT), vendored — no CDN at runtime
site/data/             generated: manifest.json + shards + books.db (git-tracked)
cache/                 downloaded source files (git-ignored)
```

Each import writes two tiers of shards, in the same order:

- `<id>.index.<n>.json` — slim rows for browsing, searching and filtering
- `<id>.full.<n>.json` — the complete record, fetched only when a book is opened

The browser loads the index tier up front (3.4 MB for 10,912 books, ~1 MB
gzipped) and pulls one full shard on demand, so opening a book never means
downloading the whole catalogue. A record's position in the index gives its
position in the full data, so no id→shard lookup table is needed.
