#!/usr/bin/env node
/**
 * What a reader actually gets — checked from outside, over the public URLs.
 *
 * Every check here exists because something went wrong that nothing reported:
 *
 *  - D1 and R2 held different catalogues for ten days. The site falls back
 *    from the API to the database file on any error, silently and by design,
 *    so the healthy backend showed 2,260 fewer books than the broken one and
 *    search simply had no 3ook in it.
 *  - The rebuild's D1 sync is continue-on-error, so a sync that refused to
 *    run leaves a green tick and a yellow annotation nobody reads.
 *  - `wrangler d1 info` reported read_queries_24h as 0 through queries it had
 *    just served, so the one instrument that should have shown the read
 *    budget showed nothing.
 *  - 94% of 3ook records had no cover at all, and the first page of a browse
 *    hid it: that order sorts books with covers first, so any sample taken
 *    from the top says everything is fine.
 *
 * So the covers check samples alphabetically, not in browse order, and the
 * two backends are asked separately and compared.
 *
 * Costs about 8,000 D1 row reads — 0.16% of a free day. Run it after a
 * rebuild, or whenever the site looks wrong and you want to know whether it
 * is the data, the index, or the pictures.
 *
 * Usage: npm run status  [--covers]   (--covers adds the sampling, ~6k reads)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'site', 'data', 'manifest.json');
const SITE = 'https://jimbocho.app';

const WANT_COVERS = process.argv.includes('--covers');

/* Printing ---------------------------------------------------------------- */

let failures = 0;
const GREEN = '\u001b[32m', RED = '\u001b[31m', DIM = '\u001b[2m', OFF = '\u001b[0m';
const tty = process.stdout.isTTY;
const paint = (c, s) => (tty ? c + s + OFF : s);

function head(title) {
  console.log('\n' + title);
}
function row(label, value, verdict) {
  const mark = verdict === true ? paint(GREEN, 'ok')
    : verdict === false ? paint(RED, 'FAIL')
      : '';
  if (verdict === false) failures++;
  console.log('  ' + label.padEnd(22) + String(value).padEnd(32) + mark);
}
function note(s) {
  console.log('  ' + paint(DIM, s));
}

/* Fetching ---------------------------------------------------------------- */

async function api(base, params) {
  const u = new URL(base.replace(/\/$/, '') + '/api/search');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  // Defeat the edge cache so a check never passes on a stale answer.
  u.searchParams.set('_', String(Date.now()) + Math.random().toString(36).slice(2));
  const t0 = Date.now();
  const res = await fetch(u.href);
  const body = await res.json();
  return {
    body,
    ms: Date.now() - t0,
    status: res.status,
    // Present only once the Worker carrying the meter is deployed.
    rowsRead: res.headers.get('x-rows-read'),
    version: body.v,
  };
}

