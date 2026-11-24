/**
 * How often does a photographed spine actually find its book?
 *
 *   npm run scan:accuracy -- [--books 120] [--seed 7]
 *
 * The claim the shelf scanner rests on is that the catalogue does the
 * recognising: that OCR which gets a few characters wrong is still enough,
 * because 448,000 records indexed as overlapping bigrams are unforgiving of
 * coincidence. That is a measurable claim and this measures it.
 *
 * Real titles are taken from the local build, corrupted the way an OCR
 * engine corrupts them, and put through exactly the code the browser runs —
 * scanQueries for the tiered lookup, rankCandidates for the ordering. The
 * answer is known, so the rank of the right book is known.
 *
 * It also measures the thing that was almost shipped instead: a flat OR of
 * every bigram, which is the obvious design. The gap between the two columns
 * is the argument for the tiers.
 *
 * Runs against site/data/books.db, not the live Worker, so it costs nothing
 * from the D1 read budget — which is the whole reason it can be run often.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { scanQueries, rankCandidates } = require('../site/scan-match.js');

const DB = path.join(__dirname, '..', 'site', 'data', 'books.db');
const CJK = /[㐀-䶿一-鿿]/;

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
}

const WANTED = arg('books', 120);
const SEED = arg('seed', 7);
const LIMIT = 24; // rows a tier asks for, same as the browser

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const rand = rng(SEED);

/* ---------------- the sample ---------------- */

let db;
try {
  db = new DatabaseSync(DB, { readOnly: true });
} catch (err) {
  console.error('Cannot open ' + DB + '\n' + err.message);
  console.error('\nThis needs the local build: npm run build:db');
  process.exit(2);
}

const COLUMNS = 'id, title, subtitle, authors, publisher, year, isbn';
const maxRowid = db.prepare('SELECT max(rowid) AS n FROM books').get().n;
const byRowid = db.prepare('SELECT ' + COLUMNS + ' FROM books WHERE rowid = ?');

const sample = [];
const seen = new Set();
let draws = 0;
while (sample.length < WANTED && draws < WANTED * 60) {
  draws++;
  const rowid = 1 + Math.floor(rand() * maxRowid);
  if (seen.has(rowid)) continue;
  seen.add(rowid);
  const row = byRowid.get(rowid);
  if (!row || !row.title) continue;
  // Only CJK titles long enough to corrupt and still leave something: a
  // three-character title has no four-character window to begin with, and
  // measuring on those would be measuring a different feature.
  const title = String(row.title);
  if (!CJK.test(title)) continue;
  if (stripped(title).length < 5) continue;
  sample.push(row);
}

function stripped(text) {
  let out = '';
  for (const ch of String(text)) if (CJK.test(ch) || /[a-z0-9]/i.test(ch)) out += ch;
  return out;
}

/* ---------------- the corruption ---------------- */

// Substitutes come from real titles rather than the whole of Unicode: an
// engine that misreads 寂 reports another plausible character, not U+4E2D's
// neighbour by code point, and a pool of characters that actually occur in
// book titles keeps the wrong answers as confusable as the right ones.
const pool = [];
{
  const rows = db.prepare('SELECT title FROM books WHERE rowid % 997 = 0 LIMIT 4000').all();
  const uniq = new Set();
  for (const r of rows) for (const ch of String(r.title || '')) if (CJK.test(ch)) uniq.add(ch);
  pool.push(...uniq);
}

/**
 * What an engine hands back: some characters wrong, some missing, order kept.
 *
 * Deliberately harsher than reality in one way — a substituted character is
 * drawn at random rather than from the set that actually looks like the
 * original — so the numbers below are a floor, not a best case.
 */
function corrupt(title, rate) {
  const chars = [...stripped(title)];
  const out = [];
  for (const ch of chars) {
    const roll = rand();
    if (roll < rate * 0.65) {
      out.push(pool[Math.floor(rand() * pool.length)] || ch); // misread
    } else if (roll < rate) {
      // dropped entirely
    } else {
      out.push(ch);
    }
  }
  return out.join('');
}

/* ---------------- the lookup, as the browser does it ---------------- */

const fts = db.prepare(
  'SELECT ' + COLUMNS.split(', ').map((c) => 'b.' + c).join(', ') +
  ' FROM (SELECT rowid FROM books_fts WHERE books_fts MATCH ? ORDER BY bm25(books_fts) LIMIT ?) h' +
  ' CROSS JOIN books b ON b.rowid = h.rowid'
);

