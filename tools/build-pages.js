#!/usr/bin/env node
/**
 * A real page per browsable scope, so the catalogue has addresses.
 *
 * Why this exists: on 24 Nov 2026 Google had indexed exactly one URL of this
 * site. Search Console's live test confirmed Googlebot does render the app —
 * covers, titles, the live count, all present — so rendering was never the
 * problem. Addressing was. The app routes on the URL hash, and a fragment is
 * not a separate URL, so 448,000 books and 766 scopes were one result that
 * could only ever match the word "jimbocho".
 *
 * Each page here carries its scope's first 60 books as ordinary HTML — title,
 * author, publisher, year, cover — with the title and description in the
 * markup rather than fetched afterwards. Google need not boot a browser to
 * read them, which at this many pages is the difference between being crawled
 * and being crawled eventually.
 *
 * These are generated into the publish directory and never committed. They
 * are derivable from site/data/page/*.json and the manifest, both of which
 * are in git, and ~600 files of regenerated HTML every week is exactly the
 * kind of thing site/data/books.db was kept out of history for.
 *
 * Usage: node tools/build-pages.js <dest>        (default _site)
 */

const fs = require('fs');
const path = require('path');
/* One implementation of the slug, shared with the app so a link in the
   catalogue and the file this writes cannot disagree. */
const { scopeSlug, SCOPE_PLACEHOLDERS, SCOPE_DIR } = require('../site/scope-path.js');

const ROOT = path.join(__dirname, '..');
const DEST = path.resolve(process.argv[2] || path.join(ROOT, '_site'));
const ORIGIN = 'https://jimbocho.app';

/* Which facets earn a page.
 *
 * `source` is which file inside a dataset a record came from — plumbing, of
 * interest to nobody searching for a book. `availability` and `identifier`
 * are states, not subjects. Publishing those would be ~160 pages competing
 * with the ones that matter for the same crawl budget. */
const FACETS = {
  publisher: { dir: SCOPE_DIR.publisher, label: '出版者', en: 'publisher' },
  classification: { dir: SCOPE_DIR.classification, label: '類別', en: 'category' },
  dataset: { dir: SCOPE_DIR.dataset, label: '資料集', en: 'dataset' },
  year: { dir: SCOPE_DIR.year, label: '出版年份', en: 'year' },
  language: { dir: SCOPE_DIR.language, label: '語言', en: 'language' },
};
for (const [facet, spec] of Object.entries(FACETS)) {
  // SCOPE_DIR is what the app builds its links from; if a directory name is
  // ever changed in one place only, every one of those links 404s silently.
  if (!spec.dir) throw new Error('site/scope-path.js has no directory for ' + facet);
}

/* A scope with four books in it is a page with nothing to say, and a few
 * hundred of those is how a site teaches a crawler that its pages are not
 * worth fetching. Datasets are exempt: each is a source worth describing
 * whatever its size. */
const MIN_BOOKS = 5;

/* Values that name the absence of a value. A page titled "[出版者不詳]"
 * describes nothing anyone searches for, and "未標示語言" groups books whose
 * only shared property is a gap in the record. They stay browsable in the
 * app; they do not get an address of their own. */
const PLACEHOLDERS = new Set(SCOPE_PLACEHOLDERS);

const LANGUAGES = {
  zh: '中文', en: '英文', ja: '日文', ko: '韓文', fr: '法文', de: '德文',
  es: '西班牙文', vi: '越南文', th: '泰文', id: '印尼文', und: '未標示語言',
};

/* ------------------------------------------------------------------ util */

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const href = (p) => '/' + p.split('/').map(encodeURIComponent).join('/') + '/';

function appLink(facet, value) {
  return '/#/?' + facet + '=' + encodeURIComponent(value);
}

/* ------------------------------------------------------------- scope set */

function scopeList(manifest) {
  const seen = new Map();   // slug path -> scope, to catch collisions
  const out = [];

  for (const [key, file] of Object.entries(manifest.pages.scopes)) {
    const facet = key.slice(0, key.indexOf(':'));
    const value = key.slice(key.indexOf(':') + 1);
    const spec = FACETS[facet];
    if (!spec) continue;

    if (PLACEHOLDERS.has(value.trim())) continue;

    const data = readPage(manifest, file);
    if (!data) continue;
    if (facet !== 'dataset' && data.total < MIN_BOOKS) continue;

    let dir = spec.dir + '/' + scopeSlug(value);
    if (seen.has(dir)) {
      // Two values that differ only in a character the slug drops — real in
      // this catalogue, where publishers appear with and without a colon.
      let n = 2;
      while (seen.has(dir + '-' + n)) n++;
      dir = dir + '-' + n;
    }
    seen.set(dir, key);

    out.push({ facet, value, spec, dir, total: data.total, rows: data.rows || [] });
  }
  return out;
}

