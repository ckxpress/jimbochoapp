#!/usr/bin/env node
'use strict';

/**
 * Works out the smallest set of statements that would make D1 match the
 * database this build just produced, and writes them as chunks for
 * tools/d1/sync.sh to apply.
 *
 *   node tools/d1/sync.js <database-name>
 *   node tools/d1/sync.js <database-name> --dry   plan only, apply nothing
 *
 * Why this exists: a full re-import is 4,748,153 writes, and the D1 free plan
 * allows 100,000 a day — 47 days. Yet the three "Rebuild catalogue" commits in
 * this repository's history each changed eighteen lines and reported identical
 * counts. Almost nothing moves between rebuilds, and almost nothing is what
 * should be written.
 *
 * How the two sides are compared, and why it is done this way:
 *
 * The whole of `books` is read back from D1 and hashed here. That costs
 * 446,090 rows read, which is 9% of a day's read allowance and buys the one
 * property that matters — the plan is computed against what D1 actually holds
 * rather than against a record of what was last sent. A local ledger would be
 * smaller and would eventually be wrong, and being wrong here is not loud: it
 * writes a delta that silently leaves the two databases disagreeing.
 *
 * Paging is by `rowid >` rather than OFFSET. OFFSET re-walks the rows it skips,
 * so 446 pages of 1,000 would read about 100 million rows instead of 446,090.
 *
 * Rowids are D1's, not the build's. build-sqlite.js numbers rows positionally,
 * so inserting one record into the first dataset shifts every rowid after it
 * and a "delta" becomes a rewrite of the whole table. Rows are therefore
 * matched on `id`, which is stable, and an existing row keeps whatever rowid
 * D1 gave it. New rows are allocated above the current maximum.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { makeReader, PAGE } = require('./remote.js');

const ROOT = path.join(__dirname, '..', '..');
const DB = path.join(ROOT, 'site', 'data', 'books.db');
const OUT = path.join(ROOT, 'build', 'd1', 'sync');

const COLUMNS = [
  'id', 'dataset', 'title', 'parallel_title', 'title_display', 'zh_first',
  'subtitle', 'authors', 'publisher', 'year', 'isbn', 'classification',
  'language', 'series', 'ref', 'src', 'price', 'currency', 'forsale', 'cover',
];
// The fields site/tokenize.js is fed, in the order insertBook() uses. Kept
// here as its own list because the search text must be built identically or
// the index and the rows drift apart.
const FTS_FIELDS = ['title', 'subtitle', 'parallel_title', 'authors', 'publisher',
  'series', 'classification', 'isbn', 'ref', 'year'];

const PER_CHUNK = 500;      // statements per chunk file
// A plan bigger than this is not an incremental sync; it is a re-import
// wearing one. Stop and say so rather than spending a week of quota.
const SANE_WRITES = 600000;

const args = process.argv.slice(2);
const DB_NAME = args[0];
const DRY = args.includes('--dry');
// Read the "remote" side from a SQLite file instead of D1. For rehearsing a
// sync against a copy before letting it near the live database, and for
// testing this file at all without spending read quota.
const AGAINST = args.indexOf('--against') === -1 ? null : args[args.indexOf('--against') + 1];

let reader = null;

if (!DB_NAME || DB_NAME.startsWith('--')) {
  console.error('usage: node tools/d1/sync.js <database-name> [--dry] [--against <file.db>]');
  process.exit(2);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

async function main() {
  if (!fs.existsSync(DB)) throw new Error('No ' + DB + ' — run `npm run build:db` first.');
  reader = makeReader({ dbName: DB_NAME, against: AGAINST });

  console.log('Reading what D1 holds' + (AGAINST ? ' (standing in: ' + AGAINST + ')' : '') + '…');
  const remote = readRemoteBooks();
  console.log('  ' + remote.byId.size.toLocaleString() + ' rows, ' +
    remote.reads.toLocaleString() + ' rows read, max rowid ' + remote.maxRowid.toLocaleString());

  console.log('Reading what this build produced…');
  const local = readLocalBooks();
  console.log('  ' + local.size.toLocaleString() + ' rows');

  const plan = diffBooks(local, remote);
  const facets = diffFacets(readRemoteFacets(), readLocalFacets());

  report(plan, facets, remote);

  if (DRY) {
    console.log('\n--dry: nothing written.');
    return;
  }
  if (plan.writes + facets.writes > SANE_WRITES) {
    console.error('\n✗ ' + (plan.writes + facets.writes).toLocaleString() +
      ' writes is past the sanity limit of ' + SANE_WRITES.toLocaleString() + '.');
    console.error('  That is a re-import, not a sync. Use tools/d1/import.sh, or');
    console.error('  raise SANE_WRITES if this really is what you meant.');
    process.exit(1);
  }

  write(plan, facets);
}

/* ---------------------------------------------------------------- reading */

