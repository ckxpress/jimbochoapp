'use strict';

/**
 * /api/search for `npm start`, answered from site/data/books.db.
 *
 * The production answer comes from a Cloudflare Worker over D1. Without a
 * local equivalent there is no way to develop or test the client against the
 * API at all: the Worker allows the jimbocho.app origin, so a page on
 * localhost cannot call it, and pointing local development at production
 * would mean every refresh querying the live database.
 *
 * The SQL is not reimplemented here. buildWhere(), order() and COLUMNS are
 * imported from the Worker itself, so the two cannot drift into answering the
 * same question differently — which is the failure that would be hardest to
 * notice, because both halves would look right in isolation.
 *
 * Correctness over speed: this runs the sqlite3 CLI per query, which is fine
 * for one developer and nothing like how the Worker executes.
 */

const { execFile } = require('child_process');
const path = require('path');

const DB = path.join(__dirname, '..', '..', 'site', 'data', 'books.db');
let workerPromise = null;

function worker() {
  // The Worker is an ES module and this is CommonJS, so it is loaded through
  // a dynamic import rather than required.
  if (!workerPromise) workerPromise = import('../../workers/search/index.js');
  return workerPromise;
}

function run(sql, params) {
  // The sqlite3 CLI takes no bind parameters, so they are inlined here with
  // the same quoting the build uses. Only this dev path does it; the Worker
  // binds properly.
  let i = 0;
  const bound = sql.replace(/\?/g, () => {
    const v = params[i++];
    if (v === null || v === undefined) return 'NULL';
    return typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
  });
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-json', DB, bound], { maxBuffer: 1 << 28 }, (err, stdout) => {
      if (err) return reject(err);
      const out = String(stdout).trim();
      try {
        resolve(out ? JSON.parse(out) : []);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Handles the request, or returns false so the static server can have it. */
function handle(req, res, url) {
  if (url.pathname !== '/api/search') return false;

  worker()
    .then(async (W) => {
      const q = (url.searchParams.get('q') || '').trim();
      const sort = url.searchParams.get('sort') || 'relevance';
      const offset = Number(url.searchParams.get('offset') || 0) || 0;
      const limit = Math.min(60, Number(url.searchParams.get('limit') || 18) || 18);
      const wantFacets = url.searchParams.get('facets') !== '0';

      const filters = {};
      for (const key of Object.keys(W.FACET_SQL)) {
        const values = url.searchParams.getAll(key).filter(Boolean);
        if (values.length) filters[key] = values;
      }

      const w = W.buildWhere(q, filters);
      const rows = await run(
        'SELECT ' + W.COLUMNS + ' FROM ' + w.from + w.sql +
          ' ORDER BY ' + W.order(sort, !!w.match) + ' LIMIT ? OFFSET ?',
        w.params.concat([limit, offset])
      );
      const totalRow = await run(
        w.match && w.filterCount === 0
          ? 'SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH ?'
          : 'SELECT COUNT(*) AS n FROM ' + w.from + w.sql,
        w.params
      );

      const facets = {};
      if (wantFacets) {
        for (const key of Object.keys(W.FACET_SQL)) {
          const fw = W.buildWhere(w.match, filters, key);
          facets[key] = (
            await run(
              'SELECT ' + W.FACET_SQL[key] + ' AS v, COUNT(*) AS n FROM ' + fw.from + fw.sql +
                " GROUP BY v HAVING v <> '' ORDER BY n DESC, v LIMIT 200",
              fw.params
            )
          ).map((r) => ({ v: r.v, n: r.n }));
        }
      }

      const body = JSON.stringify({ rows, total: (totalRow[0] && totalRow[0].n) || 0, facets });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end(body);
    })
    .catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String((err && err.message) || err) }));
    });

  return true;
}

module.exports = { handle };