function readPage(manifest, file) {
  const p = path.join(ROOT, 'site', 'data', manifest.pages.dir + file + '.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error('  ! unreadable: ' + p + ' — ' + err.message);
    return null;
  }
}

/* --------------------------------------------------------------- display */

function displayName(scope, datasets) {
  if (scope.facet === 'language') return LANGUAGES[scope.value] || scope.value;
  if (scope.facet === 'dataset') {
    const d = datasets.find((x) => x.id === scope.value);
    return d ? (d.shortTitle || d.title) : scope.value;
  }
  if (scope.facet === 'year') return scope.value + ' 年';
  return scope.value;
}

function authorsOf(row) {
  const a = row.authors;
  if (!a) return '';
  if (Array.isArray(a)) return a.map((x) => (x && x.name) || x).filter(Boolean).join('、');
  return String(a);
}

function describe(scope, name) {
  const years = scope.rows.map((r) => r.year).filter((y) => typeof y === 'number');
  const span = years.length
    ? Math.min(...years) + '–' + Math.max(...years)
    : '';
  const titles = [...new Set(scope.rows.map((r) => r.title).filter(Boolean))].slice(0, 3);
  return [
    name + '：神保町收錄 ' + scope.total.toLocaleString('en-US') + ' 種書刊',
    span ? '出版年份 ' + span : '',
    titles.length ? '包括《' + titles.join('》、《') + '》' : '',
  ].filter(Boolean).join('，') + '。';
}

/* ----------------------------------------------------------------- pages */

/* The app's generated cover, reproduced so a book without artwork reads as a
 * book rather than as a failed image. Same hash and the same two stops as
 * fallbackCover() in site/app.js — if that changes, this should follow. */
function hue(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 360;
}

function bookItem(row) {
  const title = row.title || '(無題)';
  /* The catalogue holds 8,190 books under more than one record, and three
   * records of 七星物語 in a row looks like a bug until you can see that
   * their ISBNs differ. They are separate editions and belong on the page;
   * what was missing was the thing that tells them apart. */
  const meta = [authorsOf(row), row.publisher, row.year, row.isbn]
    .filter(Boolean).join(' · ');
  const h = hue(row.id || title);
  const cover = row.cover
    ? '<img src="' + esc(row.cover) + '" alt="" loading="lazy" decoding="async" width="120" height="170">'
    : '<span class="noc" aria-hidden="true" style="background:linear-gradient(150deg,hsl(' +
      h + ' 42% 42%),hsl(' + ((h + 38) % 360) + ' 38% 28%))"></span>';
  return '<li class="b">' +
    '<a href="/#/book/' + encodeURIComponent(row.id) + '">' + cover +
    '<span class="t">' + esc(title) + '</span>' +
    (row.subtitle ? '<span class="s">' + esc(row.subtitle) + '</span>' : '') +
    '</a>' +
    (meta ? '<span class="m">' + esc(meta) + '</span>' : '') +
    '</li>';
}

/* schema.org, so a result can carry the count and the publisher rather than
   a bare title. ItemList is the honest type: this is a listing page, not one
   book's page. */
function jsonLd(scope, name, url) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '神保町', item: ORIGIN + '/' },
          { '@type': 'ListItem', position: 2, name: scope.spec.label, item: ORIGIN + '/browse/' },
          { '@type': 'ListItem', position: 3, name: name, item: url },
        ],
      },
      {
        '@type': 'ItemList',
        name: name,
        numberOfItems: scope.total,
        itemListElement: scope.rows.slice(0, 60).map((r, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'Book',
            name: r.title || '',
            ...(authorsOf(r) ? { author: { '@type': 'Person', name: authorsOf(r) } } : {}),
            ...(r.publisher ? { publisher: { '@type': 'Organization', name: r.publisher } } : {}),
            ...(r.isbn ? { isbn: r.isbn } : {}),
            ...(r.year ? { datePublished: String(r.year) } : {}),
          },
        })),
      },
    ],
  });
}

