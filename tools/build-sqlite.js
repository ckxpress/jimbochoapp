#!/usr/bin/env node
'use strict';

/**
 * Builds site/data/books.db from the imported records, so the browser can
 * query the catalogue over HTTP range requests instead of downloading every
 * record up front. Run after `npm run import`:
 *
 *   npm run build:db
 *
 * Needs the sqlite3 CLI (ships with macOS; `apt install sqlite3` elsewhere)
 * with FTS5 — checked before anything is written.
 *
 * The database is too big to serve from GitHub Pages, which compresses it and
 * then applies byte ranges to the *compressed* stream. Point the site at
 * object storage instead, once:
 *
 *   npm run build:db -- --db-url https://db.example.com/
 *
 * A URL ending in "/" is treated as a base, and each build appends the
 * database's own content hash — books-8b4c50cb.db — so a rebuilt database never
 * reuses a name, and no stale CDN cache entry can shadow it. Pass a full URL
 * instead to pin one exact name.
 *
 * The URL is remembered in the manifest, so later rebuilds need no flag.
 * `--db-url ""` clears it and goes back to serving books.db beside the site.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');

const { indexTokens } = require('./lib/tokenize');
const { encodeDoc } = require('./lib/doc-codec');
const zlib = require('zlib');
const { SQL_FACET, FACET_LIMIT, FACET_FULL_LIST } = require('../site/schema.js');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'site', 'data');
const DB = path.join(DATA_DIR, 'books.db');

// The page size decides how deep the B-trees are and how many rows share a
// page, and over range requests both land on the serial request count — the
// thing that actually costs time, because SQLite cannot ask for a page until
// it has read the page pointing at it. 1 KiB pages put ~3 books on a page, so
// sixty scattered rows meant sixty round trips; 4 KiB puts ~13 on a page and
// shortens every descent.
const PAGE_SIZE = 4096;

// How much the browser fetches per request. Larger than a page, so one request
// covers several: round trips cost far more than the extra bytes, so this is
// tuned for the fewest requests that does not start wasting whole megabytes.
// Measured on a search for 香港, at 4 KiB pages:
//
//    8 KiB chunk → 103 requests, 3.02 MB
//   16 KiB chunk →  85 requests, 3.46 MB
//   32 KiB chunk →  69 requests, 4.11 MB   ← here
//   64 KiB chunk →  60 requests, 5.93 MB
//
// Past 32 KiB the request count barely moves while the bytes climb steeply.
const CHUNK_SIZE = PAGE_SIZE * 8;

/**
 * How far the VFS may run ahead once it decides reads look sequential.
 *
 * Its own default is 5 MiB, and the heuristic misfires badly on this access
 * pattern: fetching a few hundred scattered rows in ascending rowid order
 * looks sequential to it, so it prefetches megabytes of neighbouring pages no
 * query asked for. At 288,230 books a search read 37.9 MB, of which about
 * 35 MB was that overshoot; capped here it is nearer 7 MB.
 *
 * 256 KiB rather than a tuned figure on purpose. Repeated runs of the same
 * search at the same setting came back 4.9, 8.1 and 8.1 MB — the VFS keeps
 * three read heads and which one serves a page depends on interleaving — so
 * anything finer than "much smaller than 5 MiB" would be tuning to noise.
 */
const MAX_READ_BYTES = 262144;

// Matches PAGE_SIZE in site/app.js — the first screenful the browser renders.
const FIRST_PAGE_ROWS = 60;

/**
 * The facets the builder works out counts for at build time, so the common
 * views never aggregate over the network.
 *
 * A facet_counts `scope` is '' for the whole catalogue, or "<facet>:<value>"
 * for a view narrowed by exactly one facet. Only facets whose values select
 * large slices are worth a scope — a language, a dataset (a year of one
 * country) and a year each run to tens of thousands of rows, and aggregating
 * one live means reading every matching row off the table: filtering to one
 * dataset of 62,326 cost 15 MB before this. The rest (publisher,
 * classification, 發佈期間…) select small enough slices to count live.
 *
 * Declared here with the other top-level constants because main() runs as this
 * module loads, before anything declared further down is initialised.
 */
/*
 * Facets whose every value gets a precomputed scope. The bar is simply how
 * many distinct values there are: 10 languages, 16 datasets, 213 years, 156
 * release files, 3 availability states, 2 identifier states.
 *
 * source, availability and identifier were missing, and they hold the largest
 * slices in the catalogue — 來源 = ncl-holdings#0 is 118,153 records and
 * 識別號 = has an ISBN is 367,305. Filtering by either ran eight live
 * aggregations over every matching row, which is what made 東立's 8,972 never
 * return before publisher was scoped. These would have been fourteen and forty
 * times worse.
 */
const SCOPE_FACETS = ['language', 'dataset', 'year', 'source', 'availability', 'identifier'];

