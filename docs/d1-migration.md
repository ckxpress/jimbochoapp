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

```sh
npx wrangler d1 create jimbocho-search --location apac
```

Put the printed `database_id` into `workers/search/wrangler.toml`, then:

```sh
npx wrangler d1 execute jimbocho-search --remote --command "
CREATE VIRTUAL TABLE probe USING fts5(search, content='', tokenize=\"unicode61 remove_diacritics 2\");
INSERT INTO probe(rowid, search) VALUES (1, '香港 港文 文學');
INSERT INTO probe(rowid, search) VALUES (2, '香港 港文 文學 文學 研究');
INSERT INTO probe(rowid, search) VALUES (3, '台灣 灣文 文學');
SELECT rowid, bm25(probe) AS score FROM probe WHERE probe MATCH '\"香港\" AND \"文學\"' ORDER BY bm25(probe);
"
```

Two rows back, with **two different scores**, means all three answers are yes.
One score repeated means bm25 is not normalising and ranking will be no better
than insertion order — stop and reconsider before importing anything.

```sh
npx wrangler d1 execute jimbocho-search --remote --command "DROP TABLE probe;"
```

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

## Still to do

- The client switch: `site/app.js` gains a `D1Source` alongside `SqliteSource`,
  chosen when the manifest names an API, falling back to the file if the API
  is unreachable. Not written yet — it should wait until the probe and a
  measured query from Hong Kong say this is worth finishing.
- Rebuild flow: `.github/workflows/rebuild.yml` currently builds the file and
  uploads to R2. It will need the D1 import too, or the two will drift.
- Retire what becomes dead: once search and filtered browse are served by the
  API, the 761 precomputed scope pages and `data/facet/publisher.json` are
  only needed for the offline fallback.
