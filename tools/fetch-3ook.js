#!/usr/bin/env node
'use strict';

/**
 * Records which books in this catalogue can be bought as ebooks on 3ook.com.
 *
 *   npm run 3ook                resolve anything not already cached
 *   npm run 3ook -- --refresh   re-fetch every store page
 *   npm run 3ook -- --limit 50  stop after N pages (for trying it out)
 *
 * Writes site/data/3ook.json, an ISBN → contract-address map that the browser
 * loads once and checks locally. It is small enough to ship — measured, about
 * a thousand entries — which is why the book page needs no request to 3ook at
 * all: no CORS arrangement, no latency, and no reader's browsing leaving this
 * site.
 *
 * How the two catalogues are joined, and why it is not obvious:
 *
 * 3ook is a decentralised bookstore, so its URLs are keyed by an on-chain
 * contract address — https://3ook.com/store/0x0a4c… — and carry no ISBN. The
 * ISBN is in the page's JSON-LD instead, in a block typed ["Book","Product"].
 * Measured on a random sample of 40 titles: 68% carry a usable ISBN, and 74%
 * of those are in this catalogue, so about half of 3ook's 1,927 books can be
 * linked. The rest are invisible to this and there is no honest way around it
 * — matching on title and author would produce false positives, and a wrong
 * "available" is worse than a missing one.
 *
 * robots.txt disallows /api/ and allows /store/, so this reads only what is
 * offered: the advertised sitemap, then the store pages themselves.
 *
 * There is now a public lookup at
 * api.like.co/likernft/book/store/search?isbn=… and it does not replace this.
 * It answers one ISBN at a time and refuses to enumerate — no params, limit
 * or offset all return 400 INVALID_SEARCH_QUERY — so the only way to learn
 * which books exist is still the sitemap. The site uses that endpoint for the
 * live price instead, which is the half of the problem a build artefact
 * cannot solve.
 *
 * The two agree. Of 25 ISBNs from 3ook's biggest publishers that this scrape
 * did not match, the API found none either: the 31% of store pages without an
 * ISBN genuinely have none, rather than hiding it from the JSON-LD.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'site', 'data');
const OUT = path.join(DATA_DIR, '3ook.json');
const CACHE = path.join(ROOT, 'cache', '3ook.json');

const SITEMAP = 'https://3ook.com/sitemap_index.xml';
const BASE = 'https://3ook.com/store/';
const UA = 'jimbocho/1.0 (+https://jimbocho.app; 3ook availability)';

const CONCURRENCY = 4;        // polite, even though both sites are the same hands
const TIMEOUT_MS = 25000;
// The Book JSON-LD sits about 41% into a 170 KB page and the isbn at 54%, so
// the request is dropped as soon as a complete block has been seen. That is
// roughly 40% of the transfer not made, across ~1,900 pages.
const MAX_BYTES = 140 << 10;

const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');
const LIMIT = Number(args[args.indexOf('--limit') + 1] || 0) || Infinity;

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

async function main() {
  console.log('Reading 3ook.com’s sitemap…');
  const addresses = await storeAddresses();
  console.log('  ' + addresses.length.toLocaleString() + ' store pages listed');

  const cache = REFRESH ? {} : loadCache();
  const missing = addresses.filter((a) => !(a in cache));
  const todo = missing.slice(0, LIMIT);
  console.log(
    '  ' + (addresses.length - missing.length).toLocaleString() + ' already cached, ' +
    missing.length.toLocaleString() + ' missing' +
    (todo.length < missing.length ? ', fetching ' + todo.length.toLocaleString() + ' (--limit)' : '')
  );

  let done = 0;
  await pool(todo, CONCURRENCY, async (addr) => {
    cache[addr] = await bookAt(addr);
    if (++done % 100 === 0 || done === todo.length) {
      process.stdout.write('  ' + done.toLocaleString() + '/' + todo.length.toLocaleString() + '\r');
      saveCache(cache);
    }
  });
  if (todo.length) process.stdout.write('\n');
  saveCache(cache);

  // Only the addresses still in the sitemap: a book pulled from sale should
  // stop being advertised here, and the cache is not the authority on that.
  const live = new Set(addresses);
  const books = {};
  let withIsbn = 0;
  for (const addr of addresses) {
    const rec = cache[addr];
    if (!rec || !rec.isbn || !live.has(addr)) continue;
    withIsbn++;
    // Two editions can share an ISBN. First wins, deterministically, because
    // the sitemap order is stable; the alternative is an arbitrary one.
    if (!(rec.isbn in books)) books[rec.isbn] = addr;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'https://3ook.com/',
    base: BASE,
    catalogue: addresses.length,
    withIsbn: withIsbn,
    books: books,
  };
  fs.writeFileSync(OUT, JSON.stringify(out) + '\n');

  const bytes = fs.statSync(OUT).size;
  console.log(
    '\n  ' + Object.keys(books).length.toLocaleString() + ' ISBNs → site/data/3ook.json (' +
    (bytes / 1024).toFixed(0) + ' KB)'
  );
  const known = addresses.filter((a) => a in cache).length;
  console.log(
    '  ' + withIsbn.toLocaleString() + ' of the ' + known.toLocaleString() +
    ' pages read so far carried a usable ISBN (' + Math.round((withIsbn / Math.max(known, 1)) * 100) + '%)'
  );
  if (known < addresses.length) {
    console.log(
      '  ' + (addresses.length - known).toLocaleString() + ' not yet read — re-run without --limit.'
    );
  }
}

/** Every /store/<address> in the advertised sitemap, deduplicated. */
async function storeAddresses() {
  const index = await get(SITEMAP);
  const maps = locs(index);
  // Both locales list the same books; one is enough, and zh-HK is the one
  // this site is written in.
  const pick = maps.filter((u) => /zh-HK/.test(u)).concat(maps);
  if (!pick.length) throw new Error('sitemap index listed no sitemaps');

  const seen = new Set();
  const body = await get(pick[0]);
  for (const u of locs(body)) {
    const m = /\/store\/(0x[0-9a-fA-F]{40})\b/.exec(u);
    if (m) seen.add(m[1].toLowerCase());
  }
  if (!seen.size) throw new Error('no /store/0x… URLs found in ' + pick[0]);
  return [...seen].sort();
}