/**
 * Facets with too many values to precompute every scope, and the size at which
 * a scope earns one.
 *
 * There are 38,053 publishers and 1,149 classifications, so scoping them all
 * would be absurd. But only 312 publishers and 51 classifications have 200
 * records or more, and those 312 account for 200,237 of the
 * 446,090 records — 45% of the catalogue in 0.8% of the publishers. Below that
 * threshold the live aggregation reads fewer than 200 rows and is fine.
 *
 * This is what made clicking 東立 (8,972 records) never return: eight facets,
 * each fetching all 8,972 rows across the network to read one column.
 */
const BIG_SCOPE_FACETS = { publisher: 200, classification: 200 };

/**
 * What `docs` has to carry: the fields of a record that the `books` table does
 * not already hold, and nothing else.
 *
 * `docs` was the whole record as JSON — 1,240 bytes a row, 436 MB, 60% of the
 * database — and most of it was a second copy of columns beside it. The detail
 * view now reads the row and this blob together, so each field is stored once.
 *
 * Three groups come out:
 *
 *  - Columns `books` has. The browser reads them from the row it already
 *    fetched for the card, so repeating them bought nothing.
 *  - `source`, which `books` normalises into a `src` integer against a table
 *    of sources. Spelling the label and URL out per record cost more than the
 *    whole source table.
 *  - `description` and `copyright` *when derived*. They are a pure function of
 *    fields the browser has, and site/derive.js computes them identically —
 *    verified against 3,000 of the stored ones, byte for byte. A description
 *    that came from the dataset itself is real data and stays.
 *
 * This is what keeps the database under Cloudflare's 512 MB cacheable
 * ceiling, past which every range request is served from origin.
 */
const DOC_DROP = [
  'id', 'dataset', 'title', 'parallelTitle', 'titleDisplay', 'subtitle',
  'publisher', 'year', 'isbn', 'classification', 'language', 'ref', 'cover',
  'forsale', 'source',
];

/*
 * Three that stay, because `books` flattens them and the flattening is lossy.
 * Measured over 5,000 records:
 *
 *  - `series`: the column holds `series.title`, while the description reads
 *    `series.raw`. They differ for 107 of 363 records that have a series, so
 *    the browser would describe those books differently from the way the
 *    build described them.
 *  - `authors`: the column is `(a.display || a.name)` joined, which renders
 *    correctly but loses `name` — and `name` is what an author search link
 *    points at. 438 of 8,562 author entries have the two differing.
 *  - `price`: the column is the numeric amount, and 484 of 4,963 priced
 *    records carry only a raw string instead ("Unpriced", "$38.00;
 *    Unpriced"). Dropped, those books would show no price at all.
 *
 * Keeping them costs about 24 MB, against a 100 MB margin under the ceiling.
 */