/** Every row of `books` as D1 holds it, hashed, keyed by id. */
function readRemoteBooks() {
  const byId = new Map();
  const seen = reader.pageBooks(COLUMNS, (rows) => {
    for (const r of rows) byId.set(r.id, { rowid: r.rowid, hash: hashRow(r), row: r });
  });
  return { byId: byId, reads: seen.reads, maxRowid: seen.maxRowid };
}

function readLocalBooks() {
  const byId = new Map();
  let after = -1;
  for (;;) {
    const rows = localJson(
      'SELECT rowid, ' + COLUMNS.join(', ') + ' FROM books WHERE rowid > ' + after +
      ' ORDER BY rowid LIMIT ' + PAGE
    );
    if (!rows.length) break;
    for (const r of rows) {
      byId.set(r.id, { hash: hashRow(r), row: r });
      after = r.rowid;
    }
  }
  return byId;
}

function localJson(sql) {
  const out = execFileSync('sqlite3', ['-json', DB, sql], { maxBuffer: 1 << 28 }).toString().trim();
  return out ? JSON.parse(out) : [];
}

function readRemoteFacets() {
  const map = new Map();
  let offset = 0;
  for (;;) {
    // OFFSET is safe here only because facet_counts is 95,750 rows and has no
    // stable key to page by — the quadratic re-walk that rules it out for
    // `books` costs a few million reads here rather than a hundred million.
    const res = reader.query(
      'SELECT scope, facet, value, n FROM facet_counts ORDER BY scope, facet, value' +
      ' LIMIT ' + PAGE + ' OFFSET ' + offset
    );
    if (!res.rows.length) break;
    for (const r of res.rows) map.set(facetKey(r), r.n);
    offset += res.rows.length;
  }
  return map;
}

function readLocalFacets() {
  const map = new Map();
  for (const r of localJson('SELECT scope, facet, value, n FROM facet_counts')) {
    map.set(facetKey(r), r.n);
  }
  return map;
}

function facetKey(r) {
  return JSON.stringify([r.scope, r.facet, r.value]);
}

/* ---------------------------------------------------------------- diffing */

function hashRow(r) {
  const h = crypto.createHash('sha1');
  for (const c of COLUMNS) h.update(String(r[c] === null || r[c] === undefined ? '' : r[c]), 'utf8');
  return h.digest('base64').slice(0, 16);
}

function searchText(row) {
  const { indexTokens } = require('../../site/tokenize.js');
  return indexTokens(FTS_FIELDS.map((f) => row[f]).filter(Boolean).join(' ')).join(' ');
}

function diffBooks(local, remote) {
  const inserts = [];
  const updates = [];
  const deletes = [];

  let nextRowid = remote.maxRowid + 1;
  for (const [id, l] of local) {
    const r = remote.byId.get(id);
    if (!r) inserts.push({ rowid: nextRowid++, row: l.row });
    else if (r.hash !== l.hash) updates.push({ rowid: r.rowid, row: l.row });
  }
  for (const [id, r] of remote.byId) {
    if (!local.has(id)) deletes.push({ rowid: r.rowid, id: id });
  }

  // One row touched is one write to `books` plus one to each of the eight
  // indexes on it, plus the FTS row. Measured from the reindex: building one
  // index over the table wrote exactly one row per book.
  const INDEXES = 8;
  const writes =
    inserts.length * (1 + INDEXES + 1) +   // the extra FTS delete is a no-op
    updates.length * (1 + INDEXES + 2) +   // delete + insert on the FTS side
    deletes.length * (1 + INDEXES + 1);
  return { inserts, updates, deletes, writes };
}

function diffFacets(remote, local) {
  const sets = [];
  const dels = [];
  for (const [k, n] of local) if (remote.get(k) !== n) sets.push({ k, n });
  for (const k of remote.keys()) if (!local.has(k)) dels.push(k);
  // facet_counts carries two indexes.
  const writes = (sets.length + dels.length) * 3;
  return { sets, dels, writes };
}

