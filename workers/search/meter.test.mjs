import worker from './index.js';

// No Cache API in node: a cache that never hits, so every request takes the
// metered path. cache.put must still be awaitable.
globalThis.caches = { default: { match: async () => null, put: async () => {} } };

const seen = [];
function stmt(sql, rows, rowsRead) {
  return {
    sql,
    bind(...params) { return { ...this, params }; },
    async all() {
      seen.push({ sql, read: rowsRead });
      return { results: rows, meta: { rows_read: rowsRead, rows_written: 0 } };
    },
  };
}

// Canned answers keyed loosely on what the SQL is for.
function answer(sql) {
  if (sql.includes('FROM facet_counts')) {
    if (sql.includes('SUM(n) AS n FROM facet_counts WHERE')) return [[{ n: 448350 }], 16];
    return [[{ v: 'x', n: 5 }], 7];
  }
  if (sql.includes('COUNT(*) AS n FROM (')) return [[{ n: 377 }], 377];
  if (sql.startsWith('SELECT v, COUNT(*)')) return [[{ v: 'a', n: 3 }], 300];
  return [[{ id: 'ncl:1', title: 'T' }], 3];
}

const db = {
  prepare(sql) { const [rows, read] = answer(sql); return stmt(sql, rows, read); },
  async batch(stmts) {
    const out = [];
    for (const st of stmts) out.push(await st.all());
    return out;
  },
};

const ctx = { waitUntil: (p) => p };
const url = 'https://x/api/search?q=%22%E9%A6%99%E6%B8%AF%22&limit=3';
const res = await worker.fetch(new Request(url), { DB: db }, ctx);
const body = await res.json();

console.log('status      ', res.status);
console.log('x-cache     ', res.headers.get('x-cache'));
console.log('x-rows-read ', res.headers.get('x-rows-read'));
console.log('x-d1-queries', res.headers.get('x-d1-queries'));
console.log('total       ', body.total, 'rows', body.rows.length, 'facets', Object.keys(body.facets).length);

const summed = seen.reduce((a, s) => a + s.read, 0);
const ok = String(summed) === res.headers.get('x-rows-read')
  && String(seen.length) === res.headers.get('x-d1-queries')
  && res.status === 200 && body.total === 377;
console.log('\nqueries issued', seen.length, '| rows read summed', summed);
console.log(ok ? 'PASS — header matches what the stub actually served' : 'FAIL');

// Now serve the same request from cache and check it claims nothing.
// A fresh Response, not res.clone() — res's body was consumed by .json()
// above, and a clone of a used body throws straight into the .catch(),
// which silently sends the request down the query path instead.
const stored = new Response(JSON.stringify(body), {
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'x-cache': 'miss',
    'x-rows-read': '3396',
    'x-d1-queries': '10',
  },
});
globalThis.caches.default.match = async () => stored;

const before = seen.length;
const hit = await worker.fetch(new Request(url), { DB: db }, ctx);
const extra = seen.length - before;
console.log('\ncache hit   x-cache', hit.headers.get('x-cache'),
            '| x-rows-read', hit.headers.get('x-rows-read'),
            '| x-d1-queries', hit.headers.get('x-d1-queries'),
            '| extra D1 queries', extra);
const ok2 = hit.headers.get('x-cache') === 'hit'
  && hit.headers.get('x-rows-read') === '0'
  && hit.headers.get('x-d1-queries') === '0'
  && extra === 0;
console.log(ok2 ? 'PASS — a hit reads nothing and says so' : 'FAIL');
process.exit(ok && ok2 ? 0 : 1);