function thinDoc(rec) {
  const out = {};
  for (const key of Object.keys(rec)) {
    if (DOC_DROP.indexOf(key) !== -1) continue;
    if ((key === 'description' || key === 'copyright') && rec[key] && rec[key].source === 'derived') continue;
    out[key] = rec[key];
  }
  return out;
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

main();

function main() {
  requireSqlite();

  const args = process.argv.slice(2);
  const at = args.indexOf('--db-url');
  if (at !== -1 && at === args.length - 1) {
    throw new Error('--db-url needs a value (use --db-url "" to serve books.db from the site itself).');
  }
  const dbUrlArg = at === -1 ? undefined : args[at + 1];

  const manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'manifest.json'), 'utf8'));
  if (!manifest.datasets || !manifest.datasets.length) throw new Error('No datasets imported yet — run `npm run import` first.');

  const sqlFile = path.join(DATA_DIR, '.build.sql');
  const fd = fs.openSync(sqlFile, 'w');

  fs.writeSync(fd, schema());

  let rowid = 0;
  let total = 0;

  for (const ds of manifest.datasets) {
    let count = 0;
    let batch = '';
    for (const file of ds.files.full) {
      const records = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
      for (const rec of records) {
        rowid++;
        count++;
        batch += insertBook(rowid, rec, ds);
        if (batch.length > 1 << 20) {
          fs.writeSync(fd, batch);
          batch = '';
        }
      }
    }
    if (batch) fs.writeSync(fd, batch);
    total += count;
    console.log('  ' + pad(ds.id, 20) + String(count).padStart(8) + ' rows');
  }

  fs.writeSync(fd, finalise());
  fs.closeSync(fd);

  if (fs.existsSync(DB)) fs.unlinkSync(DB);
  console.log('\nBuilding ' + path.relative(ROOT, DB) + ' …');

  const res = spawnSync('sqlite3', [DB], { input: fs.readFileSync(sqlFile), stdio: ['pipe', 'inherit', 'inherit'] });
  fs.unlinkSync(sqlFile);
  if (res.status !== 0) throw new Error('sqlite3 exited with code ' + res.status);

  const size = fs.statSync(DB).size;
  const pages = execFileSync('sqlite3', [DB, 'PRAGMA page_count;']).toString().trim();

  // The manifest tells the site to use the database instead of JSON shards.
  // A known value the browser re-reads on startup to prove the transport is
  // sound. Some hosts (GitHub Pages) compress the file and then apply byte
  // ranges to the *compressed* stream, which yields a readable-looking
  // database that answers queries wrongly. Better to detect that than to
  // show a visitor silently incorrect results.
  const probeId = execFileSync('sqlite3', [DB, 'SELECT id FROM books WHERE rowid = 1;']).toString().trim();

  // An existing url survives a rebuild: the database is uploaded separately
  // from the site, so re-running the build must not quietly point the app
  // back at a books.db that was never deployed.
  const previousUrl = manifest.db && manifest.db.url;
  const configured = dbUrlArg === undefined ? previousUrl : dbUrlArg || undefined;

  // The content hash goes in the object name. Two things make this worth the
  // trouble: the edge cache outlives the object (a Cache Rule holds a deleted
  // or replaced file for as long as its TTL, so reusing one name can serve old
  // bytes under a new manifest's byte length for weeks), and the site and the
  // database deploy separately, so the running site must keep reading the
  // object it was built against until the new one is live.
  //
  // A url ending in "/" is a base to append the hashed name to; a full url is
  // used exactly as given, so an existing setup keeps working.
  const digest = crypto.createHash('md5').update(fs.readFileSync(DB)).digest('hex');
  const url = configured && configured.endsWith('/')
    ? configured + 'books-' + digest.slice(0, 8) + '.db'
    : configured;

  manifest.db = {
    file: 'books.db',
    bytes: size,
    md5: digest,
    pageSize: PAGE_SIZE,
    chunkBytes: CHUNK_SIZE,
    maxReadBytes: MAX_READ_BYTES,
    pages: Number(pages),
    probe: { rowid: 1, id: probeId },
    builtAt: new Date().toISOString(),
  };
  if (url) manifest.db.url = url;


  // The landing view is the same for every first-time reader, and answering it
  // from the database costs scattered range requests that SQLite must issue one
  // after another — it cannot ask for a page until it has read the page that
  // points at it. Serial round trips, so the wait is latency times depth, and
  // no amount of edge caching removes it.
  //
  // So the landing view is answered here instead, at build time, into a file
  // the site serves and the service worker caches like any other asset. First
  // paint then needs the database not at all; it is opened in the background
  // for the first search or filter.
  const precomputed = writeFirstPage();
  manifest.firstPage = precomputed.firstPage;
  manifest.pages = precomputed.pages;
  manifest.facetLists = writeFacetLists();
  manifest.duplicates = countDuplicates();
  fs.writeFileSync(path.join(DATA_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(
    '\n✓ ' + total.toLocaleString('en-US') + ' books → ' + (size / 1048576).toFixed(1) + ' MB, ' +
      Number(pages).toLocaleString('en-US') + ' pages of ' + PAGE_SIZE + ' bytes'
  );
  if (url) {
    console.log('  Served from ' + url);
    console.log(
      '  Upload site/data/books.db as "' + url.slice(url.lastIndexOf('/') + 1) +
        '", or the site keeps reading the old one.'
    );
    console.log('  md5 ' + digest + ' — R2 shows this as the object\'s etag.');
  } else {
    console.log('  Served from the site itself — note GitHub Pages cannot do this correctly.');
  }
  console.log('  The site queries it by range request; JSON shards remain as a fallback.');
}

function schema() {
  return [
    'PRAGMA journal_mode = delete;',
    'PRAGMA page_size = ' + PAGE_SIZE + ';',
    'BEGIN;',
    `CREATE TABLE books (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      dataset TEXT,
      title TEXT,
      parallel_title TEXT,
      title_display TEXT,
      zh_first INTEGER,
      subtitle TEXT,
      authors TEXT,
      publisher TEXT,
      year INTEGER,
      isbn TEXT,
      classification TEXT,
      language TEXT,
      series TEXT,
      ref TEXT,
      src INTEGER,
      price REAL,
      currency TEXT,
      forsale INTEGER,
      cover TEXT
    );`,
    // Full records live apart from the browse columns: a facet count or a
    // sort scans `books`, and dragging every record's JSON through those
    // pages would cost megabytes per query.
    'CREATE TABLE docs (rowid INTEGER PRIMARY KEY, doc TEXT NOT NULL);',
    // Contentless: the index holds tokens only, never a second copy of the text.
    `CREATE VIRTUAL TABLE books_fts USING fts5(
      search, content='', tokenize="unicode61 remove_diacritics 2"
    );`,
  ].join('\n');
}

function insertBook(rowid, rec, ds) {
  const authors = (rec.authors || []).map((a) => a.display || a.name).join(', ');
  const series = rec.series ? rec.series.title : '';
  const price = rec.price && typeof rec.price.amount === 'number' ? rec.price.amount : null;
  const forsale = rec.price && typeof rec.price.forSale === 'boolean' ? (rec.price.forSale ? 1 : 0) : null;

  const values = [
    rowid,
    str(rec.id),
    str(rec.dataset || ds.id),
    str(rec.title),
    str(rec.parallelTitle),
    str(displayTitleOf(rec)),
    hasCjk(displayTitleOf(rec)) ? 0 : 1,
    str(rec.subtitle),
    str(authors),
    str(rec.publisher),
    rec.year ? Number(rec.year) : 'NULL',
    str(rec.isbn),
    str(rec.classification),
    str(rec.language),
    str(series),
    str(rec.ref),
    Number(rec.sourceIndex || indexOfSource(rec, ds)),
    price === null ? 'NULL' : price,
    str(rec.price ? rec.price.currency : ''),
    forsale === null ? 'NULL' : forsale,
    str(rec.cover ? rec.cover.url : ''),
  ];

  const tokens = indexTokens(
    [rec.title, rec.subtitle, rec.parallelTitle, authors, rec.publisher, series, rec.classification, rec.isbn, rec.ref, rec.year]
      .filter(Boolean)
      .join(' ')
  ).join(' ');

  return (
    'INSERT INTO books VALUES (' + values.join(',') + ');\n' +
    'INSERT INTO docs VALUES (' + rowid + ',' + blob(thinDoc(rec)) + ');\n' +
    'INSERT INTO books_fts(rowid, search) VALUES (' + rowid + ',' + str(tokens) + ');\n'
  );
}

/**
 * The docs payload: field names replaced by position, then deflated, and
 * written as a SQL blob literal. 393 bytes a row becomes 269.
 *
 * Raw deflate rather than zlib- or gzip-wrapped, because that is what the
 * browser's DecompressionStream('deflate-raw') reads, and the header would be
 * pure overhead on payloads this small.
 */
function blob(rec) {
  const json = Buffer.from(JSON.stringify(encodeDoc(rec)), 'utf8');
  return "X'" + zlib.deflateRawSync(json, { level: 9 }).toString('hex') + "'";
}

function hasCjk(text) {
  return CJK.test(text || '');
}

/**
 * The catalogue is published as separate Chinese and English volumes, and an
 * English record often carries the Chinese title as its parallel title. This
 * is a Traditional Chinese site, so the Chinese form is what gets displayed
 * and sorted on. Mirrors displayTitle() in site/app.js.
 */
function displayTitleOf(rec) {
  if (!hasCjk(rec.title) && hasCjk(rec.parallelTitle)) return rec.parallelTitle;
  return rec.title || '';
}

/** Records carry a source label; map it back to the dataset's source list. */
function indexOfSource(rec, ds) {
  if (!rec.source || !ds.sources) return 0;
  const at = ds.sources.findIndex((s) => s.label === rec.source.label);
  return at === -1 ? 0 : at;
}

/**
 * Counts computed once here instead of by GROUP BY in the browser. The
 * opening view needs every facet at once, and aggregating over the whole
 * table by range request costs megabytes; reading it back from this table
 * costs a few kilobytes.
 *
 * Two scopes are stored. '' is the whole catalogue. The rest are one per
 * language, because the site opens with a language already selected, and a
 * filtered facet cannot use the '' rows — it would report counts for books
 * the reader has filtered out. Without the language scopes that opening view
 * falls back to live aggregation: eight facets, each doing a full row fetch
 * for every matching book, which measured 7.75 MB of range traffic on a
 * catalogue of 25,385.
 *
 * The per-language rows are generated by one statement per facet whatever
 * the languages turn out to be, with ROW_NUMBER to apply the cap within each
 * language rather than across all of them.
 */
function precomputedFacets() {
  const lines = [
    'CREATE TABLE facet_counts (scope TEXT, facet TEXT, value TEXT, n INTEGER);',
  ];

  for (const key of Object.keys(SQL_FACET)) {
    const expr = SQL_FACET[key].replace(/\bb\./g, '');
    lines.push(
      "INSERT INTO facet_counts(scope, facet, value, n) SELECT '', '" + key + "', " + expr +
        ', COUNT(*) FROM books WHERE ' + expr + " <> '' GROUP BY 3 ORDER BY 4 DESC LIMIT " + FACET_LIMIT + ';'
    );
  }

  const scoped = SCOPE_FACETS.concat(Object.keys(BIG_SCOPE_FACETS));
  for (const scopeFacet of scoped) {
    const scopeExpr = SQL_FACET[scopeFacet].replace(/\bb\./g, '');
    // Big facets precompute only the scopes worth precomputing.
    const floor = BIG_SCOPE_FACETS[scopeFacet];
    const bigOnly = floor
      ? ' AND ' + scopeExpr + ' IN (SELECT ' + scopeExpr + ' FROM books WHERE ' + scopeExpr +
        " <> '' GROUP BY 1 HAVING COUNT(*) >= " + floor + ')'
      : '';
    for (const key of Object.keys(SQL_FACET)) {
      // A facet is never narrowed by a filter on itself — the reader has to be
      // able to see the other values to switch to one — so for that facet the
      // client reads the '' scope instead.
      if (key === scopeFacet) continue;
      const expr = SQL_FACET[key].replace(/\bb\./g, '');
      lines.push(
        'INSERT INTO facet_counts(scope, facet, value, n)\n' +
          'SELECT scope, facet, value, n FROM (\n' +
          "  SELECT '" + scopeFacet + ":' || " + scopeExpr + " AS scope, '" + key + "' AS facet,\n" +
          '         ' + expr + ' AS value, COUNT(*) AS n,\n' +
          '         ROW_NUMBER() OVER (PARTITION BY ' + scopeExpr + ' ORDER BY COUNT(*) DESC) AS rk\n' +
          '  FROM books WHERE ' + expr + " <> '' AND " + scopeExpr + " <> ''" + bigOnly + '\n' +
          '  GROUP BY ' + scopeExpr + ', value\n' +
          ') WHERE rk <= ' + FACET_LIMIT + ';'
      );
    }
  }

  lines.push('CREATE INDEX idx_facet ON facet_counts(scope, facet, n DESC);');
  return lines.join('\n');
}

function finalise() {
  return [
    '',
    precomputedFacets(),
    // Facet counting is GROUP BY, so every facet column needs an index.
    // Four single-column indexes used to sit here, on dataset, language,
    // classification and year. Each is the leading column of a composite that
    // already exists — idx_browse_dataset, idx_browse_lang, idx_browse_class,
    // idx_browse_year, and idx_src for dataset — and SQLite will use a
    // composite's prefix perfectly well. They cost 23.7 MB to duplicate
    // structures the file already carried.
    // idx_publisher, idx_title and idx_year_title were here. The first is now
    // the leading column of idx_browse_publisher below. The other two served a
    // sort path that cannot run: b.title is only ordered on when the zh_first
    // column is absent, and this build always writes it, so the ORDER BY is
    // always on title_display. 51.2 MB between them.
    'CREATE INDEX idx_src ON books(dataset, src);',
    'CREATE INDEX idx_forsale ON books(forsale);',
    'CREATE INDEX idx_isbn ON books(isbn);',
    'CREATE UNIQUE INDEX idx_id ON books(id);',
    // Browse order without a query: keeps the default listing off a full sort.
    // Default browse order: Chinese titles first, alphabetical within each group.
    'CREATE INDEX idx_zh_title ON books(zh_first, title_display);',

    // The default browse order, indexed as the expression the query actually
    // sorts by. Without these SQLite answers the opening page with SCAN +
    // TEMP B-TREE over every row, and over a range-request transport that
    // means dragging the whole table down the wire — 8.3 MB to show sixty
    // books. With them both plans are covering index walks that stop at the
    // LIMIT. The second one carries `language` because the site opens with
    // that facet applied.
    "CREATE INDEX idx_browse ON books(cover = '', zh_first, title_display);",
    "CREATE INDEX idx_browse_lang ON books(language, cover = '', zh_first, title_display);",

    // The same problem returns for any filter that selects a large slice: the
    // leading column has to be in the index, or SQLite reads every matching
    // row and sorts them. Measured at 288,230 books, filtering to one dataset
    // of 62,326 cost 15 MB and twenty-three requests to show sixty books.
    //
    // Only the facets whose values select tens of thousands of rows need this.
    // A dataset is a whole year of one country, a year likewise, and the
    // largest classifications run to 19,000; the biggest single publisher is
    // 8,226, which sorts cheaply enough not to be worth another index.
    "CREATE INDEX idx_browse_dataset ON books(dataset, cover = '', zh_first, title_display);",
    "CREATE INDEX idx_browse_year ON books(year, cover = '', zh_first, title_display);",
    "CREATE INDEX idx_browse_class ON books(classification, cover = '', zh_first, title_display);",
    // Filtering by publisher had no index that also satisfied the browse
    // order, so SQLite fetched every matching row — 8,972 of them for 東立,
    // each a separate range request — sorted them in a temp b-tree and
    // returned 60. The filter never finished. This is the same shape as the
    // four above, and it also lets the 出版者 sort use an index instead of
    // sorting the whole table.
    "CREATE INDEX idx_browse_publisher ON books(publisher, cover = '', zh_first, title_display);",

    // Every facet column in one index, so counting a facet against the other
    // active filters never has to fetch a row. The precomputed table only
    // answers the opening view; the moment a reader picks a publisher the
    // counts are aggregated live, and without this SQLite satisfies that by
    // reading thousands of scattered rows out of a 55 MB file — one click
    // measured 8.06 MB of range traffic, including a single 4 MB read.
    // Covered, the same work is a walk over a 2 MB index.
    // idx_facets_all was here: a 29.3 MB covering index over eight columns,
    // for a full-scan GROUP BY that counted facets. Nothing issues that shape
    // any more — browsing reads the precomputed facet_counts table, and a
    // search drives the counts from the FTS hits by rowid. It was created
    // after facet_counts had already been computed, so it never helped the
    // build either.
    'COMMIT;',

    // Merge the FTS index into a single segment.
    //
    // Not the same thing as `PRAGMA optimize`, which only refreshes the query
    // planner's statistics. FTS5 writes a new b-tree segment per batch of
    // inserts, and a term lookup has to visit every one of them: this index
    // was left with 7,881 segment blocks, so searching a rare term meant
    // dozens of scattered reads before any result was touched. Over range
    // requests each of those is a round trip, which is the whole cost — a
    // search returning four books still took 53 requests.
    //
    // Cheap to do here and never again: the database is built once and only
    // ever read.
    "INSERT INTO books_fts(books_fts) VALUES('optimize');",

    'VACUUM;',
    'PRAGMA optimize;',
    '',
  ].join('\n');
}

function requireSqlite() {
  const version = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) {
    throw new Error('sqlite3 CLI not found. Install it (macOS ships with it; `apt install sqlite3` on Debian/Ubuntu).');
  }
  const fts = spawnSync('sqlite3', [':memory:', "CREATE VIRTUAL TABLE t USING fts5(x); SELECT 1;"], { encoding: 'utf8' });
  if (fts.status !== 0) {
    throw new Error('This sqlite3 build lacks FTS5, which the search index needs.');
  }
  console.log('sqlite3 ' + version.stdout.trim().split(' ')[0] + ' with FTS5\n');
}

