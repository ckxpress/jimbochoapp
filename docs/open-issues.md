# Open work, drafted as issues

Ready to paste into **Issues → New issue** on GitHub, one per section. Not
filed by Claude — `gh` is not authenticated here, and filing them is a
judgement call about what the project is asking for help with.

Suggested labels are given per issue. `good first issue` marks the two that are
self-contained, measured, and need no decision from the maintainer.

---

## 1. Decide whether `ol-hk` earns its place at 4% Chinese titles

**Labels:** `data`, `decision needed`

The Open Library dataset is 21,188 records and exists for one reason: Hong Kong
books published before 2017, where the registration catalogue begins. Nothing
else reaches back that far.

But its titles are mostly romanised, because that is how the donated MARC
records were transliterated. Measured: **4% of `ol-hk` records have a
Chinese-character title** (6% of those marked as Chinese-language). The search
index tokenises CJK as overlapping bigrams, so `臺灣地理` becomes
`["臺灣","灣地","地理"]` and cannot match a title tokenised as
`["taiwan","di","li"]`. Verified directly against `site/tokenize.js`.

So for a reader searching in Chinese — the overwhelming majority — those 21,188
records are close to invisible, while still counting toward every total shown
on the page.

Three options:

- **Keep as is.** The records are real and findable by browsing, by year, and
  by romanised search.
- **Filter to CJK titles on import.** Roughly 850 records survive. The pre-2017
  gap stays almost entirely open, but what remains is searchable.
- **Drop the dataset.** The gap is then explicit rather than nominally filled.

Worth deciding before the totals get quoted anywhere, and worth revisiting if
the NCL or JULAC request (see issue 6) lands something better.

---

## 2. Defer the facet counts on wide screens too

**Labels:** `performance`

A plain search costs 177 range requests. 95 are the results; **82 are the
filter panel**, because the facet query fetches each matching row once per
facet and every one of those fetches drags its neighbouring pages along.

Below 900px the panel is `display: none` until 篩選 is tapped, and the counts
are now computed only when it is on screen — a phone search is 95 requests.
Above 900px the sidebar is laid out inline and always visible, so the counts
are genuinely needed and nothing is saved:

| | requests | bytes |
|---|---|---|
| 375px, panel closed | 95 | 4.13 MB |
| 375px, panel opened | 177 | 13.91 MB |
| 1280px | 177 | 13.91 MB |

Ideas, roughly in order of appeal:

- Collapse the sidebar behind a disclosure on desktop as well, so the counts
  are opt-in everywhere. A behaviour change for desktop readers.
- Count against the FTS hits alone where a facet's column allows it, instead of
  fetching the whole row eight times.
- Precompute counts for the most common queries, the way `facet_counts` already
  does for browsing.

Reproduce with `LOG_RANGES=1 npm start` and a search for `香港文學`
(344 hits). See CONTRIBUTING.md on why requests matter more than bytes.

---

## 3. Skip the ISBN-10 twin when the ISBN-13 already found a cover

**Labels:** `good first issue`, `performance`

`isbnsOf()` in `tools/resolve-covers.js` queues every ISBN on every record,
which includes both the ISBN-13 and the ISBN-10 of the same edition. Google
Books answers for either, so when the first hits, the second is a wasted
request to someone else's service.

Measured over the completed run:

```
isbn13+isbn10 pairs both probed   173,210
  where BOTH returned a cover      31,867   ← the second probe added nothing
```

About 10% of 538,066 requests bought nothing. A full `--recheck` would waste
them again.

The fix is to check, before probing an ISBN, whether another ISBN of the same
`isbns[]` entry has already resolved. Note the distinction the existing comment
makes: separate entries in `isbns[]` can be genuinely different editions, where
one may be scanned and the other not. Only the isbn13/isbn10 pair *within* one
entry is the same book.

Not worth interrupting a running resolve for — roughly 20 minutes on a normal
run — but it pays properly on a `--recheck`, and it is politeness toward a free
service.

---

## 4. Deflate the `docs` blob when headroom runs out

**Labels:** `performance`, `blocked`

The database is 496.2 MB against Cloudflare's 512 MB cacheable ceiling. Past
that ceiling every range request is answered from origin with
`cf-cache-status: BYPASS`, and the difference is not subtle: the same search
took ~46 s for every reader at 729 MB and **0.9 s** at 441 MB once the edge
holds the ranges.

