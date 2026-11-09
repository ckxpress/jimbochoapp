
/**
 * The two record fields the catalogue does not supply, derived identically by
 * the database builder and the browser.
 *
 * Neither upstream catalogue carries a blurb or a rights statement. Both are
 * written here from fields that do exist, and marked `derived` so the page can
 * say so rather than passing them off as the publisher's own words.
 *
 * Why this file exists at all: stored, they were 377 of the 1,240 bytes each
 * record cost in the `docs` table — about 168 MB across 446,090 books, in a
 * database that has to stay under Cloudflare's 512 MB cacheable ceiling. They
 * are a pure function of fields the browser already has, so the browser
 * computes them and the database does not carry them. Shared rather than
 * reimplemented, on the same reasoning as tokenize.js: two copies of a
 * formatting rule drift, and the page would start describing books
 * differently from the way the build described them.
 */

var DERIVE_DERIVED = 'derived';

function buildDescription(rec) {
  var zh = rec.language === 'zh';
  var bits = [];

  var kind = rec.classification || (zh ? '書刊' : 'Title');
  var place = rec.place || (zh ? '香港' : 'Hong Kong');

  if (zh) {
    bits.push(
      (kind + '類書刊，' + (rec.publisher ? '由' + rec.publisher : '') + (rec.year ? '於' + rec.year + '年' : '') +
        '在' + place + '出版。').replace(/，，/g, '，')
    );
    if (rec.edition) bits.push(rec.edition + '。');
    if (rec.physical && rec.physical.raw) bits.push(rec.physical.raw + '。');
    if (rec.series && rec.series.raw) bits.push('叢書：' + rec.series.raw + '。');
    if (rec.notes) bits.push(rec.notes + '。');
    return { text: bits.join('').replace(/。+/g, '。').trim(), source: DERIVE_DERIVED };
  }

  var s = kind + ' published in ' + place;
  if (rec.publisher) s += ' by ' + rec.publisher;
  if (rec.year) s += ' in ' + rec.year;
  bits.push(s + '.');

  if (rec.edition) bits.push(rec.edition.replace(/\.?$/, '.'));
  if (rec.physical && rec.physical.raw) bits.push(rec.physical.raw.replace(/\.?$/, '.'));
  if (rec.series && rec.series.raw) bits.push('Series: ' + rec.series.raw + '.');
  if (rec.notes) bits.push(rec.notes.replace(/\.?$/, '.'));

  return { text: bits.join(' ').replace(/\s+/g, ' ').trim(), source: DERIVE_DERIVED };
}

/**
 * No copyright column exists upstream; the defensible reading is
 * publisher + year of publication, so state it and mark it derived.
 */
function buildCopyright(rec) {
  if (!rec.year && !rec.publisher) return null;
  var holder = rec.publisher || '';
  var parts = ['©'];
  if (rec.year) parts.push(String(rec.year));
  if (holder) parts.push(holder);
  return { year: rec.year || null, holder: holder || null, statement: parts.join(' '), source: DERIVE_DERIVED };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildDescription: buildDescription, buildCopyright: buildCopyright, DERIVED: DERIVE_DERIVED };
}

/* Shared by the database builder (Node) and the browser, the same way
   tokenize.js is. tools/lib/derive.js re-exports it. */
if (typeof window !== 'undefined') {
  window.buildDescription = buildDescription;
  window.buildCopyright = buildCopyright;
}
