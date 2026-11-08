# Moving search to D1

## Why

The site answers a search by reading a 473 MB SQLite file in R2 over HTTP
range requests, from the browser. Browsing is fast because the build
precomputes a page per scope. Everything else is serial round trips, and
serial round trips cost latency times depth however good the connection is.

Measured on Hutchison 4G in Hong Kong, which is the reader this is for:

| | |
|---|---|
| per range request | 130 ms (50–90 ms by curl; the browser adds its own overhead) |
| cold search | ~49 requests, ~6.2 s |
| publisher outside the precomputed 312 | **over 45 s** |

The last line is the one that forced this. The build precomputes a scope page
for 312 publishers — those with ~200 books or more, 47.1% of the catalogue.
The other **37,741 publishers, 52.9% of books**, fall through to the database,
where counting facets means fetching every matching row, one round trip each.
Precomputing all of them would need 1,163 MB, past the 1 GB GitHub Pages
hosts. The problem grows with the catalogue, and the goal is a million books.

Server-side, a search is one round trip: ~0.2–0.3 s on the same connection.

## Shape

Only search and filtered browse move. The landing view and the precomputed
scope pages still answer from static files — they are already one request —
and the `docs` blob stays in R2, still read by the book page. That keeps the
D1 database to `books` + the FTS index, about **155 MB**, inside the free
tier's 500 MB per-database limit.

```
browser ──► jimbocho.app (static)      landing view, scope pages, book page
        └─► api.jimbocho.app (Worker) ─► D1   search, filtered browse, facets
```

## Before the full import: a five-minute probe

Three assumptions could sink this, and each is cheap to test. Do not skip to
the import.

1. **Does D1 have FTS5?** Cloudflare's docs say yes; a third-party post says
   no. Settle it.
2. **Does `bm25()` rank properly there?** Ranking collapses without the
   `%_docsize` shadow table, and that was measured here: 2 distinct scores
   across 9,708 matches instead of 58.
3. **Does a Hong Kong reader reach an `apac` replica?** A location hint is
   explicitly not a guarantee.

### Authenticate with a scoped token, not OAuth

`wrangler login` asks for an OAuth grant covering Workers, Pages, D1, queues,
email routing, containers and more — wrangler's standard scope set, far wider
than anything here needs, and tied to the logged-in user rather than to this
task. Wrangler skips OAuth entirely when it finds a token in the environment,
so use one scoped to the job, the way the R2 upload token already is.

Create it at **dash.cloudflare.com → My Profile → API Tokens → Create Token →
Create Custom Token**, and grant only:

| phase | permission | scope |
|---|---|---|
| probe and import | **Account → D1 : Edit** | this account only |
| deploying the Worker | add **Account → Workers Scripts : Edit** | this account only |
| custom domain on the Worker | add **Zone → Workers Routes : Edit** and **Zone → Zone : Read** | the `jimbocho.app` zone only |

Set *Account Resources* to include the one account rather than "All accounts",
and for the zone rows name the single zone. A TTL and an IP filter are both
worth setting while the work is in progress.

Start with D1 : Edit alone — nothing before the deploy step needs more. If
`--remote` fails with error 10000, a community report says **Account Settings
: Read** is also required; add that one permission and no others.

Then, in the shell that will run wrangler (`read -s` keeps the token out of
shell history and off the screen):

```sh
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID=<account id from the dashboard URL>
npx wrangler whoami    # should name the account without opening a browser
```

CI gets its own token, not this one: when `rebuild.yml` learns to run the D1
import it needs **D1 : Edit** only, stored as a repository secret, so either
token can be revoked without disturbing the other.

```sh
npx wrangler d1 create jimbocho-search --location apac
```

Put the printed `database_id` into `workers/search/wrangler.toml`, then:

```sh
npx wrangler d1 execute jimbocho-search --remote --file=tools/d1/probe.sql
npx wrangler d1 execute jimbocho-search --remote --command "SELECT rowid, bm25(probe) AS score FROM probe WHERE probe MATCH '香港 AND 文學' ORDER BY bm25(probe);"
npx wrangler d1 execute jimbocho-search --remote --command "DROP TABLE probe;"
```

The setup is a file and the question is a `--command` on purpose: `--file`
goes through D1's import path, which reports that it ran seven queries and
read ten rows but discards the rows themselves — so the one thing the probe
exists to show never reaches the screen.

The MATCH expression is unquoted (`香港 AND 文學`, not `"香港" AND "文學"`).
Checked against stock SQLite, the two forms give identical scores, and the
unquoted one survives a trip through shell quoting intact.

Stock SQLite 3.54.0 answers:

```
1|-2.288e-06
2|-2.1872321961273526e-06
```

Two rows, two **different** scores, the shorter document ranked first — that
gap is length normalisation working. The same shape from D1 means go. The
same score twice means bm25 is not normalising there and ranking would be no
better than insertion order: stop, because importing 250 MB would not fix it.
An error on `CREATE VIRTUAL TABLE` means D1 has no FTS5 and the plan needs
rethinking from the top.

## The import

```sh
npm run build:db          # if site/data/books.db is not current
node tools/build-d1.js    # writes build/d1/*.sql + chunks.json
sh tools/d1/import.sh jimbocho-search
```

The export is chunked because D1 caps a single statement at 100 KB and remote
imports of a few megabytes are reported to time out with the data partly
landed. `import.sh` records each chunk that succeeds and skips it on a re-run,
so a 504 costs one chunk rather than the whole import.

**`books_fts` must never have a chunk applied twice.** It is contentless, so
there is no stored text to match an existing row against: a repeat indexes
every document in that chunk a second time, with no error and no constraint,
and every bm25 score afterwards is quietly wrong. The script's record of what
it applied is what prevents this. If the final counts disagree, drop
`books_fts` and re-import the `fts-*.sql` chunks rather than topping it up.

## Deploy

```sh
npx wrangler deploy --config workers/search/wrangler.toml
```

Then point `api.jimbocho.app` at the Worker (the `routes` entry in
`wrangler.toml` does this on first deploy if the zone is on the account).

## Turning it on

The client picks the API when the manifest has a top-level `api`:

```json
{ "api": "https://jimbocho-search.<subdomain>.workers.dev" }
```

Add it to `site/data/manifest.json` and deploy. `tools/build-sqlite.js`
rewrites that file on every rebuild but only replaces the keys it owns, so
the value survives — the same way `db.url` does.

To turn it off, delete the key: the site goes back to reading the file over
range requests, which still works and is still correct, only slow for
anything the build did not precompute.

Measured on Hutchison 4G in Hong Kong, publisher 寂天文化 — 197 books, the
case the precomputed pages do not cover:

| | |
|---|---|
| reading the file over range requests | **over 45 s** |
| the Worker over D1 | **about 1 s** |

### What runs where

| | |
|---|---|
| landing view, precomputed scope pages | static files, unchanged |
| search, filtered browse, facet counts | the API |
| book page (`docs` blob) | the file in R2, opened lazily |
| API unreachable | falls back to the file, with a warning in the console |

`npm start` serves `/api/search` itself, from `site/data/books.db`, using the
Worker's own `buildWhere()`, `order()` and `COLUMNS` — see
`tools/lib/dev-search-api.js`. Local development would otherwise have no API
to call at all, since the deployed Worker only allows the jimbocho.app origin.

## Still to do
- Rebuild flow: `.github/workflows/rebuild.yml` currently builds the file and
  uploads to R2. It will need the D1 import too, or the two will drift.
- Retire what becomes dead: once search and filtered browse are served by the
  API, the 761 precomputed scope pages and `data/facet/publisher.json` are
  only needed for the offline fallback.