That leaves about **15 MB, or roughly 14,000 books** — not even a quarter of a
year of Taiwan imports. `docs` has already been reduced from the whole record
to only the fields `books` does not hold, and the derived description and
copyright are computed in the browser rather than stored.

The next lever is compressing the blob. Measured on a 5,000-record sample,
deflate takes it from 480 to about 272 bytes a row, which would put the
database near 400 MB. Browsers can inflate it natively with
`DecompressionStream('deflate')`, so no library is needed.

Things to work out:

- `DecompressionStream` support against the browsers this site targets, and
  what the fallback is.
- Whether SQLite should store it as a `BLOB` rather than text.
- Whether the saving survives — the blob is small per row, and deflate has
  per-stream overhead, so a shared dictionary may be needed.

**Blocked until the headroom is actually needed.** Filed so the next person to
hit the ceiling does not have to rediscover the measurement.

---

## 5. Chunk `npm run covers` so a full re-check fits one CI job

**Labels:** `ci`

`.github/workflows/rebuild.yml` takes a `cover_limit` input precisely because a
full run does not fit: **538,066 ISBNs at roughly 800/min is about 11 hours**
against a 6-hour job ceiling. Incremental runs are fine, since
`cache/covers.json` is committed and a normal rebuild only probes what is new —
but a `--recheck`, which re-probes everything, cannot complete.

Options:

- A matrix job that splits the ISBN space by hash and merges the caches.
- A resumable run that commits the cache periodically and re-queues itself.
- Raise `CONCURRENCY` above 6 — but that is deliberately polite toward a free
  service and should not move far.

Lower priority than it looks: a `--recheck` is rarely wanted. It matters if
Google's coverage improves and the whole catalogue is worth re-probing.

---

## 6. Hong Kong before 2017 and Taiwan before 2024: data access

**Labels:** `data`, `blocked`, `help wanted`

The catalogue's floors are set by what the registries publish, not by choice:

| | earliest | why |
|---|---|---|
| 香港印刷書刊目錄 | 2017 Q1 | the floor of HKPL's own archive; DATA.GOV.HK lists nothing earlier |
| 臺灣出版新書預告書訊 | 2024-01 | the earliest month `isbn.ncl.edu.tw` still serves, established by probing, including ROC-year URL variants. No Wayback snapshots exist |

**NBINet is published as open data after all.** The data.gov.tw catalogue — all
52,582 datasets of it, downloadable in bulk from
`https://data.gov.tw/datasets/export/csv` with no key — lists 34 National
Central Library datasets, including:

| id | dataset | licence |
|---|---|---|
| **7502** | 全國圖書書目資訊網(NBINet) | OGDL v1.0, free |
| **27311** | 國家圖書館館藏書目資訊 | OGDL v1.0, free |
| 37878 | 臺灣華文電子書庫書目資料 | OGDL v1.0, free |
| 7503 | 漢學出版品書目資料 | OGDL v1.0, free |
| 6839 | 古籍書目資料 | OGDL v1.0, **收費** |

Every one of those download URLs is on `www.ncl.edu.tw`, which returns 503 to
us — the whole host, homepage included. So the blocker is no longer permission
but reachability, and `docs/ncl-nbinet-followup.md` asks about exactly that.

This was missed for a day because the Primo discovery interface's `robots.txt`
was checked and the open-data catalogue was not, even though that catalogue is
where dataset 6730 came from. Check the official channel before concluding a
source is closed.

Two scraping routes are closed and should stay closed:

- **HKALL** requires a login, is members-only, and its OAI-PMH endpoint codes
  are invalid; its records are OCLC-derived.
- **NBINet**, the Taiwan union catalogue, now runs on a hosted Ex Libris Primo
  whose `robots.txt` disallows `/primaws`, the only machine-readable path. Its
  records are exactly what this project wants — MARC21 out of Alma, with titles
  in real Chinese characters, millions of them — which makes asking worthwhile
  and scraping not.

