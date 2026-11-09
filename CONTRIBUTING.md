# Contributing to 神保町 · jimbocho.app

A static catalogue of Hong Kong and Taiwan book metadata — **446,090 books**
across 16 datasets as of 6 November 2026, aiming eventually at every book
published in both places.

No framework, no npm dependencies, no build step for the site itself. Every
script uses Node built-ins. If `npm install` ever becomes necessary, something
has gone wrong.

---

## Running it

**You need no credentials for anything in this guide.** Deploying needs them;
everything else does not.

### In the browser (works on an iPad)

Click **Code → Codespaces → Create codespace** on GitHub. `.devcontainer/`
brings up Node 22 and the sqlite3 CLI with FTS5, and forwards port 8080. Then:

```bash
npm start
```

This is the only way to work on the project from a tablet: the catalogue cannot
be built on iPadOS — no Node, no sqlite3, and a `VACUUM` over a 496 MB database.

### Locally

```bash
git clone git@github.com:ckxpress/jimbochoapp.git
cd jimbochoapp
npm start          # http://localhost:8080
```

Node 12+ and, for database work, `sqlite3` built with FTS5 (`apt install
sqlite3`; macOS ships one).

`npm start` needs no build. The committed manifest points at the published
database in R2, which is public, so the site comes up with all 446,090 books
and you can work on the interface immediately.

### A smaller clone (site work only)

The 156 `site/data/*.full.*.json` shards are 477 MiB of a 769 MiB clone, and
nothing that runs the site reads them — `tools/publish-dir.sh` strips them from
every deploy. A blobless partial clone plus sparse-checkout never fetches them:

```bash
git clone --filter=blob:none --no-checkout https://github.com/ckxpress/jimbochoapp.git
cd jimbochoapp
git sparse-checkout set --no-cone '/*' '!/site/data/*.full.*.json'
git checkout
```

Measured on 6355938, 9 November 2026: **37.9 MiB transferred and 229 MiB on
disk, against 100.1 MiB and 769 MiB for a plain `git clone`.** All 113 commits
are there, the shards stay tracked, and `npm start` works unchanged. Most of
that is a disk saving rather than a bandwidth one — the shards are JSON and
pack at 9.7:1, so they account for only 49 MiB of the transfer.
(`--filter=blob:none` needs server-side filtering, which GitHub supports.)

Run `git sparse-checkout disable` to fill the clone in — about ten seconds and
the remaining 50 MiB — if you are building the catalogue, since
`npm run build:db` reads the shards, or working on the book page: on localhost
the site runs in JSON-shard mode, because the R2 bucket's CORS policy allows
only `https://jimbocho.app`, and a detail page then shows the index row's 8
fields instead of all 17.

### Working on the data

```bash
npm run import                            # re-fetch and normalise every dataset
npm run import -- --list                  # what is registered
npm run build:db -- --db-url ""            # build a LOCAL database
npm start
```

`--db-url ""` is the important part. Without it the build keeps the previous
manifest's URL, and your local site would query the published database while
your local shards say something else. Pass it and `tools/serve.js` serves the
database you just built.

Do not run `npm run covers` casually. It probes Google Books once per ISBN —
538,066 of them — and the results are committed in `cache/covers.json` so
nobody has to repeat it. A normal run only probes ISBNs that are new.

---

## The four constraints that shape everything

These are not style preferences. Each one was found by breaking it.

### 1. The database must stay under 512 MB

Cloudflare's maximum cacheable file size is 512 MB on Free, Pro and Business,
and it is checked against the **complete** size in `Content-Range` — asking for
a 32 KiB range does not get around it. Past it, every range request is answered
from origin with `cf-cache-status: BYPASS` however the Cache Rule is written.

Measured: at 729 MB a search took ~46 s for every reader every time. At 441 MB
the same search is **0.9 s** once the edge holds those ranges. It is the
difference between having a cache and not having one, not a few hundred
milliseconds.

The database is 496.2 MB. That leaves about 14,000 more books. The next lever
is deflating the `docs` blob (~496 → ~400 MB), which browsers inflate natively
with `DecompressionStream`.

### 2. The published site must stay small

"Published GitHub Pages sites may be no larger than 1 GB" and "GitHub Pages
deployments will timeout if they take longer than 10 minutes." A 462 MB deploy
failed at 10m14s and the site silently kept serving the previous build.

So `tools/deploy.sh` and `tools/publish-dir.sh` withhold the `*.full.*.json`
shards — 500 MB that a working site never fetches. They exist for the JSON
fallback's detail view and for the build and cover scripts, which read them
from the repository rather than over HTTP. The published site is 153 MB.

If you add data, check what the deploy prints: `publishing N files, M MB`.

### 3. The cost model is serial round trips, not bytes

The site queries SQLite over HTTP range requests. SQLite cannot ask for page
N+1 before it has read the page that points at it, so the wait is latency times
depth. **Count requests, not megabytes** — the request count is the same
everywhere, and you multiply it by your reader's latency.

To see them:

```bash
LOG_RANGES=1 npm start
```

