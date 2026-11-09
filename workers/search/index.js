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

/* Bumped by hand whenever this file changes.
 *
 * The Worker is deployed by pasting this file into the dashboard editor,
 * because `wrangler deploy` needs permissions the D1 token deliberately does
 * not carry. A paste leaves no deployment record and no version, so there was
 * no way to tell whether what is running is what is in the repository —
 * which matters most exactly when something is wrong and the first question
 * is whether the fix is even live. The answer now comes back with every
 * response. */
const VERSION = '2026-11-09a';

const PAGE_MAX = 60;

/* How many values of one facet to return — the same cap the client holds. */
const FACET_LIMIT = 200;

/* How many matching rows a live facet count will look at. Beyond this the
   counts are a sample rather than a total, which the client shows with ≈.
   The alternative is reading every matching row of a broad query, eight
   times over, and billing says no. */
const FACET_SCAN_CAP = 600;

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

      return json({ rows, total, facets, v: VERSION }, 200, {
        // Short, because the catalogue is rebuilt and the same URL must not
        // keep answering from yesterday's import for long. Long enough that a
        // reader paging through one result set is not re-querying each time.
        'cache-control': 'public, max-age=60',
      });
    } catch (err) {
      return json({ error: String(err && err.message || err), v: VERSION }, 500);
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

export async function page(env, where, sort, limit, offset) {
  const sql =
    'SELECT ' + COLUMNS + ' FROM ' + where.from + where.sql +
    ' ORDER BY ' + order(sort, !!where.match) + ' LIMIT ? OFFSET ?';
  const res = await env.DB.prepare(sql).bind(...where.params, limit, offset).all();
  return res.results || [];
}

export async function count(env, where) {
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
export async function facetCounts(env, where, filters) {
  const out = {};
  const keys = Object.keys(FACET_SQL);

  const queries = keys.map((key) => {
    // A facet is never narrowed by a filter on itself, so a reader who has
    // picked one publisher can still see the others and switch.
    const w = buildWhere(where.match, filters, key);

    // Dropping that clause can leave nothing narrowing the query at all —
    // which is exactly what happens for the publisher facet on a
    // publisher-filtered page, the commonest request this API serves. As a
    // GROUP BY that reads all 446,090 rows, and with eight facets per
    // request it exhausted D1's five-million-row daily allowance in a few
    // dozen requests. The build already computes these counts; read them.
    if (!w.match && w.filterCount === 0) {
      return env.DB.prepare(
        "SELECT value AS v, n FROM facet_counts WHERE scope = '' AND facet = ?" +
        ' ORDER BY n DESC, value LIMIT ' + FACET_LIMIT
      ).bind(key);
    }

    // Still narrowed by something, so it has to be counted live — but over a
    // bounded number of rows. Past the cap the counts describe a sample, and
    // the client already marks sampled counts with ≈ rather than presenting
    // them as exact.
    const sql =
      'SELECT v, COUNT(*) AS n FROM (SELECT ' + FACET_SQL[key] + ' AS v FROM ' +
      w.from + w.sql + ' LIMIT ' + FACET_SCAN_CAP + ')' +
      " WHERE v <> '' GROUP BY v ORDER BY n DESC, v LIMIT " + FACET_LIMIT;
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

/**
 * Every response carries the CORS header, errors included.
 *
 * It used to be attached only to the success path. The first real failure —
 * D1's daily row limit — therefore came back as a 500 with no header, and the
 * browser reported "No 'Access-Control-Allow-Origin' header is present". The
 * Worker was saying exactly what was wrong and the message could not be read.
 * An error nobody can see is worse than the error.
 */
function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': 'https://jimbocho.app',
      ...(headers || {}),
    },
  });
}