function str(value) {
  if (value === undefined || value === null) return "''";
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Precomputes the rows, totals and facet counts for the views a reader can
 * land on without touching anything: the whole catalogue, and each single
 * language on its own (the site defaults to Chinese).
 *
 * Columns are emitted under their database names so the browser can hand them
 * to the same mapping function it uses for a real query result — one code path
 * for both, so a precomputed card cannot render differently from a queried one.
 */
/**
 * The 60 books a reader sees before they have asked for anything.
 *
 * This used to be the first 60 of the browse order — `cover = '', zh_first,
 * title_display`. Sorting by the raw title sorts by code point, and `#` is
 * U+0023 and `(` is U+0028, below every digit, letter and CJK character. So
 * all 60 opening rows began with punctuation, none of them with a word, and
 * because series markers, volume numbers and `(全)` are where punctuation
 * lives, the catalogue's front door read as a manga shop — fifteen publishers
 * looking like one genre, with two adult titles among them.
 *
 * Filing the titles under a key that ignores leading punctuation, which is
 * what a library would do, is a real improvement and not a fix: it was
 * measured, and the first page simply became parenting books beginning with a
 * digit, 35 publishers instead of 15. Any total ordering makes its own first
 * page an artefact of itself. There is always a next tier of punctuation.
 *
 * So the landing view stops being a sort order. One book per publisher, each
 * publisher represented by a title that does not start with punctuation where
 * it has one, scattered deterministically by a slice of the id so the result
 * is stable between builds of the same data and varies when the data changes.
 * Measured on the current catalogue: 60 publishers, 8 datasets, 1902 to 2026,
 * and no punctuation-led title at all.
 *
 * Only this view. The other 761 scope pages keep the browse order, because a
 * reader who filters by one publisher is asking for that publisher's books in
 * order, and "one per publisher" means nothing there.
 */
function spreadSql(columns, where) {
  return (
    'WITH pool AS (SELECT ' + columns + ', ROW_NUMBER() OVER (' +
      'PARTITION BY b.publisher ORDER BY ' +
        // Within one publisher: a book with a real cover, then a title that
        // reads like a title rather than a series marker, then the recent one.
        "b.cover = '', (b.title_display GLOB '[#(（［【0-9]*'), b.year DESC, b.title_display" +
      ') AS rn FROM books b WHERE 1=1' + where +
    ') SELECT ' + columns.replace(/\bb\./g, '') +
    ' FROM pool ORDER BY rn, ' +
      // Rank 1 of every publisher before rank 2 of any, so the screenful is
      // as wide as the scope allows and narrows only when it must. Neither a
      // cover nor a distinct publisher can be required outright: ja has 31
      // covered books in the whole catalogue, ko has 5, and vi, id and th
      // have none — requiring one left those views with 19, 4 and 0 books.
      "cover = '', substr(id, -3), publisher" +
    ' LIMIT ' + FIRST_PAGE_ROWS
  );
}

function writeFirstPage() {
  const COLUMNS =
    'b.id, b.dataset, b.title, b.subtitle, b.authors, b.publisher, b.year, b.isbn,' +
    ' b.classification, b.language, b.series, b.ref, b.src, b.price, b.currency,' +
    ' b.forsale, b.cover, b.parallel_title';
  // Still the browse order, and still what writeScopePages() files the other
  // 761 views by. Only the landing view departs from it; see spreadSql().
  const ORDER = "b.cover = '', b.zh_first, b.title_display";

  const languages = json("SELECT value FROM facet_counts WHERE scope = '' AND facet = 'language' ORDER BY n DESC")
    .map((r) => r.value);

  const scopes = {};
  for (const scope of [''].concat(languages)) {
    const where = scope ? ' AND b.language = ' + quote(scope) : '';
    const rows = json(spreadSql(COLUMNS, where));
    // Each facet is counted against the *other* active filters, so its options
    // stay meaningful — the browser's own rule. Inside a single language that
    // means every facet is counted within it, except `language` itself, which
    // is counted across the whole catalogue so the other languages are still
    // offered and reachable.
    const scopeKey = scope ? 'language:' + scope : '';
    const within = (facet) => (facet === 'language' ? '' : scopeKey);
    const counts = json(
      'SELECT scope, facet, value, n FROM facet_counts WHERE scope IN (' + quote(scopeKey) + ", '')" +
        ' ORDER BY facet, n DESC, value'
    );

    const facets = {};
    for (const row of counts) {
      if (row.scope !== within(row.facet)) continue;
      if (!facets[row.facet]) facets[row.facet] = [];
      if (facets[row.facet].length < FACET_LIMIT) facets[row.facet].push({ v: row.value, n: row.n });
    }

    const total = scope
      ? json('SELECT n FROM facet_counts WHERE scope = \'\' AND facet = \'language\' AND value = ' + quote(scope))[0].n
      : json("SELECT SUM(n) AS n FROM facet_counts WHERE scope = '' AND facet = 'language'")[0].n;

    scopes[scope] = { total: total, rows: rows, facets: facets };
  }

  const out = { rows: FIRST_PAGE_ROWS, builtAt: new Date().toISOString(), scopes: scopes };
  const file = 'firstpage.json';
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(out) + '\n');

  const size = fs.statSync(path.join(DATA_DIR, file)).size;
  console.log(
    '  Landing view precomputed → ' + file + ', ' + (size / 1024).toFixed(0) + ' KB, ' +
      Object.keys(scopes).length + ' scopes (no range requests for first paint)'
  );
  return {
    firstPage: { file: file, rows: FIRST_PAGE_ROWS, scopes: Object.keys(scopes) },
    pages: writeScopePages(COLUMNS, ORDER),
  };
}