Every range is printed with its size, its page offset and a running total. A
page number maps back to a table or index through `dbstat`:

```sql
SELECT name, count(*) FROM dbstat WHERE pageno BETWEEN 10900 AND 17700 GROUP BY name;
```

That is how every performance problem here has been diagnosed. Reducing bytes
while increasing requests is a regression: dropping the read-ahead cap from
256 KiB to 64 KiB cut 13.9 MB to 11.3 MB and took requests from 177 to 248.

### 4. Shared code is shared on purpose

Two files live under `site/` and are required by the build through a one-line
re-export in `tools/lib/`:

- **`site/tokenize.js`** — CJK bigram tokenisation. A query must be tokenised
  exactly as the index was, or `香港` matches nothing.
- **`site/derive.js`** — the generated description and rights statement. The
  database no longer stores them; the browser computes them. Two copies of a
  formatting rule drift, and the page would start describing books differently
  from the way the build described them.

Change either and you change both consumers. That is the point.

---

## What needs doing

[`docs/open-issues.md`](docs/open-issues.md) holds the current open work,
drafted as issues, with the measurements behind each one. Two are marked as
good first issues: they are self-contained and need no decision from anyone.

If none of it appeals, adding a catalogue is the most useful thing here and is
entirely self-contained.

---

## Adding a dataset

This is the most useful thing a contributor can do, and it is self-contained.

An adapter is a module in `tools/adapters/` exporting `parse(ctx)`, which turns
a fetched file into records via the shared `buildRecord`:

```js
'use strict';
const { buildRecord } = require('../lib/record');

function parse(ctx) {
  // ctx.text is the fetched file; ctx.source describes where it came from.
  return rows.map((row) => buildRecord({ title, authors, publisher, year, isbn, /* … */ }, ctx));
}

module.exports = { parse, id: 'my-source', label: 'Human-readable name' };
```

Read `tools/adapters/ncl-isbn.js` first — it is the clearest, and its comments
explain the decisions a real source forces (a month-only publication date
written `2026-01-00`, parallel-text languages, a shelving category that has to
line up with another catalogue's).

Then register it:

```bash
npm run import -- --url https://host/file.csv --id my-source --title "My source" --adapter my-source
```

**Three things to get right**, each of which has gone wrong here:

- **Verify the filter actually filtered.** An Open Library import produced
  33,500 non-Hong-Kong records and reported success, because requesting a field
  means naming it with an empty value, which cleared the filter on the same
  field. The tell — every page returning exactly 500 rows, including for a
  6-edition spelling — was on screen and went unread. Check a sample by hand.
- **Check the titles are in the script you expect.** `ol-hk` is 4%
  Chinese-character titles, and a CJK query cannot match a romanised title, so
  21,188 records are nearly unsearchable. Measure before importing at scale.
- **Keep it as its own dataset.** Datasets are never merged. Provenance is
  shown per record and a bad import can be removed cleanly.

---

## What not to do

**Do not work around a source that has refused you.** HKALL requires a login
and is members-only. NBINet's union catalogue is a hosted Primo whose
`robots.txt` disallows `/primaws`, the only machine-readable path — so it is
off limits, even though its records are exactly what this project wants. Asking
the library is the open route; `docs/ncl-data-request.md` and
`docs/julac-data-request.md` are the letters.

**Do not disguise the client to get past a block.** The importer's browser
user-agent is a documented decision about a specific catalogue that answers
this project's own identifier with a 404 page. It is not a licence to spoof
past a 503, and rotating addresses is not either.

**Mind the module constants in `tools/build-sqlite.js`.** `main()` is called at
module level, and `const` is not hoisted, so a constant declared below that
call is in the temporal dead zone and throws at run time. This has broken the
build four times. Every module-level `const` goes above `main()`.

---

## Deploying

Maintainer only — it needs R2 credentials and GitHub Pages write access.

```bash
npm run build:db -- --db-url https://db.jimbocho.app/   # content-hashed object name
npm run upload:db                                       # R2, over the S3 API
git push origin main && npm run deploy                  # the site, after the database
```

The order matters. The manifest advertises the database's exact byte length,
and the startup probe only reads one row near the head of the file — so a site
published ahead of its database fails silently at the facet tables in the tail.
The content-hashed object name is what makes this safe: the live site keeps
reading the old object until the new one is up, and no stale edge-cache entry
can shadow it.

`.github/workflows/rebuild.yml` does all of it from the Actions tab, which is
how the project is driven without a computer. It runs as three jobs —
`rebuild`, then `publish`, then `prune` — so that only the deployment is gated
on the `github-pages` environment, and so superseded database objects are
removed only once the new one is actually live.

Every rebuild writes a new R2 object, because the name carries the database's
content hash, and a CI build hashes differently from a laptop build of the same
data: sqlite packs pages differently between versions. `tools/prune-r2.sh`
keeps the live object and one rollback. On its own it lists and deletes
nothing; `--confirm` is what deletes, and it refuses outright if it cannot tell
which object the manifest names.