function ask(expr) {
  try {
    return fts.all(expr, LIMIT);
  } catch (err) {
    return []; // a malformed expression is a bug, but not this tool's to throw
  }
}

/* Candidate strategies. Each returns { rows, requests }: the rows a reader
   would be shown, and what it cost to get them. */

const STRATEGIES = {
  /* Widest window first, stop as soon as a tier answers at all. */
  'first-hit': function (text) {
    const tiers = scanQueries(text);
    for (let i = 0; i < tiers.length; i++) {
      const rows = ask(tiers[i].expr);
      if (rows.length) return { rows, requests: i + 1 };
    }
    return { rows: [], requests: tiers.length };
  },

  /* One flat OR of every bigram — the obvious design. */
  flat: function (text) {
    const tiers = scanQueries(text);
    if (!tiers.length) return { rows: [], requests: 0 };
    return { rows: ask(tiers[tiers.length - 1].expr), requests: 1 };
  },

  /* Every tier, pooled. Most requests, most rows to rank. */
  union: function (text) {
    const tiers = scanQueries(text);
    const byId = new Map();
    for (const tier of tiers) for (const row of ask(tier.expr)) if (!byId.has(row.id)) byId.set(row.id, row);
    return { rows: [...byId.values()], requests: tiers.length };
  },

  /* Widest first, and stop only when what came back is actually good —
     a shared run of four characters or more after ranking. Emptiness is the
     wrong test: a narrow window can match one confident wrong book. */
  'first-good': function (text) {
    const tiers = scanQueries(text);
    const byId = new Map();
    for (let i = 0; i < tiers.length; i++) {
      const rows = ask(tiers[i].expr);
      for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
      const pooled = [...byId.values()];
      if (pooled.length) {
        const best = rankCandidates(pooled.map((r) => Object.assign({}, r)), text)[0];
        if (best && best._run >= 4) return { rows: pooled, requests: i + 1 };
      }
    }
    return { rows: [...byId.values()], requests: tiers.length };
  },
};

function rankOf(rows, text, id) {
  const ranked = rankCandidates(rows.map((r) => Object.assign({}, r)), text);
  for (let i = 0; i < ranked.length; i++) if (ranked[i].id === id) return i + 1;
  return 0; // not returned at all
}

/* ---------------- run ---------------- */

const LEVELS = [
  { label: 'clean', rate: 0 },
  { label: '1 in 5 wrong', rate: 0.2 },
  { label: '1 in 3 wrong', rate: 0.35 },
  { label: 'half wrong', rate: 0.5 },
];

/* Eight is what the strip card shows, so "in the list" means top 8. It is
   the number that decides whether the reader taps or retypes, and it
   matters far more than top 1 — they are looking at a picture of the spine
   while they choose. */
const SHOWN = 8;

const names = Object.keys(STRATEGIES);
console.log('\nshelf scan — how often the catalogue finds the book');
console.log('  ' + sample.length + ' real titles from ' + path.relative(process.cwd(), DB) + ', seed ' + SEED);
console.log('  "in list" = among the ' + SHOWN + ' candidates the strip card shows\n');

for (const level of LEVELS) {
  console.log('  ' + level.label);
  const head = '    ' + pad('strategy', 12) + pad('top 1', 8) + pad('in list', 9) + pad('missed', 8) + 'requests';
  console.log(head);
  console.log('    ' + '-'.repeat(head.length - 4));

  // Same corrupted strings for every strategy, so the comparison is fair.
  const reads = sample.map((book) => corrupt(book.title, level.rate));

  for (const name of names) {
    let top1 = 0, inList = 0, missed = 0, requests = 0;
    for (let i = 0; i < sample.length; i++) {
      const out = STRATEGIES[name](reads[i]);
      const rank = rankOf(out.rows, reads[i], sample[i].id);
      if (rank === 1) top1++;
      if (rank >= 1 && rank <= SHOWN) inList++;
      if (rank === 0) missed++;
      requests += out.requests;
    }
    const n = sample.length;
    console.log(
      '    ' + pad(name, 12) + pad(pct(top1, n), 8) + pad(pct(inList, n), 9) +
      pad(pct(missed, n), 8) + (requests / n).toFixed(2)
    );
  }
  console.log('');
}

function pct(k, n) {
  return (n ? Math.round((k / n) * 100) : 0) + '%';
}
function pad(text, width) {
  const s = String(text);
  return s + ' '.repeat(Math.max(1, width - s.length));
}

db.close();