/**
 * A precomputed first page for every scope the facet counts cover.
 *
 * Why: clicking a filter costs about 45 range requests, and SQLite issues them
 * largely one after another because it cannot ask for a page before reading
 * the page that points at it. Measured on the live site, filtering by 東立
 * took ~20 s from Hong Kong and ~3 minutes through a US exit. The work is not
 * the problem — the round trips are.
 *
 * firstpage.json already removes them for the landing view, which paints in
 * 0.2 s with no range requests at all. This is the same idea for the other 763
 * scopes: one small static file each, holding the rows, the total and the
 * facet counts, so a filtered browse is a single HTTP request and no database
 * reads whatsoever.
 *
 * Scopes are addressed by index rather than by name. A scope is a string like
 * `publisher:東立` or `source:ncl-holdings#0`, and turning those into
 * filenames means percent-encoding, a '#' that truncates a URL, and CJK
 * filenames on a static host. An integer sidesteps all of it, and the manifest
 * carries the map.
 *
 * What it does not cover: the second page onwards, and any two filters at
 * once. Those still read the database. The first page is what a reader waits
 * for.
 */
function writeScopePages(columns, order) {
  const dir = path.join(DATA_DIR, 'page');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Every scope the build precomputed counts for, which is exactly the set the
  // client will ask about.
  const scopes = json(
    "SELECT DISTINCT scope FROM facet_counts WHERE scope <> '' ORDER BY scope"
  ).map((r) => r.scope);

  const index = {};
  let n = 0;
  let bytes = 0;

  for (const scope of scopes) {
    const at = scope.indexOf(':');
    const facet = scope.slice(0, at);
    const value = scope.slice(at + 1);
    const expr = SQL_FACET[facet];
    if (!expr) continue;

    const where = ' WHERE ' + expr + ' = ' + quote(value);
    const rows = json(
      'SELECT ' + columns + ' FROM books b' + where + ' ORDER BY ' + order + ' LIMIT ' + FIRST_PAGE_ROWS
    );
    if (!rows.length) continue;

    const total = json('SELECT COUNT(*) AS n FROM books b' + where)[0].n;

    // Same rule as the landing view: a facet is never narrowed by a filter on
    // itself, so that one is counted across the whole catalogue and the reader
    // can still see the other values to switch to.
    const counts = json(
      'SELECT scope, facet, value, n FROM facet_counts WHERE scope IN (' + quote(scope) + ", '')" +
        ' ORDER BY facet, n DESC, value'
    );
    const facets = {};
    for (const row of counts) {
      const want = row.facet === facet ? '' : scope;
      if (row.scope !== want) continue;
      if (!facets[row.facet]) facets[row.facet] = [];
      if (facets[row.facet].length < FACET_LIMIT) facets[row.facet].push({ v: row.value, n: row.n });
    }

    const payload = JSON.stringify({ total: total, rows: rows, facets: facets }) + '\n';
    fs.writeFileSync(path.join(dir, n + '.json'), payload);
    index[scope] = n;
    bytes += payload.length;
    n++;
  }

  console.log(
    '  Scope pages precomputed → data/page/, ' + n + ' files, ' +
      (bytes / 1048576).toFixed(1) + ' MB (a filtered browse costs one request)'
  );
  return { dir: 'page/', rows: FIRST_PAGE_ROWS, scopes: index };
}

