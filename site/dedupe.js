
/**
 * When two records are the same book, for display purposes only.
 *
 * The catalogue holds sixteen datasets side by side rather than merged,
 * because provenance is part of what it is for and a bad import has to stay
 * removable. The cost is that one book can appear several times: a title is
 * registered for an ISBN, catalogued by the national library, and held by a
 * university, and all three rows are true.
 *
 * Measured over 446,090 records, the shapes that produces are not all the
 * same thing, and the difference decides the rule below.
 *
 *   9789888111183   166 records, 123 distinct titles, 10 sources
 *                   — Halsbury's Laws of Hong Kong, where every volume of a
 *                     loose-leaf service carries the set's one ISBN.
 *   9789866543128    34 records, one title, one dataset
 *                   — 民間私藏臺灣宗教資料彙編, whose volume number lives in
 *                     the subtitle: 第一輯(一), 第一輯(七), 第一輯(三十).
 *   9786267807392     6 records, one title, one subtitle, one year
 *                   — 從台灣看懂國際金融, catalogued five times in NBINet for
 *                     five holding libraries and once in the ISBN feed. The
 *                     six rows differ in nothing a reader can see.
 *
 * So ISBN alone is not a book's identity here: grouping on it would fold 123
 * volumes of Halsbury into one card. The title is not enough either, and nor
 * is the title plus the ISBN, because the volume number is in the subtitle.
 *
 * The rule is therefore the conjunction of everything a reader could use to
 * tell two cards apart: ISBN, display title, subtitle and year. Records that
 * agree on all four are indistinguishable on screen, so showing six of them
 * tells the reader nothing the first one did not. Records that differ in any
 * of them keep their own card, even when they share an ISBN.
 *
 * Over the whole catalogue that is 8,103 groups covering 16,560 records —
 * 8,457 cards that were repeating themselves. Deliberately left alone:
 *
 *   9780190481667   hkpl-2017  牛   · 吳煦斌   · 牛津大學出版社(中國)有限公司
 *                   ol-hk      Niu · Wu Xubin · Oxford University Press
 *
 * One book, two useful forms, and no way to pick between them that does not
 * throw away a name somebody searches by. Those stay as two cards, and the
 * book page lists every record sharing an ISBN so the other form is one click
 * away rather than merged out of sight.
 *
 * Nothing here touches the database, the counts or the filters. 共 446,090
 * 筆書目 remains a count of records, which is what it says; this only decides
 * when two of them share a card.
 */

/* Whitespace and ISBD punctuation, in both widths. Cataloguers punctuate the
   same title differently — "民事訴訟程序 : 高等法院" against
   "民事訴訟程序：高等法院" — and case differs across datasets ("High Court"
   against "high court"), so neither can be part of an identity test. Digits,
   letters and CJK survive, which is what distinguishes 第一輯(一) from
   第一輯(七). */
var DEDUPE_STRIP = /[\s　.．。,，、:：;；=＝/／\-－–—]+/g;

function dedupeNorm(text) {
  return String(text == null ? '' : text)
    .replace(DEDUPE_STRIP, '')
    .toLowerCase();
}

/**
 * The display group a record belongs to, or '' for a record that belongs to
 * none and always gets its own card.
 *
 * `title` is passed in rather than read off the record: which of a record's
 * titles is displayed is the app's decision (the Chinese form leads where a
 * record has one), and two records are only interchangeable on screen if the
 * titles actually shown are the same.
 *
 * No ISBN, no group. A shared title across two sources is a coincidence as
 * often as it is a match — 446,090 records hold 37,000 titles that repeat —
 * and without an identifier there is nothing to confirm it with.
 */
function dedupeKey(row, title) {
  if (!row) return '';
  var isbn = String(row.isbn || '').replace(/[^0-9Xx]/g, '');
  if (!isbn) return '';
  return (
    isbn.toUpperCase() +
    '|' + dedupeNorm(title) +
    '|' + dedupeNorm(row.subtitle) +
    '|' + (row.year ? String(row.year) : '')
  );
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { dedupeKey: dedupeKey, dedupeNorm: dedupeNorm };
}

if (typeof window !== 'undefined') {
  window.dedupeKey = dedupeKey;
}
