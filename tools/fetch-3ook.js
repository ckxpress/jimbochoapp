#!/usr/bin/env node
'use strict';

/**
 * Records which books in this catalogue can be bought as ebooks on 3ook.com.
 *
 *   npm run 3ook
 *
 * Writes site/data/3ook-links.json, an ISBN → contract-address map that the browser
 * loads once on the first book page and checks locally. A book page therefore
 * asks 3ook nothing unless the book is actually theirs, and then only for the
 * live price.
 *
 * This used to read 3ook's sitemap and then all 1,909 store pages for the
 * ISBN buried in each one's JSON-LD: 267 MB a run, thirteen minutes, and a
 * third of the catalogue invisible because its JSON-LD carried no ISBN. 3ook
 * now publishes the catalogue directly, so none of that is necessary.
 *
 *   https://api.like.co/likernft/book/store/list?limit=100
 *
 * Measured when the feed replaced the scrape:
 *
 *   titles seen        1,909 -> 2,255   the sitemap never listed 346 of them
 *   usable ISBN-13s    1,320 -> 1,396
 *   matched in here      930 ->   978
 *   requests           1,909 ->     24
 *
 * Two files come out of one read. site/data/3ook-links.json is the link map the
 * site ships. cache/3ook-feed.json is the records themselves, which
 * tools/adapters/3ook.js turns into catalogue entries — the ~500 titles 3ook
 * carries that never had an ISBN and so appear in no registry here.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
// Not 3ook.json: the dataset registered as `3ook` owns every
// site/data/3ook.* file, and tools/import.js deletes that whole prefix
// before writing its shards. This file was silently removed by the first
// import run that followed.
const OUT = path.join(ROOT, 'site', 'data', '3ook-links.json');
// The records themselves, for tools/adapters/3ook.js. Not in site/data: this
// is import input, not something the site serves, and it is regenerated in
// seconds so it is not worth keeping in history either.
const FEED_OUT = path.join(ROOT, 'cache', '3ook-feed.json');

const FEED = 'https://api.like.co/likernft/book/store/list';
const LIMIT = 100;          // 500 is rejected; 100 comes back as 96–100
const BASE = 'https://3ook.com/store/';
const UA = 'jimbocho/1.0 (+https://jimbocho.app; 3ook availability)';
const TIMEOUT_MS = 30000;
const MAX_PAGES = 200;      // ~20 are needed; a guard against a paging loop

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

async function main() {
  console.log('Reading 3ook.com’s catalogue…');
  const items = await readFeed();
  console.log('  ' + items.length.toLocaleString() + ' titles');

  fs.mkdirSync(path.dirname(FEED_OUT), { recursive: true });
  fs.writeFileSync(FEED_OUT, JSON.stringify(items) + '\n');
  console.log('  → cache/3ook-feed.json (' +
    (fs.statSync(FEED_OUT).size / 1048576).toFixed(1) + ' MB) for `npm run import -- 3ook`');

  const books = {};
  let withIsbn = 0;
  for (const b of items) {
    const isbn = isbn13(b.isbn);
    if (!isbn) continue;
    withIsbn++;
    // Two editions can share an ISBN. First wins, deterministically, because
    // the feed's order is stable.
    if (!(isbn in books)) books[isbn] = String(b.id);
  }

  const previous = readPrevious();
  const unchanged = previous && sameMap(previous.books, books);

  const out = {
    // Kept from the previous run when nothing moved. Otherwise this field
    // alone differs on every run, the file always looks changed, and the
    // daily workflow commits and redeploys the site for nothing — which is
    // what the three identical "1,320 ISBNs of 1,909 titles" commits were.
    generatedAt: unchanged ? previous.generatedAt : new Date().toISOString(),
    source: FEED,
    base: BASE,
    catalogue: items.length,
    withIsbn: withIsbn,
    books: books,
  };
  fs.writeFileSync(OUT, JSON.stringify(out) + '\n');

  const bytes = fs.statSync(OUT).size;
  console.log('  ' + Object.keys(books).length.toLocaleString() + ' ISBNs → ' +
    path.relative(ROOT, OUT) + ' (' + (bytes / 1024).toFixed(0) + ' KB)');
  console.log('  ' + withIsbn.toLocaleString() + ' of ' + items.length.toLocaleString() +
    ' titles carried a usable ISBN (' + Math.round((withIsbn / Math.max(items.length, 1)) * 100) + '%)');
  if (unchanged) console.log('  Unchanged since the last run.');
}

/** Every title in the feed, paging on the key it hands back. */
async function readFeed() {
  const items = [];
  const seen = new Set();
  let key = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = FEED + '?limit=' + LIMIT + (key ? '&key=' + encodeURIComponent(key) : '');
    const data = JSON.parse(await get(url));
    const batch = Array.isArray(data.list) ? data.list : [];
    let added = 0;
    for (const b of batch) {
      if (!b || !b.id || seen.has(b.id)) continue;
      seen.add(b.id);
      items.push(b);
      added++;
    }
    key = data.nextKey;
    // No key, an empty page, or a page that was entirely a repeat: the three
    // ways this ends. The last one matters — `nextKey` is echoed back
    // unchanged for a parameter it does not recognise, which would otherwise
    // spin here forever.
    if (!key || !batch.length || !added) break;
    if (process.stdout.isTTY) process.stdout.write('  ' + items.length.toLocaleString() + '\r');
  }
  if (process.stdout.isTTY) process.stdout.write('\r');
  return items;
}

/**
 * A real ISBN-13, or ''. The feed hyphenates — 978-962-7985-46-4 — and
 * books.db stores thirteen bare digits, so they are stripped. The prefix
 * check is not pedantry: 42 of the feed's isbn fields are not Bookland at
 * all, and one sampled title carried 1230010007563, an internal distributor
 * id shaped like an ISBN, which would match nothing and look like a bug.
 */
function isbn13(value) {
  const raw = value && typeof value === 'object'
    ? (value.name || value.zh || value.en || '')
    : value;
  const digits = String(raw == null ? '' : raw).replace(/[^0-9Xx]/g, '');
  return /^97[89][0-9]{10}$/.test(digits) ? digits : '';
}

function readPrevious() {
  try {
    return JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch (err) {
    return null;
  }
}

function sameMap(a, b) {
  if (!a || typeof a !== 'object') return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

function get(url, depth) {
  const hop = depth || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': UA, accept: 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hop >= 4) return reject(new Error('too many redirects: ' + url));
        return resolve(get(new URL(res.headers.location, url).href, hop + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve(text));
      res.on('error', reject);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout: ' + url)));
    req.on('error', reject);
  });
}
