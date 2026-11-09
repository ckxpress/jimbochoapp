'use strict';

/**
 * Turns catalogue-style (ISBD) fields into the flat metadata record the site
 * renders. Shared by every adapter so all datasets end up the same shape.
 */

const DERIVED = 'derived';

/**
 * ISBD title: "Main title : subtitle = parallel title / statement of responsibility."
 */
function parseTitle(raw) {
  const out = { titleFull: clean(raw) };
  if (!out.titleFull) return { titleFull: '', title: '' };

  let work = out.titleFull;

  const sorAt = work.indexOf(' / ');
  if (sorAt !== -1) {
    out.statementOfResponsibility = trimEnd(work.slice(sorAt + 3));
    work = work.slice(0, sorAt);
  }

  const parallelAt = work.indexOf(' = ');
  if (parallelAt !== -1) {
    out.parallelTitle = trimEnd(work.slice(parallelAt + 3));
    work = work.slice(0, parallelAt);
  }

  const subAt = work.indexOf(' : ');
  if (subAt !== -1) {
    out.subtitle = trimEnd(work.slice(subAt + 3));
    work = work.slice(0, subAt);
  }

  out.title = trimEnd(work) || out.titleFull;
  return out;
}

/**
 * "978-988-70778-1-7 (pbk.) :" -> [{ value, isbn13, isbn10, qualifier }]
 * A record may list several (paperback / hardback / set).
 */
function parseIsbns(raw) {
  const text = clean(raw);
  if (!text) return [];

  const out = [];
  const seen = new Set();
  const re = /(\d[\d\- ]{8,20}[\dXx])\s*(\([^)]*\))?/g;
  let m;

  while ((m = re.exec(text)) !== null) {
    const value = m[1].replace(/\s+/g, '');
    const digits = value.replace(/-/g, '').toUpperCase();
    if (digits.length !== 10 && digits.length !== 13) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);

    const entry = { value: value };
    if (digits.length === 13) {
      entry.isbn13 = digits;
      const ten = isbn13to10(digits);
      if (ten) entry.isbn10 = ten;
    } else {
      entry.isbn10 = digits;
      entry.isbn13 = isbn10to13(digits);
    }
    const qualifier = m[2] ? m[2].replace(/^\(|\)$/g, '').trim() : '';
    if (qualifier) entry.qualifier = qualifier;
    out.push(entry);
  }

  return out;
}

function parseIssn(raw) {
  const m = clean(raw).match(/\d{4}-?\d{3}[\dXx]/);
  return m ? m[0].toUpperCase().replace(/^(\d{4})(\d)/, '$1-$2') : '';
}