The open route is asking. `docs/ncl-data-request.md` has been sent to the NCL;
`docs/ncl-nbinet-followup.md` is drafted as a reply on that thread, making the
NBINet case — it runs on Alma, so an OAI-PMH set or a publishing profile is a
setting they already have rather than a project. `docs/julac-data-request.md`
is drafted and unsent.

Re-probed on 6 November 2026 from a different network, to rule out the earlier
throttling having distorted the result: `202401_isbn.csv` serves 1,399,632
bytes and every month before it returns a clean 404 of 196 bytes. The floor is
the archive, not us being refused, and no amount of different infrastructure
changes it.

**Help wanted** on other sources. If you know a catalogue — a national library,
a regional union catalogue, a publishers' association — that publishes
bibliographic data under terms that allow reuse, open an issue. Adding it is a
self-contained adapter; see CONTRIBUTING.md.

Also open: `data.gov.tw`'s dataset *search* API needs a free registered key
(`ER0001:API Key錯誤`). With one, the whole open-data catalogue could be swept
for NCL bibliographic datasets instead of guessing at dataset numbers the way
6730 was found.

---

## 7. A catalogue rebuild leaves search on the previous snapshot

**Labels:** `ci`, `search`, `needs decision`

`.github/workflows/rebuild.yml` runs the whole pipeline — import, covers,
`build:db`, upload to R2, commit, publish — and never touches D1. Book pages
and browse views read the new database from R2 immediately. Search is answered
by `workers/search/index.js` over D1, which still holds whatever was imported
last. So after every rebuild the two halves of the site disagree, and nothing
says so: no error, no warning, just searches that miss new records and facet
counts that do not match the browse pages beside them.

### Why it has not simply been wired up

A full re-import does not fit the free plan, and the limit that binds is
writes, not reads. Measured against the live database:

| step | writes |
|---|---|
| data inserts (`books`, `books_fts`, `facet_counts`) | 987,931 |
| index builds (8 on `books`, 2 on `facet_counts`) | 3,760,222 |
| **total** | **4,748,153** |

The free plan allows 100,000 writes a day, so that is **47 days**. Workers
Paid includes 50,000,000 a month, where the same import is 9.5% of one
month's allowance.

For the record, because the first diagnosis here was wrong: `ANALYZE` on D1
measured 7,807,450 *rows read*, which is 1.6 days of the 5,000,000/day read
allowance, and it looked like the blocker. It was not — the writes are 30×
worse. `ANALYZE` has since been removed from the import path anyway, by
shipping `sqlite_stat1` from the build (`tools/build-d1.js`, `emitStats`), so
this issue is purely about write volume.

### Options

- **Workers Paid.** A full re-import becomes 9.5% of a month and `rebuild.yml`
  grows one more step, gated so a failure cannot leave a half-applied
  database. `import.sh` is already resumable and records each applied chunk,
  which is most of what that gate needs.
- **Incremental sync.** Write only what changed. The three `Rebuild catalogue`
  commits in this repository's history each changed 18 lines of `site/data`
  and reported identical counts, so a rebuild with no new source data changes
  almost nothing, and a monthly one changes a few thousand records. Needs a
  per-record content hash to diff against, delete-and-reinsert in the
  contentless FTS table (possible because `books` still holds the text that a
  contentless table does not), and a diffed `facet_counts` update rather than
  the current wholesale replacement — `facet_counts` is 95,751 rows and would
  otherwise dominate the delta. A routine month looks like roughly 100,000
  writes, which is exactly one free day, so the margin is thin. And the first
  schema change still forces a full re-import that the free plan cannot do.
- **Keep it manual.** Run `node tools/build-d1.js` and `sh tools/d1/import.sh`
  from a machine with the credentials, over as many days as the write
  allowance takes, and accept that search is stale in between. This is the
  status quo, undocumented until now.

### Not a free-plan problem to optimise away

446,090 records cost 446,090 writes however they are indexed; dropping
indexes trims the 3.76M but not the floor. The read side, by contrast, is
comfortably within the free plan: 1,225 rows read per API request measured on
the live database, supporting roughly 4,000 requests a day, and 761
single-filter views are precomputed static files that never reach D1 at all.

**Needs a decision from the maintainer** before any of it is worth building.
Storage is the other clock: the database is 342 MB of the free plan's 500 MB
ceiling, with room for about 206,000 more records.