/* ---------------------------------------------------------------- output */

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function report(plan, facets, remote) {
  const line = (k, v) => console.log('  ' + k.padEnd(28) + String(v).padStart(12));
  console.log('\nPlan');
  line('books inserted', plan.inserts.length.toLocaleString());
  line('books updated', plan.updates.length.toLocaleString());
  line('books deleted', plan.deletes.length.toLocaleString());
  line('facet counts changed', facets.sets.length.toLocaleString());
  line('facet counts removed', facets.dels.length.toLocaleString());
  console.log('  ' + '-'.repeat(40));
  line('estimated writes', (plan.writes + facets.writes).toLocaleString());
  line('rows read to plan it', remote.reads.toLocaleString());
  const days = (plan.writes + facets.writes) / 100000;
  console.log('\n  ' + (days <= 1
    ? 'Fits inside one day of the free write allowance.'
    : days.toFixed(1) + ' days of the free write allowance — sync.sh is resumable.'));
}

function write(plan, facets) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const chunks = [];
  const emit = (kind, statements) => {
    for (let i = 0; i < statements.length; i += PER_CHUNK) {
      const part = statements.slice(i, i + PER_CHUNK);
      const name = kind + '-' + String(chunks.length).padStart(4, '0') + '.sql';
      fs.writeFileSync(path.join(OUT, name), part.join('\n') + '\n');
      chunks.push({ file: name, kind: kind, statements: part.length });
    }
  };

  // Deletes first: a row leaving frees nothing that an insert needs, but doing
  // them first keeps the table from briefly holding both an old row and its
  // replacement under two rowids if an id is ever recycled.
  emit('delete', plan.deletes.flatMap((d) => [
    'DELETE FROM books_fts WHERE rowid = ' + d.rowid + ';',
    'DELETE FROM books WHERE rowid = ' + d.rowid + ';',
  ]));

  emit('update', plan.updates.flatMap((u) => [
    'UPDATE books SET ' + COLUMNS.map((c) => c + ' = ' + lit(u.row[c])).join(', ') +
      ' WHERE rowid = ' + u.rowid + ';',
    'DELETE FROM books_fts WHERE rowid = ' + u.rowid + ';',
    'INSERT INTO books_fts (rowid, search) VALUES (' + u.rowid + ', ' + lit(searchText(u.row)) + ');',
  ]));

  // INSERT OR REPLACE, and every FTS insert preceded by a delete of the same
  // rowid, so that re-running a chunk is harmless. A chunk that fails partway
  // is the normal case over this many round trips, and the runner's answer is
  // to run it again — which a plain INSERT would turn into a constraint error
  // on `books` and, worse, a duplicate posting list in books_fts.
  emit('insert', plan.inserts.flatMap((i) => [
    'INSERT OR REPLACE INTO books (rowid, ' + COLUMNS.join(', ') + ') VALUES (' + i.rowid + ', ' +
      COLUMNS.map((c) => lit(i.row[c])).join(', ') + ');',
    'DELETE FROM books_fts WHERE rowid = ' + i.rowid + ';',
    'INSERT INTO books_fts (rowid, search) VALUES (' + i.rowid + ', ' + lit(searchText(i.row)) + ');',
  ]));

  const facetStatements = [];
  for (const k of facets.dels) {
    const [scope, facet, value] = JSON.parse(k);
    facetStatements.push('DELETE FROM facet_counts WHERE scope = ' + lit(scope) +
      ' AND facet = ' + lit(facet) + ' AND value = ' + lit(value) + ';');
  }
  for (const s of facets.sets) {
    const [scope, facet, value] = JSON.parse(s.k);
    // Delete-then-insert rather than UPDATE: facet_counts has no unique key,
    // so an UPDATE that matched two rows would be silently wrong.
    facetStatements.push('DELETE FROM facet_counts WHERE scope = ' + lit(scope) +
      ' AND facet = ' + lit(facet) + ' AND value = ' + lit(value) + ';');
    facetStatements.push('INSERT INTO facet_counts (scope, facet, value, n) VALUES (' +
      lit(scope) + ', ' + lit(facet) + ', ' + lit(value) + ', ' + s.n + ');');
  }
  emit('facets', facetStatements);

  fs.writeFileSync(
    path.join(OUT, 'plan.json'),
    JSON.stringify({
      builtAt: new Date().toISOString(),
      database: DB_NAME,
      books: { inserted: plan.inserts.length, updated: plan.updates.length, deleted: plan.deletes.length },
      facets: { changed: facets.sets.length, removed: facets.dels.length },
      estimatedWrites: plan.writes + facets.writes,
      chunks: chunks,
    }, null, 2) + '\n'
  );

  console.log('\n  ' + chunks.length + ' chunk files → build/d1/sync');
  console.log('  Apply them with: sh tools/d1/sync.sh ' + DB_NAME);
}