/** "$108.00" -> 108, HKD.  "Unpriced (pbk.)" / "" -> no amount. */
function parsePrice(raw, forSaleRaw, defaultCurrency) {
  const text = clean(raw);
  const price = {};
  if (text) price.raw = text;

  const m = text.match(/(HK\$|US\$|NT\$|RMB|CNY|USD|HKD|GBP|EUR|JPY|TWD|MOP|SGD|AUD|CAD|\$|£|€|¥|元)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (m && !/unpriced/i.test(text)) {
    const amount = Number(m[2].replace(/,/g, ''));
    if (!Number.isNaN(amount)) {
      price.amount = amount;
      price.currency = currencyOf(m[1], defaultCurrency);
    }
  }

  const sale = clean(forSaleRaw);
  if (sale) {
    price.availability = sale.replace(/\s+/g, ' ');
    if (/^(not for sale|非賣品)/i.test(sale)) price.forSale = false;
    else if (/(for sale|售賣品)/i.test(sale)) price.forSale = true;
  }

  return Object.keys(price).length ? price : null;
}

/**
 * Prices appear as "$108.00", "CNY99.00", "US$12", "RMB 45". A bare "$" is
 * ambiguous, so it resolves to the dataset's own currency (HKD by default).
 */
function currencyOf(symbol, defaultCurrency) {
  const fallback = defaultCurrency || 'HKD';
  const s = String(symbol || '').toUpperCase();
  if (!s || s === '$' || s === 'HK$' || s === '元') return fallback;
  if (s === 'US$') return 'USD';
  if (s === 'NT$') return 'TWD';
  if (s === 'RMB' || s === '¥') return 'CNY';
  if (s === '£') return 'GBP';
  if (s === '€') return 'EUR';
  if (/^[A-Z]{3}$/.test(s)) return s;
  return fallback;
}

/**
 * "256 p. : col. ill. ; 29 cm."  /  "24 厘米 166 頁  插圖"
 */
function parsePhysical(raw) {
  const text = clean(raw);
  if (!text) return null;

  const out = { raw: text };
  const pages = text.match(/(\d+)\s*(?:p\.|pages|頁)/i);
  if (pages) out.pages = Number(pages[1]);
  // "29 cm." but also "19 x 27 厘米" — keep both figures.
  const size = text.match(/(\d+\s*(?:x|×|X)\s*\d+|\d+)\s*(?:cm|厘米|公分)/i);
  if (size) out.dimensions = size[1].replace(/\s*[xX×]\s*/, ' × ') + ' cm';
  if (/(ill\.|illus|插圖|圖片)/i.test(text)) out.illustrated = true;
  return out;
}

/** "(香港皇冠叢書 ; 第1491種)" -> { title, number } */
function parseSeries(raw) {
  let text = clean(raw);
  if (!text) return null;
  text = text.replace(/^\(/, '').replace(/\)$/, '').trim();
  if (!text) return null;

  const out = { raw: text };
  const parts = text.split(/\s*;\s*/);
  out.title = trimEnd(parts[0]);
  if (parts.length > 1) out.number = trimEnd(parts.slice(1).join('; '));
  return out;
}

/** Person names in the source are inverted ("Cheung, Ysabelle"). */
/**
 * Names in library records are inverted — "Grove, Jairus Victor" — and read
 * better the other way round. But only *personal* names are inverted that way.
 * A corporate or conference heading uses commas for something else entirely:
 *
 *   Asian Criminology Conference (3rd : 2011 : Taipei, Taiwan)
 *
 * Flipping that on its comma produced "Taiwan) Asian Criminology Conference
 * (3rd : 2011 : Taipei". So a heading carrying a parenthesis, or a word that
 * only an organisation has, is left exactly as catalogued. That is also the
 * better outcome for a personal name given with a romanised form in brackets,
 * "咚東 (Dong Dong)", which should not be reordered either.
 */
const CORPORATE = /[()（）]|\b(conference|society|meeting|association|committee|institute|university|college|school|museum|library|company|corporation|council|foundation|symposium|workshop|congress|dept|department|ltd|inc)\b|大學|公司|學會|協會|研究所|研究院|工作室|委員會|基金會|出版社|圖書館|博物館|事務所/i;

function displayName(name) {
  const text = clean(name);
  if (!text) return '';
  if (/[㐀-鿿]/.test(text)) return text;
  if (CORPORATE.test(text)) return text;
  const parts = text.split(',');
  if (parts.length === 2 && parts[1].trim() && parts[1].length < 40) {
    return trimEnd(parts[1]) + ' ' + trimEnd(parts[0]);
  }
  return text;
}

/**
 * The registration catalogue carries no abstracts, so compose a factual
 * summary from the fields that do exist. Flagged as derived in the UI.
 */
/* Derived identically in the browser, which now computes these rather than
   reading them out of the database — see site/derive.js for why. One
   implementation, two consumers, as with the tokenizer. */
const { buildDescription, buildCopyright } = require('./derive');

function isbn10to13(isbn10) {
  const core = '978' + isbn10.slice(0, 9);
  return core + checkDigit13(core);
}

function isbn13to10(isbn13) {
  if (!isbn13.startsWith('978')) return '';
  const core = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(core[i]);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? 'X' : String(check));
}

function checkDigit13(core12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

/* One implementation, two consumers, as with the tokenizer. */
const { decodeEntities } = require('../../site/entities.js');

function clean(value) {
  // Decoding before the whitespace collapse, so that a &nbsp; or &#10; is
  // whitespace by the time the collapse runs rather than afterwards.
  return decodeEntities(String(value === undefined || value === null ? '' : value))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop the trailing ISBD punctuation ("... 2024. :" -> "... 2024"). */
function trimEnd(value) {
  return clean(value).replace(/[\s.,:;/=]+$/, '').trim();
}

function compact(obj) {
  const out = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out;
}

module.exports = {
  parseTitle,
  parseIsbns,
  parseIssn,
  parsePrice,
  parsePhysical,
  parseSeries,
  displayName,
  buildDescription,
  buildCopyright,
  isbn10to13,
  isbn13to10,
  clean,
  decodeEntities,
  trimEnd,
  compact,
  DERIVED,
};