function page(scope, name, siblings) {
  const url = ORIGIN + href(scope.dir);
  const desc = describe(scope, name);
  const title = name + ' — 神保町 jimbocho.app';
  const shown = Math.min(scope.rows.length, scope.total);

  return '<!doctype html>\n<html lang="zh-Hant-HK">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + esc(title) + '</title>\n' +
    '<meta name="description" content="' + esc(desc) + '">\n' +
    '<link rel="canonical" href="' + esc(url) + '">\n' +
    '<link rel="stylesheet" href="/browse/scope.css">\n' +
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon.png">\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta property="og:site_name" content="神保町">\n' +
    '<meta property="og:title" content="' + esc(name) + '">\n' +
    '<meta property="og:description" content="' + esc(desc) + '">\n' +
    '<meta property="og:url" content="' + esc(url) + '">\n' +
    '<script type="application/ld+json">' + jsonLd(scope, name, url) + '</script>\n' +
    '</head>\n<body>\n' +
    '<header><a class="home" href="/">神保町 <small>jimbocho.app</small></a>' +
    '<a class="app" href="' + esc(appLink(scope.facet, scope.value)) + '">在目錄中開啟 →</a></header>\n' +
    '<main>\n' +
    '<nav class="crumbs"><a href="/">首頁</a> › <a href="/browse/">' + esc(scope.spec.label) + '</a> › ' + esc(name) + '</nav>\n' +
    '<h1>' + esc(name) + '</h1>\n' +
    '<p class="count">' + scope.total.toLocaleString('en-US') + ' 種書刊' +
      (shown < scope.total ? '，以下為首 ' + shown + ' 種' : '') + '。 ' +
      '<a href="' + esc(appLink(scope.facet, scope.value)) + '">瀏覽、搜尋及篩選全部 →</a></p>\n' +
    '<ol class="books">\n' + scope.rows.map(bookItem).join('\n') + '\n</ol>\n' +
    (shown < scope.total
      ? '<p class="more"><a href="' + esc(appLink(scope.facet, scope.value)) + '">在目錄中查看其餘 ' +
        (scope.total - shown).toLocaleString('en-US') + ' 種 →</a></p>\n'
      : '') +
    (siblings.length
      ? '<nav class="sib"><h2>其他' + esc(scope.spec.label) + '</h2>\n' +
        siblings.map((s) => '<a href="' + esc(href(s.dir)) + '">' + esc(s.name) + '</a>').join('\n') +
        '\n<a class="all" href="/browse/">全部 ' + esc(scope.spec.label) + ' →</a></nav>\n'
      : '') +
    '</main>\n' +
    '<footer><a href="/">神保町</a> · <a href="/browse/">瀏覽全部分類</a> · ' +
    '香港及臺灣書刊目錄</footer>\n</body>\n</html>\n';
}

function indexPage(groups) {
  const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
  const body = Object.entries(groups).map(([facet, list]) => {
    const spec = FACETS[facet];
    return '<section><h2 id="' + spec.en + '">' + esc(spec.label) +
      ' <small>' + list.length + '</small></h2>\n<ul class="links">\n' +
      list.map((s) => '<li><a href="' + esc(href(s.dir)) + '">' + esc(s.name) +
        '</a> <span class="n">' + s.total.toLocaleString('en-US') + '</span></li>').join('\n') +
      '\n</ul></section>';
  }).join('\n');

  const desc = '神保町的 ' + total + ' 個書刊分類：按出版者、類別、資料集、出版年份及語言瀏覽香港及臺灣書目。';
  return '<!doctype html>\n<html lang="zh-Hant-HK">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>瀏覽全部分類 — 神保町 jimbocho.app</title>\n' +
    '<meta name="description" content="' + esc(desc) + '">\n' +
    '<link rel="canonical" href="' + ORIGIN + '/browse/">\n' +
    '<link rel="stylesheet" href="/browse/scope.css">\n' +
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon.png">\n' +
    '</head>\n<body>\n' +
    '<header><a class="home" href="/">神保町 <small>jimbocho.app</small></a>' +
    '<a class="app" href="/">在目錄中開啟 →</a></header>\n' +
    '<main class="browse">\n<nav class="crumbs"><a href="/">首頁</a> › 瀏覽</nav>\n' +
    '<h1>瀏覽全部分類</h1>\n<p class="count">' + total + ' 個分類頁。</p>\n' +
    body + '\n</main>\n' +
    '<footer><a href="/">神保町</a> · 香港及臺灣書刊目錄</footer>\n</body>\n</html>\n';
}

