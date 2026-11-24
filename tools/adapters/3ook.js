'use strict';

const { buildRecord } = require('../lib/record');

/**
 * 3ook.com's catalogue, as its store feed returns it.
 *
 *   https://api.like.co/likernft/book/store/list?limit=100
 *
 * Written to cache/3ook-feed.json by tools/fetch-3ook.js, which pages the
 * feed; this adapter only maps. The same run also writes site/data/3ook-links.json,
 * the ISBN-to-link map that puts a "buy the ebook" link on a book page — a
 * different job from this one, which is about the books 3ook carries that
 * nothing else here does.
 *
 * Why import a bookshop into a catalogue of registries at all: 2,255 titles,
 * of which about 1,750 are already held here under an ISBN from NCL or HKPL,
 * and about 500 are not held anywhere. Those 500 are self-published work,
 * periodicals and Hong Kong literary titles — 《破週報》, 科學月刊, 潘國靈
 * 《離》 — which never had an ISBN, so never entered a national bibliography,
 * so are invisible to every other source here. That is the whole case.
 *
 * What these records are thin on, measured across the feed:
 *
 *   author          100%
 *   keywords         99%
 *   cover            94%   (via imageUrl; thumbnailUrl is an ar:// URI)
 *   language         91%
 *   publisher        81%
 *   isbn             64%
 *   datePublished     3%   <- almost nothing has a publication date
 *
 * The year is the one that hurts, because browsing here is year-led. There
 * is a `timestamp` on every record and it is tempting, but it is the date the
 * book was listed on 3ook — the range is 2023-06 to today — so writing it
 * into `year` would state something false about the book. These records
 * mostly carry no year, which is what the source knows.
 */

/** zh-Hant, zh-TW and zh all mean the same shelf here; ja-JP means ja. */
function language(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  if (v.startsWith('zh')) return 'zh';
  return v.split(/[-_]/)[0];
}

/**
 * A cover the browser can actually load.
 *
 * `thumbnailUrl` is an `ar://` Arweave URI on 2,112 of 2,255 records, which
 * no browser resolves; `imageUrl` is the same object through an HTTPS
 * gateway. There is no smaller rendition — both fields name the same id — so
 * these are full-size images, measured at 400 KB to 1 MB. Tolerable only
 * because the grid defers loading until a card is in view; worth asking 3ook
 * for a thumbnail size.
 */
/* The grid draws a cover at 161x243 CSS pixels. `thumbnailUrl` is not a
 * thumbnail — it is the full artwork the shop sells the book with, measured
 * at 1141x1600 and a median of 271 KB, with one at 2.5 MB, served
 * `cf-cache-status: DYNAMIC` so every reader fetches it from origin. Eighteen
 * of those is a grid that fills in long after the titles do, which reads as
 * covers that are missing rather than covers that are late.
 *
 * The feed now carries renditions: thumbnails.small is 300px wide and the
 * same cover above came back 33 KB and `cf-cache-status: HIT` — 79 times
 * smaller, and in the same range as the OpenLibrary covers beside it
 * (16-51 KB). That is what belongs in the column.
 *
 * Order matters below: small first, then the originals, which still carry
 * records the renditions have not reached. */
function coverUrl(b) {
  const small = b.thumbnails && b.thumbnails.small && b.thumbnails.small.url;
  for (const u of [small, b.imageUrl, b.thumbnailUrl, b.productImageUrl]) {
    if (typeof u === 'string' && /^https?:\/\//.test(u)) return u;
  }
  return '';
}

/** publisher and author arrive as a string, an object, or null. */
function text(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    return String(value.name || value.zh || value['zh-Hant'] || value.en || '').trim();
  }
  return String(value).trim();
}

/**
 * One `author` string sometimes names several people —
 * "李芝蘭、巫麗蘭、陳浩文、甘翠萍 編著". Left whole they become one
 * implausible author that no search for any of them finds.
 *
 * Split on 、；; and | and nothing else, which is what pickList() does for
 * every other adapter here. Not on the comma: a comma marks an inverted name
 * in this catalogue, and displayName() relies on it to turn "Garrett,
 * Randall" into "Randall Garrett". Splitting there turned one Randall
 * Garrett into three authors, the third of them "1927-1987".
 */
function authors(value) {
  return text(value)
    .split(/\s*[、；;|]\s*/)
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function parse(ctx) {
  const data = JSON.parse(ctx.text);
  const rows = Array.isArray(data) ? data : data.list || data.records || [];
  if (!Array.isArray(rows)) throw new Error('3ook feed did not contain an array of records');

  return rows
    .filter((b) => b && b.id && text(b.name))
    .map((b) => {
      const price = (b.prices && b.prices[0]) || {};
      const hkd = price.priceInDecimalByCurrency && price.priceInDecimalByCurrency.hkd;

      return buildRecord(
        {
          title: text(b.name),
          authors: authors(b.author),
          publisher: text(b.publisher),
          // 3% of records; the rest have none and are left without one rather
          // than given the listing date.
          year: b.datePublished || '',
          isbn: text(b.isbn),
          language: language(b.inLanguage),
          description: text(b.description),
          coverUrl: coverUrl(b),
          // The on-chain class id, which is also the store URL's last segment
          // and therefore how a record here points back at the shop.
          ref: String(b.id),
          // Priced in cents by currency; `price` on the record is USD, which
          // is not what this site quotes anywhere else.
          price: typeof hkd === 'number' ? hkd / 100 : '',
          forSale: b.isSoldOut ? 'false' : 'true',
          // usageInfo is the licence of the book's own content — 2,019 of
          // them "All Rights Reserved" — not of this metadata, so it is
          // recorded as a note rather than mistaken for a copyright line.
          notes: b.usageInfo ? '授權：' + text(b.usageInfo) : '',
        },
        ctx
      );
    });
}

module.exports = { parse, id: '3ook', label: '3ook.com store feed' };