function locs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/** The ISBN and title for one store page, or an empty record. */
async function bookAt(addr) {
  let html;
  try {
    html = await get(BASE + addr);
  } catch (err) {
    return { isbn: '', error: String((err && err.message) || err) };
  }
  for (const block of ldBlocks(html)) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch (err) {
      continue;
    }
    for (const o of Array.isArray(parsed) ? parsed : [parsed]) {
      const types = [].concat(o && o['@type'] ? o['@type'] : []);
      if (!types.includes('Book')) continue;
      return { isbn: isbn13(o.isbn), name: String(o.name || '').slice(0, 120) };
    }
  }
  return { isbn: '' };
}

function ldBlocks(html) {
  const out = [];
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/**
 * A real ISBN-13, or ''. The prefix check is not pedantry: a sampled title
 * carried 1230010007563, which is an internal distributor id shaped like an
 * ISBN. Only 978 and 979 are Bookland, and books.db stores 13 bare digits, so
 * anything else would simply never match and would look like a bug here.
 */
function isbn13(value) {
  const digits = String(value || '').replace(/[^0-9Xx]/g, '');
  return /^97[89][0-9]{10}$/.test(digits) ? digits : '';
}

function get(url, depth) {
  const hop = depth || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xml' } }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (hop >= 4) return reject(new Error('too many redirects: ' + url));
        return resolve(get(new URL(res.headers.location, url).href, hop + 1));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + code + ' for ' + url));
      }
      let text = '';
      // Dropping the connection early surfaces as an error, not an 'end', so
      // this says whether the text in hand is complete enough to use or the
      // request genuinely failed.
      req._enough = false;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        // Enough of the document to hold the Book block; see MAX_BYTES.
        if (!req._enough && text.length > MAX_BYTES && /"@type"\s*:\s*\[?[^\]]*"Book"/.test(text)) {
          req._enough = true;
          req.destroy();
        }
      });
      res.on('end', () => resolve(text));
      res.on('error', () => (req._enough ? resolve(text) : reject(new Error('stream error: ' + url))));
      req.on('close', () => { if (req._enough) resolve(text); });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout: ' + url)));
    req.on('error', (err) => { if (!req._enough) reject(err); });
  });
}

async function pool(items, size, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(runners);
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch (err) {
    return {};
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache));
}