/**
 * The complete list of values for the facets that have a search box.
 *
 * The facet lists the client holds are capped at FACET_LIMIT — 200 — which is
 * ample for showing options but hopeless for searching: there are 38,053
 * publishers, so typing 天窗 found nothing although 天窗出版社有限公司 has 181
 * records. The box searched the 200 it had.
 *
 * Each file is an array of [value, count], sorted by count, fetched only when
 * someone types in that facet's box. Publishers come to about 1 MB, which
 * gzips to a fraction of that and is never loaded otherwise.
 */
function writeFacetLists() {
  const dir = path.join(DATA_DIR, 'facet');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const out = {};
  for (const key of FACET_FULL_LIST) {
    const expr = SQL_FACET[key].replace(/\bb\./g, '');
    const rows = json(
      'SELECT ' + expr + ' AS v, COUNT(*) AS n FROM books WHERE ' + expr +
        " <> '' GROUP BY v ORDER BY n DESC, v"
    );
    const payload = JSON.stringify(rows.map((r) => [r.v, r.n])) + '\n';
    fs.writeFileSync(path.join(dir, key + '.json'), payload);
    out[key] = rows.length;
    console.log(
      '  Full ' + key + ' list → data/facet/' + key + '.json, ' +
        rows.length.toLocaleString('en-US') + ' values, ' +
        (payload.length / 1048576).toFixed(1) + ' MB'
    );
  }
  return { dir: 'facet/', counts: out };
}

