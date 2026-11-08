/**
 * 神保町 search API.
 *
 * Why this exists: the site answered searches by reading a 473 MB SQLite file
 * in R2 over HTTP range requests, from the browser. That works, and browsing
 * is genuinely fast because the build precomputes a page per scope — but the
 * cost of anything not precomputed is serial round trips, and serial round
 * trips are latency times depth however good the network is.
 *
 * Measured on a Hong Kong 4G connection, which is the reader this is for:
 * 130 ms per request, about 49 requests for a cold search, so ~6 s; and a
 * publisher outside the 312 the build precomputes took over 45 s, because
 * counting facets means fetching every matching row one page at a time.
 * Precomputing all 38,053 publishers would need 1,163 MB, past what GitHub
 * Pages will host.
 *
 * Here the query runs beside the data, so a search is one round trip.
 */

const PAGE_MAX = 60;

/* Mirrors SQL_FACET in site/schema.js — the client sends facet keys, and the
   mapping from key to column lives in one place on each side. */
export const FACET_SQL = {
  publisher: 'publisher',
  year: "CASE WHEN year IS NULL THEN '' ELSE CAST(year AS TEXT) END",
  source: "dataset || '#' || COALESCE(src, 0)",
  classification: 'classification',
  language: 'language',
  dataset: 'dataset',
  availability: "CASE WHEN forsale = 1 THEN 'sale' WHEN forsale = 0 THEN 'nosale' ELSE '' END",
  identifier: "CASE WHEN isbn <> '' THEN 'isbn' ELSE '' END",
};

export const COLUMNS =
  'b.id, b.dataset, b.title, b.parallel_title, b.subtitle, b.authors, b.publisher,' +
  ' b.year, b.isbn, b.classification, b.language, b.series, b.ref, b.src,' +
  ' b.price, b.currency, b.forsale, b.cover';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/search') return json({ error: 'not found' }, 404);

    try {
      const q = (url.searchParams.get('q') || '').trim();
      const sort = url.searchParams.get('sort') || 'relevance';
      const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
      const limit = clampInt(url.searchParams.get('limit'), 18, 1, PAGE_MAX);
      const wantFacets = url.searchParams.get('facets') !== '0';

      // Filters arrive as repeated params: ?publisher=A&publisher=B&year=2024
      const filters = {};
      for (const key of Object.keys(FACET_SQL)) {
        const values = url.searchParams.getAll(key).filter(Boolean);
        if (values.length) filters[key] = values;
      }

      const where = buildWhere(q, filters);
      const rows = await page(env, where, sort, limit, offset);
      const total = await count(env, where);
      const facets = wantFacets ? await facetCounts(env, where, filters) : {};

      return json({ rows, total, facets }, 200, {
        // Whatever host this is deployed on — workers.dev while it is being
        // proved, api.jimbocho.app later — it is a different origin from
        // jimbocho.app. A plain GET with no custom headers needs no
        // preflight, but the browser discards the body without this.
        'access-control-allow-origin': 'https://jimbocho.app',
        // Short, because the catalogue is rebuilt and the same URL must not
        // keep answering from yesterday's import for long. Long enough that a
        // reader paging through one result set is not re-querying each time.
        'cache-control': 'public, max-age=60',
      });
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
};

/**
 * The WHERE clause and its bindings.
 *
 * `search` is the pre-tokenised bigram column; the caller has already turned
 * the query into an FTS5 MATCH expression with site/tokenize.js, which is why
 * the raw text is never interpolated here.
 */
export function buildWhere(match, filters, skipKey) {
  const clauses = [];
  const params = [];
  let from = 'books b';
  let filterCount = 0;

  if (match) {
    from = 'books_fts f JOIN books b ON b.rowid = f.rowid';
    clauses.push('f.books_fts MATCH ?');
    params.push(match);
  }

  for (const key of Object.keys(filters)) {
    if (key === skipKey) continue;
    const holes = filters[key].map(() => '?').join(',');
    clauses.push(FACET_SQL[key] + ' IN (' + holes + ')');
    params.push(...filters[key]);
    filterCount++;
  }

  return {
    from,
    sql: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '',
    params,
    match,
    filterCount,
  };
}

export function order(sort, hasMatch) {
  const t = 'b.zh_first, b.title_display';
  switch (sort) {
    case 'title': return t;
    case 'title-desc': return 'b.zh_first, b.title_display DESC';
    case 'year': return "b.year, b.cover = '', " + t;
    case 'year-desc': return "b.year DESC, b.cover = '' DESC, b.zh_first DESC, b.title_display DESC";
    case 'publisher': return "b.publisher, b.cover = '', " + t;
    default: return hasMatch ? 'bm25(books_fts)' : "b.cover = '', " + t;
  }
}

async function page(env, where, sort, limit, offset) {
  const sql =
    'SELECT ' + COLUMNS + ' FROM ' + where.from + where.sql +
    ' ORDER BY ' + order(sort, !!where.match) + ' LIMIT ? OFFSET ?';
  const res = await env.DB.prepare(sql).bind(...where.params, limit, offset).all();
  return res.results || [];
}

async function count(env, where) {
  // Counting the FTS table alone where nothing else narrows it: joining books
  // would visit a row per match for a number the index already knows.
  const sql = where.match && where.filterCount === 0
    ? 'SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH ?'
    : 'SELECT COUNT(*) AS n FROM ' + where.from + where.sql;
  const res = await env.DB.prepare(sql).bind(...where.params).first();
  return (res && res.n) || 0;
}

/**
 * Facet counts over the whole result set, exact.
 *
 * This is the part the file-over-HTTP version could not do: every facet needs
 * a column the browse index does not carry, so it had to fetch each matching
 * row, which is one network round trip per row. Here it is a GROUP BY next to
 * the data, and the counts are exact rather than sampled — no more ≈ markers.
 *
 * A facet is never narrowed by a filter on itself, so the reader can still see
 * the other values of a facet they have already filtered by and switch to one.
 */
async function facetCounts(env, where, filters) {
  const out = {};
  const keys = Object.keys(FACET_SQL);

  const queries = keys.map((key) => {
    // Rebuilt without this facet's own clause, so a reader who has already
    // picked a publisher still sees the other publishers and can switch.
    const w = buildWhere(where.match, filters, key);
    const sql =
      'SELECT ' + FACET_SQL[key] + ' AS v, COUNT(*) AS n FROM ' + w.from + w.sql +
      " GROUP BY v HAVING v <> '' ORDER BY n DESC, v LIMIT 200";
    return env.DB.prepare(sql).bind(...w.params);
  });

  const results = await env.DB.batch(queries);
  results.forEach((res, i) => {
    out[keys[i]] = (res.results || []).map((r) => ({ v: r.v, n: r.n }));
  });
  return out;
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(headers || {}) },
  });
}
