/* The address of a scope page, derived the same way in both places that need
   it: tools/build-pages.js, which writes the files, and the app, which links
   to them. Two implementations of this would drift, and the symptom would be
   a link to a page that does not exist — the worst kind, because it looks
   fine until someone clicks it.

   Not every facet has pages. `source` is which file inside a dataset a record
   came from, and `availability` and `identifier` are states rather than
   subjects; none of them is a thing to land on from a search engine. Nor does
   every value: the generator skips scopes under five books and the values
   that name an absence, so scopePath() returning an address is a claim about
   the URL's shape, not a promise the page was built. The caller checks. */

var SCOPE_DIR = {
  publisher: 'publisher',
  classification: 'category',
  dataset: 'dataset',
  year: 'year',
  language: 'language',
};

/* Values that name the absence of a value — no page is generated for these. */
var SCOPE_PLACEHOLDERS = ['[s.n.]', '[出版者不詳]', 's.n.', '出版者不詳', 'und', ''];

function scopeSlug(value) {
  return String(value)
    .replace(/[\\/]/g, '-')          // a separator would become a directory
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[?#&%:*"<>|]/g, '')    // reserved in a URL or illegal on a filesystem
    .replace(/\s+/g, '-')            // a space becomes %20 in a URL, a split in a shell
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim()
    .replace(/^\.+/, '')             // no dotfiles, no traversal
    .slice(0, 80)
    .replace(/-+$/, '') || 'x';
}

/** The path for a facet and value, or '' where that facet has no pages. */
function scopePath(facet, value) {
  var dir = SCOPE_DIR[facet];
  if (!dir) return '';
  if (SCOPE_PLACEHOLDERS.indexOf(String(value).trim()) !== -1) return '';
  return '/' + dir + '/' + scopeSlug(value) + '/';
}

/** The same path, encoded for an href. */
function scopeHref(facet, value) {
  var p = scopePath(facet, value);
  if (!p) return '';
  return '/' + p.replace(/^\/|\/$/g, '').split('/').map(encodeURIComponent).join('/') + '/';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scopeSlug, scopePath, scopeHref, SCOPE_DIR, SCOPE_PLACEHOLDERS };
}
if (typeof window !== 'undefined') {
  window.scopePath = scopePath;
  window.scopeHref = scopeHref;
}
