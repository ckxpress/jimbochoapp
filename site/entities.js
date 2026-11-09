/**
 * HTML character references, undone.
 *
 * One implementation, two consumers, as with the tokenizer and the dedupe
 * key: the importer decodes on the way in so the catalogue stores the real
 * characters, and the page decodes on the way out so the records already in
 * R2 read correctly before the next rebuild reaches them.
 */
/**
 * The named character references worth carrying.
 *
 * Not the full HTML set, which is some 2,200 entries, nearly all of them for
 * symbols that do not occur in a book title. This covers the five XML ones,
 * the punctuation a cataloguer's keyboard produces, and the Greek alphabet,
 * which is here because 《我的命定之人是高貴&Omega;》 is a real record and the
 * Ω is part of the title. Anything outside this map is left exactly as it
 * was found rather than guessed at, and shows up in the data as itself.
 */
var ENTITIES = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'",
  nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', shy: '\u00ad',
  ndash: '–', mdash: '—', horbar: '―', hellip: '…', bull: '•', middot: '·',
  lsquo: '\u2018', rsquo: '\u2019', sbquo: '‚', ldquo: '\u201c', rdquo: '\u201d', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', prime: '′', Prime: '″',
  dagger: '†', Dagger: '‡', sect: '§', para: '¶', copy: '©', reg: '®', trade: '™',
  deg: '°', plusmn: '±', times: '×', divide: '÷', minus: '−', frasl: '⁄',
  frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³',
  permil: '‰', micro: 'µ', ordm: 'º', ordf: 'ª', iexcl: '¡', iquest: '¿',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ',
  Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν',
  Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ',
  Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigmaf: 'ς', sigma: 'σ', tau: 'τ',
  upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
};

/**
 * Turn HTML character references back into the characters they stand for.
 *
 * Library catalogues hand out HTML-escaped text — 30 titles in this
 * catalogue read "&lt;&lt;街頭巷尾&gt;&gt;咖啡小日曆" rather than
 * "<<街頭巷尾>>咖啡小日曆" — and nothing downstream was undoing it, so the
 * escaping was stored, indexed and finally shown to the reader as itself.
 *
 * One pass, deliberately. "&amp;lt;" becomes "&lt;" and stops there, which
 * is what genuinely double-escaped text means; decoding until nothing
 * changes would turn a title that really does contain "&lt;" into one
 * containing "<", and there is no way to tell those apart afterwards.
 *
 * Surrogate pairs are rejected rather than decoded on their own: a lone
 * surrogate is not a character and would corrupt the string it lands in.
 */
function decodeEntities(text) {
  var s = String(text == null ? '' : text);
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#[Xx][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, function (match, body) {
    if (body.charAt(0) === '#') {
      var hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      var code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : match;
  });
}


if (typeof module !== 'undefined' && module.exports) {
  module.exports = { decodeEntities: decodeEntities, ENTITIES: ENTITIES };
}

if (typeof window !== 'undefined') {
  window.decodeEntities = decodeEntities;
}
