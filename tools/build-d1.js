'use strict';

/**
 * Turns the built SQLite database into SQL chunks D1 can swallow.
 *
 * Not one file. D1 caps a single SQL statement at 100 KB, and people report
 * 504s on remote imports of a few megabytes, with the data partly landed and
 * the retry failing on UNIQUE constraints — so a 250 MB dump run in one go is
 * the shape most likely to fail halfway and leave no way to tell how far it
 * got. Instead: many small files, applied in order, each one cheap to retry.
 *
 * Resumability is the reason for the manifest. `books` can be re-applied
 * safely because every row carries its rowid and the statements are INSERT OR
 * REPLACE. `books_fts` cannot — a contentless FTS5 table has nothing to match
 * an existing row against, so re-applying a chunk would index every document
 * in it twice and quietly corrupt every bm25 score. So tools/d1/import.sh
 * records each chunk as it succeeds and never re-runs one.
 *
 * Usage: node tools/build-d1.js [--rows N] [--out DIR]
 *   --rows  statements per chunk file (default 2000)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DB = path.join(__dirname, '..', 'site', 'data', 'books.db');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const PER_CHUNK = Number(argOf('--rows', 2000));
const OUT = argOf('--out', path.join(__dirname, '..', 'build', 'd1'));

const COLUMNS = [
  'rowid', 'id', 'dataset', 'title', 'parallel_title', 'title_display', 'zh_first',
  'subtitle', 'authors', 'publisher', 'year', 'isbn', 'classification', 'language',
  'series', 'ref', 'src', 'price', 'currency', 'forsale', 'cover',
];

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function main() {
  if (!fs.existsSync(DB)) throw new Error('No ' + DB + ' — run `npm run build:db` first.');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const total = json('SELECT COUNT(*) AS n FROM books')[0].n;
  console.log('Exporting ' + total.toLocaleString() + ' records for D1, ' + PER_CHUNK + ' per chunk');

  const chunks = [];
  chunks.push(...emitBooks(total));
  chunks.push(...emitFts(total));
  chunks.push(...emitFacetCounts());

  fs.writeFileSync(
    path.join(OUT, 'chunks.json'),
    JSON.stringify({ builtAt: new Date().toISOString(), rows: total, chunks: chunks }, null, 2) + '\n'
  );

  const bytes = chunks.reduce((a, c) => a + c.bytes, 0);
  console.log(
    '  ' + chunks.length + ' chunk files, ' + (bytes / 1048576).toFixed(0) + ' MB total → ' + OUT
  );
  console.log('  Apply them with: sh tools/d1/import.sh <database-name>');
}

/** The browse columns. Re-runnable: every statement carries its rowid. */
function emitBooks(total) {
  const out = [];
  let n = 0;
  for (let offset = 0; offset < total; offset += PER_CHUNK) {
    const rows = json(
      'SELECT ' + COLUMNS.join(', ') + ' FROM books ORDER BY rowid LIMIT ' + PER_CHUNK + ' OFFSET ' + offset
    );
    if (!rows.length) break;
    // One statement per row: well inside D1's 100 KB statement cap even for a
    // record with a long title and a cover URL, and it means a chunk that
    // fails names the row it failed on.
    const sql = rows
      .map((r) => 'INSERT OR REPLACE INTO books (' + COLUMNS.join(',') + ') VALUES (' +
        COLUMNS.map((c) => lit(r[c])).join(',') + ');')
      .join('\n') + '\n';
    out.push(write('books', n++, sql, rows.length));
  }
  return out;
}

/**
 * The search index: one row of pre-computed bigrams per record.
 *
 * Regenerated here rather than read back out of books_fts, because a
 * contentless FTS5 table does not keep the text it indexed — only the
 * postings. site/tokenize.js is the same function the build used, so the
 * tokens are identical by construction rather than by hope.
 */
function emitFts(total) {
  const { indexTokens } = require('../site/tokenize.js');
  const out = [];
  let n = 0;
  for (let offset = 0; offset < total; offset += PER_CHUNK) {
    const rows = json(
      'SELECT rowid, title, subtitle, parallel_title, authors, publisher, series,' +
      ' classification, isbn, ref, year FROM books ORDER BY rowid LIMIT ' + PER_CHUNK + ' OFFSET ' + offset
    );
    if (!rows.length) break;
    const sql = rows
      .map((r) => {
        // Field list and order copied from insertBook() in build-sqlite.js.
        const tokens = indexTokens(
          [r.title, r.subtitle, r.parallel_title, r.authors, r.publisher, r.series,
           r.classification, r.isbn, r.ref, r.year].filter(Boolean).join(' ')
        ).join(' ');
        return 'INSERT INTO books_fts (rowid, search) VALUES (' + r.rowid + ',' + lit(tokens) + ');';
      })
      .join('\n') + '\n';
    out.push(write('fts', n++, sql, rows.length));
  }
  return out;
}

/**
 * The build's own facet counts, which the Worker reads instead of running a
 * whole-catalogue GROUP BY. Small — about 95,750 rows — and re-runnable,
 * because nothing here is a contentless FTS table.
 */
function emitFacetCounts() {
  const out = [];
  let n = 0;
  const total = json('SELECT COUNT(*) AS n FROM facet_counts')[0].n;
  for (let offset = 0; offset < total; offset += PER_CHUNK) {
    const rows = json(
      'SELECT scope, facet, value, n FROM facet_counts ORDER BY rowid LIMIT ' +
        PER_CHUNK + ' OFFSET ' + offset
    );
    if (!rows.length) break;
    const sql = rows
      .map((r) =>
        'INSERT INTO facet_counts (scope,facet,value,n) VALUES (' +
        [lit(r.scope), lit(r.facet), lit(r.value), lit(r.n)].join(',') + ');')
      .join('\n') + '\n';
    out.push(write('facets', n++, sql, rows.length));
  }
  return out;
}

function write(kind, n, sql, rows) {
  const name = kind + '-' + String(n).padStart(4, '0') + '.sql';
  fs.writeFileSync(path.join(OUT, name), sql);
  const bytes = Buffer.byteLength(sql);
  // A statement over 100 KB is rejected by D1, and an oversized INSERT has
  // been reported to fail silently rather than loudly — so check here, where
  // it is cheap, instead of discovering it a hundred chunks into an import.
  const longest = sql.split('\n').reduce((m, line) => Math.max(m, Buffer.byteLength(line)), 0);
  if (longest > 90000) {
    throw new Error(name + ': a statement is ' + longest + ' bytes, too close to D1\'s 100 KB cap');
  }
  return { file: name, kind: kind, rows: rows, bytes: bytes };
}

function json(sql) {
  const out = execFileSync('sqlite3', ['-json', DB, sql], { maxBuffer: 1 << 28 }).toString().trim();
  return out ? JSON.parse(out) : [];
}

main();
