#!/usr/bin/env node
'use strict';

/**
 * Rebuilds books_fts with `contentless_delete=1`, once, so that rows can be
 * removed from the search index by rowid alone.
 *
 *   node tools/d1/fts-migrate.js <database-name>
 *   node tools/d1/fts-migrate.js <database-name> --against <file.db>
 *   sh tools/d1/fts-migrate.sh <database-name>   applies them, resumably
 *
 * Why it has to happen before incremental sync can work:
 *
 * A contentless FTS5 table keeps postings and no text, so the ordinary way to
 * delete a row is to hand it back the exact text it was indexed with. That
 * text is reconstructible here — it is a pure function of the `books` row and
 * site/tokenize.js — but the failure mode is silent in a way that rules the
 * approach out. Measured on a scratch database: a delete with the wrong text
 * is accepted, decrements the row count, leaves the old postings in place,
 * and passes `integrity-check`. A later insert puts the count back. Nothing
 * at all reports that search is now returning rows whose text no longer
 * contains the term.
 *
 * `contentless_delete=1` removes the whole class of bug: `DELETE FROM
 * books_fts WHERE rowid = ?` works, with no text and no stale postings. It is
 * a create-time option, so the table has to be built again to gain it — which
 * is this file, and the only expensive step in the whole scheme:
 * 446,090 inserts, against the 4,748,153 writes a full re-import costs.
 *
 * The new table is built beside the old one and renamed at the end, so search
 * keeps answering from the old index until the new one is complete. Applying
 * this twice is safe: it starts by dropping any half-built table from a
 * previous attempt.
 *
 * The rows are read back out of D1, not taken from the local build. The index
 * is keyed by rowid and has to line up with the `books` rows D1 actually
 * holds; the local build numbers its rows positionally and will not agree
 * after even one record is added. So this runs before any sync, against
 * whatever D1 has, and sync.js takes over from there.
 */

const fs = require('fs');
const path = require('path');
const { indexTokens } = require('../../site/tokenize.js');
const { makeReader } = require('./remote.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'build', 'd1', 'fts');
const PER_CHUNK = 500;

const args = process.argv.slice(2);
const DB_NAME = args[0];
const AGAINST = args.indexOf('--against') === -1 ? null : args[args.indexOf('--against') + 1];
if (!DB_NAME || DB_NAME.startsWith('--')) {
  console.error('usage: node tools/d1/fts-migrate.js <database-name> [--against <file.db>]');
  process.exit(2);
}

// The fields and order insertBook() in build-sqlite.js feeds the tokenizer.
const FIELDS = ['title', 'subtitle', 'parallel_title', 'authors', 'publisher',
  'series', 'classification', 'isbn', 'ref', 'year'];

main();

function main() {
  const reader = makeReader({ dbName: DB_NAME, against: AGAINST });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const chunks = [];
  const add = (kind, sql, rows) => {
    const name = kind + '-' + String(chunks.length).padStart(4, '0') + '.sql';
    fs.writeFileSync(path.join(OUT, name), sql);
    chunks.push({ file: name, kind: kind, rows: rows || 0 });
  };

  add('begin',
    '-- Anything left by an interrupted attempt, so a re-run starts clean.\n' +
    'DROP TABLE IF EXISTS books_fts_new;\n' +
    'CREATE VIRTUAL TABLE books_fts_new USING fts5(\n' +
    "  search, content='', contentless_delete=1, tokenize=\"unicode61 remove_diacritics 2\"\n" +
    ');\n');

  console.log('Reading what D1 holds' + (AGAINST ? ' (standing in: ' + AGAINST + ')' : '') + '…');

  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    add('rows', pending.join('\n') + '\n', pending.length);
    pending = [];
  };
  const seen = reader.pageBooks(FIELDS, (rows) => {
    for (const r of rows) {
      const tokens = indexTokens(FIELDS.map((f) => r[f]).filter(Boolean).join(' ')).join(' ');
      pending.push('INSERT INTO books_fts_new (rowid, search) VALUES (' + r.rowid + ',' + lit(tokens) + ');');
      if (pending.length >= PER_CHUNK) flush();
    }
  });
  flush();
  const total = seen.rows;
  console.log('  ' + total.toLocaleString() + ' rows, ' + seen.reads.toLocaleString() + ' rows read');

  // Last, and only once every row is in: until this runs, search still reads
  // the old index and nothing a reader does is affected.
  add('swap',
    'DROP TABLE books_fts;\n' +
    "ALTER TABLE books_fts_new RENAME TO books_fts;\n");

  fs.writeFileSync(path.join(OUT, 'chunks.json'),
    JSON.stringify({ builtAt: new Date().toISOString(), rows: total, chunks: chunks }, null, 2) + '\n');

  console.log('\n  ' + chunks.length + ' chunk files → build/d1/fts');
  console.log('  ' + total.toLocaleString() + ' inserts, about ' +
    (total / 100000).toFixed(1) + ' days of the free write allowance.');
  console.log('  Apply them with: sh tools/d1/fts-migrate.sh <database-name>');
}

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