async function main() {
  const local = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const base = local.api;
  if (!base) throw new Error('site/data/manifest.json has no `api` key');

  console.log('神保町 status — ' + new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC');

  /* --- the two backends ------------------------------------------------- */
  head('Backends');

  const live = await fetch(SITE + '/data/manifest.json').then((r) => r.json());
  const all = await api(base, { limit: 1, facets: 1 });

  row('R2 / manifest', live.totalBooks.toLocaleString() + ' books');
  row('D1 / worker', all.body.total.toLocaleString() + ' books',
    all.body.total === live.totalBooks);
  if (all.body.total !== live.totalBooks) {
    note('They disagree by ' + Math.abs(all.body.total - live.totalBooks).toLocaleString() +
      '. The D1 sync is behind the published database — rebuild with sync_d1 ticked.');
  }

  const datasets = (all.body.facets && all.body.facets.dataset) || [];
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'datasets.json'), 'utf8'));
  const expected = (registry.datasets || registry).filter((d) => d && d.id).length;
  row('datasets in D1', datasets.length + ' of ' + expected, datasets.length === expected);
  if (datasets.length !== expected) {
    const have = new Set(datasets.map((d) => d.v));
    const missing = (registry.datasets || registry)
      .filter((d) => d && d.id && !have.has(d.id)).map((d) => d.id);
    note('Missing from the search index: ' + missing.join(', '));
  }

  row('worker version', all.version || '(none)');
  row('local manifest', local.totalBooks.toLocaleString() + ' books');
  if (local.totalBooks !== live.totalBooks) {
    // Not a failure: the daily job commits on its own, so a checkout is
    // behind most mornings. It only matters before building here.
    note('Your checkout is ' + Math.abs(live.totalBooks - local.totalBooks).toLocaleString() +
      ' behind what is published — git pull before building anything locally.');
  }

  /* --- search ----------------------------------------------------------- */
  head('Search');

  const { matchExpression } = loadTokenizer();
  for (const term of ['香港', '董啟章']) {
    const r = await api(base, { q: matchExpression(term), facets: 0, limit: 3 });
    const got = (r.body.rows || []).length;
    row('"' + term + '"',
      r.body.total.toLocaleString() + ' hits, ' + r.ms + ' ms' +
        (r.rowsRead ? ', ' + Number(r.rowsRead).toLocaleString() + ' rows read' : ''),
      r.status === 200 && got > 0);
  }

  /* The index against the table, rather than against a term chosen by hand.
   * Take an ISBN the catalogue demonstrably holds, then ask the index for it:
   * a book that is in `books` and not in `books_fts` is the failure mode a
   * contentless FTS table has — a wrong delete leaves no trace, the counts
   * stay right and the integrity check passes. A hand-picked ISBN cannot
   * tell that apart from a book the catalogue simply never had. */
  const withIsbn = await api(base, { identifier: 'isbn', facets: 0, limit: 1, sort: 'year-desc' });
  const specimen = (withIsbn.body.rows || [])[0];
  if (!specimen || !specimen.isbn) {
    row('isbn round-trip', 'no specimen found', false);
  } else {
    const back = await api(base, { q: matchExpression(specimen.isbn), facets: 0, limit: 5 });
    const found = (back.body.rows || []).some((b) => b.isbn === specimen.isbn);
    row('isbn round-trip', specimen.isbn + ' → ' + back.body.total + ' hit(s)', found);
    if (!found) {
      note('That book is in `books` but the index will not return it: stale or');
      note('missing postings in books_fts. See tools/d1/fts-migrate.js.');
    }
  }

  /* --- the edge cache --------------------------------------------------- */
  head('Edge cache');
  const u = base.replace(/\/$/, '') + '/api/search?q=%22%E9%A6%99%E6%B8%AF%22&facets=0&limit=1';
  await fetch(u);
  const second = await fetch(u);
  const hit = second.headers.get('x-cache');
  row('repeat request', hit || '(no header)', hit === 'hit');
  if (hit !== 'hit') {
    note('Repeats are paying full price in D1 row reads.');
  }

  /* --- covers ----------------------------------------------------------- */
  if (WANT_COVERS) {
    head('Covers  (sampled alphabetically — browse order sorts covered books first)');
    for (const id of ['3ook', 'ol-hk', 'ncl-2026']) {
      let rows = 0, covered = 0;
      for (const offset of [0, 400, 800, 1200, 1600, 2000]) {
        const r = await api(base, { dataset: id, sort: 'title', facets: 0, limit: 60, offset });
        const batch = r.body.rows || [];
        if (!batch.length) break;
        rows += batch.length;
        covered += batch.filter((b) => b.cover).length;
      }
      const pct = rows ? Math.round((covered / rows) * 100) : 0;
      row(id, covered + ' of ' + rows + ' sampled — ' + pct + '%');
    }
    note('A low number is the build, not the site: the cover column was empty at import.');
  } else {
    head('Covers');
    note('Skipped. Add --covers to sample them (~6,000 more row reads).');
  }

  /* --- what this cannot see --------------------------------------------- */
  head('Not visible from here');
  note('D1 storage (500 MB free ceiling)   npx wrangler d1 info jimbocho-search');
  note('Whether the last sync applied      the run summary\'s "Search index" section');
  note('wrangler\'s own 24h counters have read 0 through served queries — do not');
  note('budget against them; x-rows-read above is the Worker\'s own count.');

  console.log('');
  if (failures) {
    console.log(paint(RED, failures + ' check(s) failed.'));
    process.exitCode = 1;
  } else {
    console.log(paint(GREEN, 'All checks passed.'));
  }
}

/** site/tokenize.js is a browser file with no exports. */
function loadTokenizer() {
  const src = fs.readFileSync(path.join(ROOT, 'site', 'tokenize.js'), 'utf8');
  const sandbox = {};
  new Function('exports', src + '\nexports.matchExpression = matchExpression;')(sandbox);
  return sandbox;
}

main().catch((err) => {
  console.error('\n' + (tty ? RED : '') + 'status failed: ' + (err && err.message || err) + (tty ? OFF : ''));
  process.exitCode = 1;
});