const CSS = `/* Generated by tools/build-pages.js — edit there, not here. */
:root{--bg:#fbfaf7;--fg:#1e1e18;--dim:#6b6b60;--line:#e2e0d8;--accent:#a8432a;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1e1e18;--fg:#eceade;--dim:#9b998c;--line:#34342c;--accent:#e08a6b;--card:#26261f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif}
header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.home{font-weight:700;font-size:18px;color:var(--fg);text-decoration:none}
.home small{font-weight:400;color:var(--dim);font-size:13px}
.app{color:var(--accent);text-decoration:none;font-size:14px;white-space:nowrap}
main{max-width:1100px;margin:0 auto;padding:16px}
.crumbs{font-size:13px;color:var(--dim);margin:8px 0 4px}
.crumbs a{color:var(--dim)}
h1{font-size:28px;margin:8px 0 4px;line-height:1.25}
h2{font-size:17px;margin:28px 0 8px}
h2 small{color:var(--dim);font-weight:400;font-size:13px}
.count{color:var(--dim);font-size:14px;margin:0 0 20px}
a{color:var(--accent)}
.books{list-style:none;margin:0;padding:0;display:grid;gap:18px 14px;grid-template-columns:repeat(auto-fill,minmax(132px,1fr))}
.b a{display:block;text-decoration:none;color:var(--fg)}
.b img,.b .noc{display:block;width:100%;aspect-ratio:120/170;object-fit:cover;background:var(--card);border:1px solid var(--line);border-radius:3px}
.b .t{display:block;margin-top:6px;font-size:14px;line-height:1.35}
.b .s{display:block;color:var(--dim);font-size:12px;line-height:1.3;margin-top:1px}
.b .m{display:block;color:var(--dim);font-size:12px;margin-top:2px}
.more{margin:24px 0}
.sib{margin:36px 0 0;padding-top:16px;border-top:1px solid var(--line)}
.sib a{display:inline-block;margin:0 12px 8px 0;font-size:14px}
.sib .all{font-weight:600}
.links{list-style:none;margin:0;padding:0;columns:260px;column-gap:28px}
.links li{break-inside:avoid;margin-bottom:4px;font-size:14px}
.links .n{color:var(--dim);font-size:12px}
footer{max-width:1100px;margin:40px auto 0;padding:16px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
@media (max-width:420px){h1{font-size:22px}.books{grid-template-columns:repeat(auto-fill,minmax(104px,1fr))}}
`;

/* ------------------------------------------------------------------ main */

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'data', 'manifest.json'), 'utf8'));
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'datasets.json'), 'utf8'));
  const datasets = registry.datasets || registry;

  if (!manifest.pages || !manifest.pages.scopes) {
    throw new Error('manifest has no pages.scopes — run npm run build:db first');
  }

  const scopes = scopeList(manifest);
  for (const s of scopes) s.name = displayName(s, datasets);

  const groups = {};
  for (const s of scopes) (groups[s.facet] = groups[s.facet] || []).push(s);
  for (const list of Object.values(groups)) {
    list.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-Hant'));
  }

  fs.mkdirSync(path.join(DEST, 'browse'), { recursive: true });
  fs.writeFileSync(path.join(DEST, 'browse', 'scope.css'), CSS);

  let written = 0;
  for (const s of scopes) {
    // Crawl paths between siblings, so no page is reachable only from the
    // index: the six nearest by size, which keeps a small publisher next to
    // other small publishers rather than orphaned under the giants.
    const peers = groups[s.facet];
    const at = peers.indexOf(s);
    const siblings = peers.slice(Math.max(0, at - 3), at)
      .concat(peers.slice(at + 1, at + 4));

    const dir = path.join(DEST, s.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), page(s, s.name, siblings));
    written++;
  }

  fs.writeFileSync(path.join(DEST, 'browse', 'index.html'), indexPage(groups));
  written++;

  const urls = [ORIGIN + '/', ORIGIN + '/browse/']
    .concat(scopes.map((s) => ORIGIN + href(s.dir)));
  fs.writeFileSync(path.join(DEST, 'sitemap.xml'), sitemap(urls));

  console.log('  ' + written.toLocaleString('en-US') + ' pages → ' + DEST);
  for (const [facet, list] of Object.entries(groups)) {
    console.log('    ' + FACETS[facet].label.padEnd(6) + String(list.length).padStart(5));
  }
  console.log('  sitemap.xml: ' + urls.length.toLocaleString('en-US') + ' URLs');
}

function sitemap(urls) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!-- Generated by tools/build-pages.js. Do not edit. -->\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => '  <url><loc>' + esc(u) + '</loc></url>').join('\n') +
    '\n</urlset>\n';
}

main();