/** Runs a query and parses sqlite3's own JSON output, so types survive. */
/**
 * How many records the grid will fold into a shared card.
 *
 * The catalogue holds its datasets side by side rather than merged, so one
 * book can hold several true records. site/dedupe.js decides when two of them
 * are indistinguishable on screen; this counts them, because 資料說明 tells
 * the reader how much of what they are browsing is the same book twice, and a
 * number typed into that page would be wrong at the next import.
 *
 * Counted with the same function the browser runs, over the same display title
 * the browser would show — not an approximation of it in SQL, which is how
 * the first version of this came out 1,900 cards different.
 */
function countDuplicates() {
  const { dedupeKey } = require('./lib/dedupe.js');
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const hasCjk = (text) => CJK.test(text || '');

  const groups = new Map();
  for (const r of json('SELECT title, parallel_title, subtitle, isbn, year FROM books')) {
    const title = !hasCjk(r.title) && hasCjk(r.parallel_title) ? r.parallel_title : r.title || '';
    const key = dedupeKey(r, title);
    if (!key) continue;
    groups.set(key, (groups.get(key) || 0) + 1);
  }

  let books = 0;
  let records = 0;
  for (const n of groups.values()) {
    if (n < 2) continue;
    books++;
    records += n;
  }

  console.log(
    '  Duplicate records: ' + records + ' in ' + books + ' books (' +
      (records - books) + ' cards folded at display time)'
  );
  return { books: books, records: records };
}

function json(sql) {
  const out = execFileSync('sqlite3', ['-json', DB, sql], { maxBuffer: 1 << 28 }).toString().trim();
  return out ? JSON.parse(out) : [];
}

function quote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
