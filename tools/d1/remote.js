'use strict';

/**
 * Reading a D1 database back, a page at a time.
 *
 * Shared by sync.js and fts-migrate.js because both need the same thing and
 * the way it pages is the part that is easy to get expensively wrong.
 *
 * Paging is by `rowid >`, never OFFSET. OFFSET re-walks everything it skips,
 * so reading 446,090 rows in pages of 1,000 would cost about 100 million rows
 * read — twenty days of the free allowance — instead of 446,090.
 *
 * `against` reads a local SQLite file in D1's place, which is how either tool
 * can be rehearsed against a copy before being pointed at the live database.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
// Each page is one `npx wrangler` invocation, and the process start dominates
// the query: 446,090 rows in pages of 2,000 is 223 of them. D1 caps a result
// at 50 MB and the widest page here is twenty columns of about 600 bytes, so
// 5,000 rows is roughly 3 MB — far inside the cap, and a third of the calls.
const PAGE = 5000;

function makeReader(options) {
  const dbName = options.dbName;
  const against = options.against || null;

  function query(sql) {
    if (against) {
      const out = execFileSync('sqlite3', ['-json', against, sql], { maxBuffer: 1 << 28 })
        .toString().trim();
      const rows = out ? JSON.parse(out) : [];
      return { rows: rows, meta: { rows_read: rows.length } };
    }
    const out = execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', dbName, '--remote', '--yes', '--json', '--command', sql],
      { maxBuffer: 1 << 28, cwd: ROOT }
    ).toString();
    // Some wrangler versions print a banner before the JSON.
    const at = out.indexOf('[');
    const parsed = JSON.parse(at === -1 ? out : out.slice(at));
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return { rows: (first && first.results) || [], meta: (first && first.meta) || {} };
  }

  /**
   * Every row of `books`, in rowid order, handed to `onPage` a page at a
   * time. Returns the rows read and the highest rowid seen — the latter is
   * where new rows have to start, since an existing row keeps the rowid D1
   * gave it.
   */
  function pageBooks(columns, onPage) {
    let after = -1;
    let reads = 0;
    let maxRowid = 0;
    let seen = 0;
    for (;;) {
      const res = query(
        'SELECT rowid, ' + columns.join(', ') + ' FROM books WHERE rowid > ' + after +
        ' ORDER BY rowid LIMIT ' + PAGE
      );
      if (!res.rows.length) break;
      reads += res.meta.rows_read || res.rows.length;
      onPage(res.rows);
      for (const r of res.rows) if (r.rowid > maxRowid) maxRowid = r.rowid;
      after = res.rows[res.rows.length - 1].rowid;
      seen += res.rows.length;
      if (process.stdout.isTTY) process.stdout.write('  ' + seen.toLocaleString() + '\r');
    }
    if (process.stdout.isTTY) process.stdout.write('\r');
    return { reads: reads, maxRowid: maxRowid, rows: seen };
  }

  return { query: query, pageBooks: pageBooks, isLocal: !!against };
}

module.exports = { makeReader: makeReader, PAGE: PAGE };
