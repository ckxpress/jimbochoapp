/* 神保町 (jimbocho.app) — browse & search UI.
   No build step, no dependencies: reads site/data/manifest.json, loads the
   slim index shards for browsing, and pulls a full shard only when a book is
   opened. */
(function () {
  'use strict';

  var PAGE_SIZE = 60;

  /**
   * How many rows the *first* page off the database asks for, as against the
   * 60 a precomputed scope file carries.
   *
   * Measured on the live site, the search 香港文學 costs about 95 serial range
   * requests: ~35 into the FTS index at 410–465 MB, which ramp up to 256 KiB
   * as sql.js-httpvfs notices it is reading sequentially, and then **one 32 KiB
   * read per result row** scattered across the `books` table at 0–100 MB. Sixty
   * rows ordered by relevance land on sixty different pages, and nothing about
   * a bigger chunk or a denser table changes that: it is sixty random reads,
   * and SQLite cannot ask for the next one until the last has arrived.
   *
   * So the row count *is* the latency. Eighteen fills the grid above the fold
   * at desktop width and more than fills it on a phone; the rest arrives by
   * the usual infinite scroll while the reader is already reading. Browsing is
   * untouched — a scope page is one static file and costs one request whether
   * it holds 18 rows or 60.
   */
  var FIRST_DB_ROWS = 18;
  var DATA = 'data/';

  var state = {
    q: '',
    filters: {},
    sort: 'relevance',
    view: localStorage.getItem('view') || 'grid',
    page: 1,
  };

  var manifest = null;
  var rows = [];
  var byId = new Map();
  var fullShards = new Map();
  var results = [];
  /* Cards on screen that a later page's duplicate can be folded into, keyed by
     dedupeKey(). Cleared whenever the grid is, and carried across appends:
     infinite scroll means the second copy of a book can arrive sixty results
     after the first, and a fold that only looked within one page would miss
     most of them. */
  var shown = new Map();
  var totalBooks = 0;
  var firstPage = null;      // precomputed landing views, keyed by language scope
  var sourcePrepared = null; // the open-the-backend promise, created once
  var searchingTimer = null; // delays the skeleton so a fast query cannot flash it
  var totalResults = 0;
  /* False when the API capped the count rather than paying for an exact
     one. Only the search API sets it; the file backend always counts. */
  var totalExact = true;
  var source = null; // JsonSource or SqliteSource, chosen by the manifest
  var renderToken = 0; // guards against out-of-order async renders

  /* Whether records that are indistinguishable on screen share a card — see
     site/dedupe.js for what counts as indistinguishable. On by default,
     because the duplication is an artefact of holding the datasets apart and
     not something a reader asked to see. Off is a real answer, so it is a
     setting on 資料說明 rather than a constant: a reader checking what the
     catalogue actually holds wants every record, one card each. */
  var grouping = localStorage.getItem('grouping') !== 'off';
  var lastWritten = null; // the hash this app wrote, to skip echoing it back
  var dbFallbackReason = ''; // set when the database was rejected and JSON took over

  var el = {
    q: document.getElementById('q'),
    grid: document.getElementById('grid'),
    count: document.getElementById('count'),
    chips: document.getElementById('chips'),
    facets: document.getElementById('facets'),
    sort: document.getElementById('sort'),
    more: document.getElementById('more'),
    empty: document.getElementById('empty'),
    sidebar: document.getElementById('sidebar'),
    browse: document.getElementById('browse-view'),
    detail: document.getElementById('detail-view'),
    about: document.getElementById('about-view'),
    brandSub: document.getElementById('brand-sub'),
    footer: document.getElementById('footer-text'),
    filtersCount: document.getElementById('filters-count'),
    sentinel: document.getElementById('sentinel'),
    search: document.getElementById('search-form'),
    results: document.getElementById('results'),
    shelf: document.getElementById('shelf-view'),
    shelfCount: document.getElementById('shelf-count'),
  };

  /* ---------------- facet definitions ---------------- */

  // Sidebar order: who published it, when, from which release, what kind of
  // book — then 語言.
  //
  // 語言 sits fifth and starts collapsed although 中文 is ticked by default,
  // which is unusual: a facet with a selection normally opens so the reader
  // can see what is narrowing their results. Here that selection is the
  // catalogue's resting state rather than a choice anyone made, and putting
  // it first with a tick in it made the sidebar open on a question nobody
  // asked. The chip above the results still says it is on.
  var FACETS = [
    { key: 'publisher', label: '出版者', get: function (r) { return r.publisher; }, search: true, limit: 8, open: true, sort: 'stroke' },
    { key: 'year', label: '出版年份', get: function (r) { return r.year ? String(r.year) : ''; }, limit: 10, sort: 'key-desc', open: true },
    { key: 'source', label: '發佈期間', get: function (r) { return r._ds + '#' + (r.src || 0); }, name: sourceName, limit: 10 },
    { key: 'classification', label: '類別', get: function (r) { return r.classification; }, search: true, limit: 10 },
    { key: 'language', label: '語言', get: function (r) { return r.language; }, name: languageName, collapsed: true },
    { key: 'dataset', label: '資料集', get: function (r) { return r._ds; }, name: datasetName, hideIfSingle: true },
    {
      key: 'availability',
      label: '發售狀況',
      get: function (r) { return r.forSale === true ? 'sale' : r.forSale === false ? 'nosale' : ''; },
      name: function (v) { return v === 'sale' ? '售賣品' : '非賣品'; },
    },
    {
      key: 'identifier',
      label: '識別號',
      get: function (r) { return r.isbn ? 'isbn' : ''; },
      name: function () { return '設有 ISBN'; },
    },
  ];

  /* ---------------- boot ---------------- */

  function init() {
    applyTheme(localStorage.getItem('theme'));
    el.sort.value = state.sort;
    setViewButtons();
    wireEvents();
    updateShelfCount();
    readRoute();
    load();
  }

  /**
   * Opens the backend, once. The landing view is answered from a precomputed
   * file, so this is deliberately not awaited before first paint — it runs
   * while the reader is already reading, and the first search waits on it.
   */
  function ensureSource() {
    if (sourcePrepared) return sourcePrepared;
    // No backend chosen yet: load() picks one once the manifest is in, and
    // until then there is nothing to prepare. Reachable because the sidebar's
    // media-query listener calls ensureFacets() on any width change, which a
    // reader can cause — or a rotation can — before the manifest has landed.
    if (!source) return Promise.resolve();
    sourcePrepared = source.prepare().catch(function (err) {
      if (source === JsonSource) throw err;
      // Serving stale-but-correct data beats serving wrong data.
      console.warn('SQLite backend unavailable: ' + err.message + '. Falling back to JSON shards.');
      dbFallbackReason = err.message;
      source = JsonSource;
      rows = [];
      byId = new Map();
      return JsonSource.prepare();
    });
    // The footer states which backend is answering; it is only knowable now.
    sourcePrepared.then(function () { renderBuildId(); }, function () {});
    return sourcePrepared;
  }

  function load() {
    fetch(DATA + 'manifest.json', { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('manifest.json not found');
        return res.json();
      })
      .then(function (data) {
        manifest = data;
        if (!manifest.datasets || !manifest.datasets.length) throw new Error('no datasets imported yet');
        // The total is in the manifest, so the chrome does not wait for a
        // backend to open.
        totalBooks = manifest.totalBooks || 0;
        updateChrome();
        // An API in the manifest means search and filtered browse are
        // answered server-side; the file backend stays for the book page and
        // as the fallback if the API cannot be reached. Without either, the
        // JSON shards are loaded up front. Same UI in all three cases.
        source = manifest.api && manifest.db ? ApiSource : manifest.db ? SqliteSource : JsonSource;

        // Fetch the precomputed landing view before anything else. It is one
        // small asset and it decides whether first paint needs the backend at
        // all; if it is missing or stale, the backend answers as it always did.
        if (!manifest.firstPage || source === JsonSource) return ensureSource();
        return fetch(DATA + manifest.firstPage.file)
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) { firstPage = data; })
          .catch(function () { firstPage = null; })
          .then(function () {
            // Nothing to paint without the backend, so wait for it.
            if (!prerendered()) return ensureSource();
            ensureSource(); // opens in the background, for the first interaction
          });
      })
      .then(function () {
        el.brandSub.textContent =
          fmt(totalBooks) + ' 筆書目 · ' + manifest.datasets.length + ' 個資料集';
        route();
      })
      .catch(function (err) {
        el.count.textContent = '';
        el.grid.innerHTML = '';
        el.empty.hidden = false;
        el.empty.innerHTML =
          '<h3>未能載入資料</h3><p>' +
          escapeHtml(err.message) +
          '</p><p>請在專案資料夾執行 <code>npm run import</code>，然後重新載入。</p>';
        el.brandSub.textContent = '沒有資料';
      });
  }

  function loadShards() {
    var jobs = [];
    manifest.datasets.forEach(function (ds) {
      var files = (ds.files && ds.files.index) || [];
      files.forEach(function (file, shard) {
        jobs.push(
          fetch(DATA + file)
            .then(function (res) { return res.json(); })
            .then(function (list) { return { ds: ds, shard: shard, list: list }; })
        );
      });
    });

    showSkeleton();

    return Promise.all(jobs).then(function (chunks) {
      chunks.sort(function (a, b) {
        return a.ds.id === b.ds.id ? a.shard - b.shard : a.ds.id.localeCompare(b.ds.id);
      });
      chunks.forEach(function (chunk) {
        chunk.list.forEach(function (row, offset) {
          row._ds = chunk.ds.id;
          row._shard = chunk.shard;
          row._off = offset;
          row._hay = haystack(row);
          rows.push(row);
          byId.set(row.id, row);
        });
      });
    });
  }

  /* The catalogue registers Chinese and English books separately, and an
     English record often carries the Chinese form of its title as the
     parallel title ("... = 葉智榮"). This is a Traditional Chinese site, so
     the Chinese form leads wherever a record has one; the other title is kept
     and shown underneath rather than dropped. */
  var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

  function hasCjk(text) {
    return CJK.test(text || '');
  }

  function displayTitle(row) {
    if (!hasCjk(row.title) && hasCjk(row.parallelTitle)) return row.parallelTitle;
    return row.title || '';
  }

  function altTitle(row) {
    var shown = displayTitle(row);
    if (row.title && row.title !== shown) return row.title;
    if (row.parallelTitle && row.parallelTitle !== shown) return row.parallelTitle;
    return '';
  }

  function haystack(row) {
    return [
      row.title,
      row.parallelTitle,
      row.subtitle,
      (row.authors || []).join(' '),
      row.publisher,
      row.series,
      row.classification,
      row.isbn,
      row.ref,
      row.year,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  /* ---------------- events ---------------- */

  function wireEvents() {
    var timer = null;
    function scheduleSearch() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        state.q = el.q.value.trim();
        state.page = 1;
        pushRoute();
        render();
      }, 120);
    }
    el.q.addEventListener('input', function (e) {
      // Skip the keystrokes an IME is still turning into a character —
      // searching for the raw 倉頡 or pinyin letters finds nothing.
      if (e.isComposing) return;
      scheduleSearch();
    });
    el.q.addEventListener('compositionend', scheduleSearch);

    document.getElementById('search-form').addEventListener('submit', function (e) {
      e.preventDefault();
      el.q.blur();
    });

    el.sort.addEventListener('change', function () {
      state.sort = el.sort.value;
      state.page = 1;
      pushRoute();
      render();
    });

    document.querySelectorAll('.viewtoggle button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.view = btn.dataset.view;
        localStorage.setItem('view', state.view);
        setViewButtons();
        render();
      });
    });

    el.more.addEventListener('click', loadMore);

    window.addEventListener('resize', maybeLoadMore);

    document.getElementById('clear-filters').addEventListener('click', function () {
      state.filters = {};
      state.q = '';
      el.q.value = '';
      state.page = 1;
      pushRoute();
      render();
    });

    document.getElementById('filters-toggle').addEventListener('click', function (e) {
      var open = el.sidebar.classList.toggle('open');
      e.currentTarget.setAttribute('aria-expanded', String(open));
      // Opening the panel is the request for its counts.
      if (open) ensureFacets();
    });

    // Widening past 900px puts the sidebar back on screen without anyone
    // touching the toggle, so the counts have to be fetched then too.
    if (window.matchMedia) {
      var wide = window.matchMedia('(max-width: 900px)');
      var onWidth = function () { if (!wide.matches) ensureFacets(); };
      if (wide.addEventListener) wide.addEventListener('change', onWidth);
      else if (wide.addListener) wide.addListener(onWidth);
    }

    initMenu();
    initSearchPlaceholder();
    initCountPlacement();

    document.getElementById('theme-toggle').addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme');
      var next = current === 'dark' ? 'light' : current === 'light' ? '' : prefersDark() ? 'light' : 'dark';
      localStorage.setItem('theme', next);
      applyTheme(next);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement !== el.q && !/input|textarea|select/i.test(document.activeElement.tagName)) {
        e.preventDefault();
        el.q.focus();
        el.q.select();
      } else if (e.key === 'Escape' && document.activeElement === el.q) {
        el.q.blur();
      }
    });

    window.addEventListener('hashchange', function () {
      if (location.hash === lastWritten) {
        lastWritten = null;
        return;
      }
      readRoute();
      route();
    });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(
        function (entries) {
          if (entries[0].isIntersecting) maybeLoadMore();
        },
        { rootMargin: '600px' }
      ).observe(el.sentinel);
    }
  }

  /* ---------------- routing ---------------- */

  function readRoute() {
    var hash = location.hash.replace(/^#/, '');
    var qs = hash.indexOf('?') === -1 ? '' : hash.slice(hash.indexOf('?') + 1);
    var params = new URLSearchParams(qs);

    state.q = params.get('q') || '';
    state.sort = params.get('sort') || 'relevance';
    state.page = Math.max(1, Number(params.get('page') || 1));
    state.filters = {};

    FACETS.forEach(function (facet) {
      var raw = params.get(facet.key);
      if (raw) state.filters[facet.key] = new Set(raw.split('|'));
    });

    // A reader arriving with no address of their own gets the Chinese
    // catalogue. Once they touch anything the hash is written, so unticking
    // Chinese sticks rather than being reapplied on the next load.
    if (!hash) state.filters.language = new Set(['zh']);

    el.q.value = state.q;
    el.sort.value = state.sort;
  }

  function pushRoute() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.sort !== 'relevance') params.set('sort', state.sort);
    Object.keys(state.filters).forEach(function (key) {
      var set = state.filters[key];
      if (set && set.size) params.set(key, [...set].join('|'));
    });
    var qs = params.toString();
    var next = '#/' + (qs ? '?' + qs : '');
    lastWritten = next;
    if (location.hash !== next) location.hash = next;
  }

  function route() {
    if (!manifest) return;
    var hash = location.hash.replace(/^#/, '');
    var path = hash.split('?')[0];

    if (path.indexOf('/book/') === 0) {
      showView('detail');
      renderDetail(decodeURIComponent(path.slice(6)));
    } else if (path === '/about') {
      showView('about');
      renderAbout();
    } else if (path === '/shelf') {
      showView('shelf');
      renderShelf();
    } else {
      showView('browse');
      render();
    }
  }

  function showView(name) {
    el.browse.hidden = name !== 'browse';
    el.detail.hidden = name !== 'detail';
    el.about.hidden = name !== 'about';
    el.shelf.hidden = name !== 'shelf';
    if (name !== 'browse') window.scrollTo(0, 0);
  }

  /* ---------------- filtering & search ---------------- */

  function matches(row, filters) {
    for (var i = 0; i < FACETS.length; i++) {
      var facet = FACETS[i];
      var set = filters[facet.key];
      if (!set || !set.size) continue;
      if (!set.has(facet.get(row) || '')) return false;
    }
    return true;
  }

  function searchTerms(q) {
    if (!q) return [];
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  function compute() {
    var terms = searchTerms(state.q);
    var digits = state.q.replace(/[^0-9Xx]/g, '');
    var isbnQuery = digits.length >= 10 ? digits.toUpperCase() : '';
    var out = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!matches(row, state.filters)) continue;

      if (terms.length) {
        var hay = row._hay;
        var ok = true;
        for (var t = 0; t < terms.length; t++) {
          if (hay.indexOf(terms[t]) === -1) {
            ok = false;
            break;
          }
        }
        if (!ok) {
          if (!isbnQuery || row.isbn !== isbnQuery) continue;
        }
        row._score = score(row, terms, isbnQuery);
      } else {
        row._score = 0;
      }
      out.push(row);
    }

    sortRows(out);
    return out;
  }

  function score(row, terms, isbnQuery) {
    var value = 0;
    if (isbnQuery && row.isbn === isbnQuery) value += 500;
    var title = ((row.title || '') + ' ' + (row.parallelTitle || '')).toLowerCase();
    var authors = (row.authors || []).join(' ').toLowerCase();
    var publisher = (row.publisher || '').toLowerCase();

    terms.forEach(function (term) {
      if (title === term) value += 120;
      else if (title.indexOf(term) === 0) value += 60;
      else if (title.indexOf(term) !== -1) value += 34;
      if (authors.indexOf(term) !== -1) value += 20;
      if (publisher.indexOf(term) !== -1) value += 8;
    });
    if (row.year) value += Math.min(6, Math.max(0, row.year - 2015) * 0.4);
    return value;
  }

  function sortRows(list) {
    var collator = new Intl.Collator(['zh-Hant', 'en'], { numeric: true, sensitivity: 'base' });
    var mode = state.sort;

    // Latin sorts before CJK in every standard collation, which would bury
    // ~4,300 English titles ahead of the first Chinese one. Group by script
    // first so a Traditional Chinese catalogue reads as one.
    function script(row) {
      return hasCjk(displayTitle(row)) ? 0 : 1;
    }
    function byTitle(a, b) {
      return script(a) - script(b) || collator.compare(displayTitle(a), displayTitle(b));
    }

    // Only about one book in nine has a real cover, so a page of generated
    // ones reads as empty. Browsing leads with the books that have a picture;
    // a search does not, because relevance has to outrank decoration.
    function byCover(a, b) {
      return (a.cover ? 0 : 1) - (b.cover ? 0 : 1);
    }

    list.sort(function (a, b) {
      switch (mode) {
        case 'title':
          return byTitle(a, b);
        case 'title-desc':
          return script(a) - script(b) || collator.compare(displayTitle(b), displayTitle(a));
        case 'year':
          return (a.year || 9999) - (b.year || 9999) || byTitle(a, b);
        case 'year-desc':
          return (b.year || 0) - (a.year || 0) || byTitle(a, b);
        case 'publisher':
          return collator.compare(a.publisher || 'zzz', b.publisher || 'zzz') || byTitle(a, b);
        default:
          return (b._score || 0) - (a._score || 0) || byCover(a, b) || byTitle(a, b);
      }
    });
  }

  /* ---------------- the reader's shelf ---------------- */

  /**
   * Which books the reader owns.
   *
   * This lives in the browser, because the site is static files with no
   * server: there is nothing to authenticate against and nowhere to keep a
   * profile. That has real consequences the UI is honest about — the shelf is
   * per-device, and clearing site data loses it, so it can be exported and a
   * share link carries it to someone else.
   *
   * Everything above this object goes through its methods, so swapping in a
   * backed store (accounts, cross-device sync, live public profiles) means
   * replacing these four functions, not the interface.
   */
  var Shelf = {
    key: 'shelf.owned',
    _items: null, // id -> { p: asking price or null, at: when added }

    all: function () {
      if (Shelf._items) return Shelf._items;
      var items = {};
      try {
        var raw = JSON.parse(localStorage.getItem(Shelf.key) || 'null');
        if (Array.isArray(raw)) {
          // v1 kept a plain list of ids, before shelves carried a price.
          raw.forEach(function (id) { if (typeof id === 'string') items[id] = { p: null, at: null }; });
        } else if (raw && raw.items) {
          items = raw.items;
        }
      } catch (err) {
        items = {};
      }
      Shelf._items = items;
      return items;
    },

    has: function (id) {
      return Object.prototype.hasOwnProperty.call(Shelf.all(), id);
    },

    get: function (id) {
      return Shelf.all()[id] || null;
    },

    price: function (id) {
      var entry = Shelf.get(id);
      return entry && typeof entry.p === 'number' ? entry.p : null;
    },

    add: function (id, price) {
      Shelf.all()[id] = { p: typeof price === 'number' ? price : null, at: new Date().toISOString() };
      Shelf.save();
    },

    setPrice: function (id, price) {
      var entry = Shelf.get(id);
      if (!entry) return;
      entry.p = typeof price === 'number' ? price : null;
      Shelf.save();
    },

    remove: function (id) {
      delete Shelf.all()[id];
      Shelf.save();
    },

    ids: function () {
      return Object.keys(Shelf.all());
    },

    total: function () {
      return Shelf.ids().reduce(function (sum, id) {
        var p = Shelf.price(id);
        return sum + (p || 0);
      }, 0);
    },

    save: function () {
      try {
        localStorage.setItem(Shelf.key, JSON.stringify({ v: 2, items: Shelf.all() }));
      } catch (err) {
        // Private browsing, or storage full. Say so rather than pretending.
        alert('無法儲存書架：瀏覽器拒絕寫入本機儲存空間。');
      }
      updateShelfCount();
    },

    size: function () {
      return Shelf.ids().length;
    },
  };

  /**
   * Asks what the book should sell for, pre-filled with its catalogue price.
   * Returns the price, or undefined if the reader backed out — null means
   * they deliberately left it blank.
   */
  function askPrice(opts) {
    return new Promise(function (resolve) {
      var dlg = document.getElementById('price-dialog');
      if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.id = 'price-dialog';
        dlg.className = 'price-dialog';
        document.body.appendChild(dlg);
      }

      var original = typeof opts.original === 'number' ? opts.original : null;
      var current = typeof opts.current === 'number' ? opts.current : null;
      var value = current !== null ? current : original;

      dlg.innerHTML =
        '<form method="dialog">' +
        '<h3>' + (opts.editing ? '修改售價' : '加入我的書架') + '</h3>' +
        '<p class="pd-book">' + escapeHtml(opts.title || '') + '</p>' +
        '<label class="pd-field"><span>售價</span>' +
        '<span class="pd-input"><i>HK$</i>' +
        '<input type="number" id="pd-price" min="0" step="1" inputmode="decimal" ' +
        'value="' + (value === null ? '' : value) + '" placeholder="未定價"></span></label>' +
        '<p class="pd-hint">' +
        (original !== null ? '原價 ' + money(original, opts.currency || 'HKD') + '，可自行調整。' : '目錄沒有記錄原價。') +
        '留空表示暫不標價。</p>' +
        '<menu>' +
        '<button value="cancel" class="btn">取消</button>' +
        '<button value="ok" class="btn primary">' + (opts.editing ? '儲存' : '加入書架') + '</button>' +
        '</menu></form>';

      var input = dlg.querySelector('#pd-price');
      var settled = false;

      function finish(ok) {
        if (settled) return;
        settled = true;
        dlg.removeEventListener('close', onClose);
        if (!ok) return resolve(undefined);
        var raw = input.value.trim();
        if (raw === '') return resolve(null);
        var n = Number(raw);
        resolve(isNaN(n) || n < 0 ? null : n);
      }

      function onClose() {
        // Esc, or the backdrop — treated as backing out.
        finish(dlg.returnValue === 'ok');
      }

      dlg.addEventListener('close', onClose);
      dlg.showModal();
      input.focus();
      input.select();
    });
  }

  function updateShelfCount() {
    var n = Shelf.size();
    el.shelfCount.hidden = n === 0;
    el.shelfCount.textContent = String(n);
    // On a narrow screen the count is shut inside the menu, so carry the
    // signal out to the ☰ as a dot.
    var dot = document.getElementById('menu-dot');
    if (dot) dot.hidden = n === 0;
  }

  /**
   * A shelf packed into a URL, since there is no server to host a profile.
   * Ids repeat their dataset, so that is written once and the registration
   * numbers follow.
   */
  function encodeShelf(ids) {
    if (!ids.length) return '';
    var byDataset = {};
    ids.forEach(function (id) {
      var at = id.indexOf(':');
      var ds = at === -1 ? '' : id.slice(0, at);
      var ref = at === -1 ? id : id.slice(at + 1);
      var price = Shelf.price(id);
      // "ref" on its own, or "ref:price" — a shared shelf is a sale list.
      (byDataset[ds] = byDataset[ds] || []).push(price === null ? ref : ref + ':' + price);
    });
    var parts = Object.keys(byDataset).map(function (ds) {
      return ds + '=' + byDataset[ds].join(',');
    });
    return base64url(unescape(encodeURIComponent('2|' + parts.join(';'))));
  }

  function decodeShelf(code) {
    var out = { ids: [], prices: {} };
    try {
      var text = decodeURIComponent(escape(unbase64url(code)));
      var version = text.slice(0, 2);
      if (version !== '1|' && version !== '2|') return out;
      text.slice(2).split(';').forEach(function (chunk) {
        var at = chunk.indexOf('=');
        if (at === -1) return;
        var ds = chunk.slice(0, at);
        chunk.slice(at + 1).split(',').forEach(function (part) {
          if (!part) return;
          // v2 appends ":price"; v1 links carry the reference alone.
          var bits = part.split(':');
          var ref = bits[0];
          var id = ds ? ds + ':' + ref : ref;
          out.ids.push(id);
          if (bits.length > 1 && bits[1] !== '') {
            var n = Number(bits[1]);
            if (!isNaN(n)) out.prices[id] = n;
          }
        });
      });
      return out;
    } catch (err) {
      return out;
    }
  }

  function base64url(raw) {
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function unbase64url(code) {
    var b = code.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return atob(b);
  }

  /* ---------------- data sources ---------------- */

  /**
   * Everything below the render layer goes through one of these. The JSON
   * source holds every record in memory, which is fast up to ~50k books; the
   * SQLite source queries a database file over HTTP range requests and does
   * not care how large the catalogue is.
   */
  var JsonSource = {
    id: 'json',
    prepare: function () {
      return loadShards().then(function () {
        totalBooks = rows.length;
      });
    },
    page: function (offset, limit) {
      var sig = querySignature();
      if (sig !== JsonSource._sig) {
        JsonSource._sig = sig;
        JsonSource._all = compute();
      }
      var all = JsonSource._all;
      return Promise.resolve({ rows: all.slice(offset, offset + limit), total: all.length });
    },
    facets: function () {
      var out = {};
      FACETS.forEach(function (facet) {
        out[facet.key] = countFacet(facet);
      });
      return Promise.resolve(out);
    },
    record: function (id) {
      var row = byId.get(id);
      if (!row) return Promise.resolve(null);
      return fetchFull(row);
    },
    byIds: function (ids) {
      return Promise.resolve(ids.map(function (id) { return byId.get(id); }).filter(Boolean));
    },
    siblings: function (isbn, exclude) {
      return Promise.resolve(
        rows.filter(function (r) {
          return r.isbn === isbn && r.id !== exclude;
        })
      );
    },
  };

  /**
   * Search and filtered browse, answered by the Worker over D1.
   *
   * The file-over-HTTP backend below is still here and still correct; it is
   * simply the wrong shape for anything the build did not precompute. Its
   * cost is serial round trips, and measured on Hutchison 4G in Hong Kong —
   * the reader this is for — that is 130 ms each, ~49 for a cold search, and
   * **over 45 seconds** for a publisher outside the 312 the build precomputes.
   * Counting facets there means fetching every matching row one trip at a
   * time, and 37,741 publishers covering 52.9% of the catalogue are outside
   * that set. Precomputing them all would need 1,163 MB against the 1 GB
   * GitHub Pages allows.
   *
   * The same filter through this source returns in about a second.
   *
   * What does *not* move: the landing view and the precomputed scope pages,
   * which are already one static request, and the book page, which needs the
   * `docs` blob that stays in R2. So record/byIds/siblings below hand back to
   * SqliteSource, opening the file lazily and only for a reader who actually
   * opens a book.
   */
  var ApiSource = {
    id: 'api',

    /* Nothing to open. That is the point of it. */
    prepare: function () { return Promise.resolve(); },

    /**
     * One request answers rows, total and facets together, so the facet panel
     * costs nothing extra — the old backend spent more round trips on facets
     * than on results. `facets()` below just hands back what this already got.
     */
    page: function (offset, limit, knownTotal) {
      var wantFacets = offset === 0;
      return ApiSource.query({ offset: offset, limit: limit, facets: wantFacets })
        .then(function (data) {
          if (wantFacets) ApiSource._facets = unpackFacets(data.facets || {});
          if (data.facetScan) ApiSource._scan = data.facetScan;
          return {
            rows: data.rows.map(mapSqlRow),
            total: data.total,
            exact: data.totalExact !== false,
          };
        });
    },

    facets: function () {
      // Already in hand from the page request; a second round trip would buy
      // nothing. Null means the page request has not run yet.
      return Promise.resolve(ApiSource._facets || null);
    },

    query: function (opts) {
      var u = new URL(manifest.api.replace(/\/$/, '') + '/api/search');
      var match = matchExpression(state.q);
      if (match) u.searchParams.set('q', match);
      FACETS.forEach(function (facet) {
        var set = state.filters[facet.key];
        if (!set || !set.size) return;
        set.forEach(function (value) { u.searchParams.append(facet.key, value); });
      });
      if (state.sort && state.sort !== 'relevance') u.searchParams.set('sort', state.sort);
      u.searchParams.set('offset', String(opts.offset || 0));
      u.searchParams.set('limit', String(opts.limit || PAGE_SIZE));
      if (!opts.facets) u.searchParams.set('facets', '0');

      var t0 = (window.performance || Date).now();
      return fetch(u.href).then(function (res) {
        if (!res.ok) throw new Error('search API ' + res.status);
        return res.json();
      }).then(function (data) {
        recordTiming('API ' + u.search, (window.performance || Date).now() - t0, data.rows && data.rows.length);
        if (data.error) throw new Error(data.error);
        return data;
      });
    },

    /* The book page still reads the file: `docs` is 124 MB of deflated full
       records and stayed in R2 rather than going to D1. Opened lazily, so a
       reader who only searches never pays for it. */
    record: function (id) {
      return ensureFile().then(function () { return SqliteSource.record(id); });
    },
    byIds: function (ids) {
      return ensureFile().then(function () { return SqliteSource.byIds(ids); });
    },
    siblings: function (isbn, exclude) {
      return ensureFile().then(function () { return SqliteSource.siblings(isbn, exclude); });
    },
  };

  /* Opens the range-request backend on demand, for the book page only. */
  var filePrepared = null;
  function ensureFile() {
    if (!filePrepared) filePrepared = SqliteSource.prepare();
    return filePrepared;
  }

  var SqliteSource = {
    id: 'sqlite',
    prepare: function () {
      var db = manifest.db;
      return loadScript('vendor/sqlite-httpvfs/index.js')
        .then(function () {
          if (typeof createDbWorker !== 'function') throw new Error('sqlite-httpvfs failed to load');
          // The worker resolves these against its own URL, not the page's, so
          // they have to be absolute.
          var abs = function (p) { return new URL(p, location.href).href; };
          return createDbWorker(
            [
              {
                from: 'inline',
                config: {
                  serverMode: 'full',
                  // `db.url` points the database at another origin — object
                  // storage such as R2 or S3 — for hosts that will not serve
                  // byte ranges of a binary file untouched. It needs CORS.
                  url: db.url ? db.url : abs(DATA + db.file),
                  // Set by the builder alongside the page size, so the two
                  // cannot drift apart. Several pages per request: round trips
                  // cost far more than the extra bytes.
                  requestChunkSize: db.chunkBytes || 4096,
                  // How far the VFS may run ahead once it decides reads look
                  // sequential. Its default is 5 MiB, and the heuristic
                  // misfires badly here: fetching a few hundred scattered rows
                  // in ascending rowid order looks sequential to it, so it
                  // prefetched megabytes of neighbouring pages that no query
                  // wanted — 35 MB of a 38 MB search.
                  maxReadSpeed: db.maxReadBytes || 524288,
                  // Some static hosts (GitHub Pages among them) answer HEAD
                  // without content-length, leaving the library unable to
                  // discover the file size. The manifest records it exactly.
                  databaseLengthBytes: db.bytes,
                  // (The library hardcodes its read-ahead growth, so queries
                  // are written to avoid large sequential scans instead.)
                },
              },
            ],
            abs('vendor/sqlite-httpvfs/sqlite.worker.js'),
            abs('vendor/sqlite-httpvfs/sql-wasm.wasm')
          );
        })
        .then(function (worker) {
          SqliteSource._worker = worker;
          // SQLite's default 2 MB page cache thrashes once a query touches
          // thousands of rows, and every evicted page costs another HTTP
          // request. Memory is far cheaper than round trips here.
          return worker.db.query('PRAGMA cache_size = -32000').then(function () { return worker; });
        })
        .then(function (worker) {
          // The manifest already knows the total; COUNT(*) would scan an
          // entire index over the network to learn the same number.
          totalBooks = manifest.totalBooks || 0;
          return SqliteSource.query('PRAGMA table_info(books)')
            .then(function (cols) {
              // Databases built before the Chinese-first change lack these.
              SqliteSource._zh = cols.some(function (c) { return c.name === 'zh_first'; });
            })
            .then(SqliteSource.verify);
        });
    },

    /**
     * Reads back a value recorded when the database was built. A host that
     * compresses the file and then applies byte ranges to the compressed
     * stream (GitHub Pages does exactly this) serves a database that opens
     * and answers queries — with wrong answers. Checking one known row costs
     * a single indexed lookup and turns silent corruption into a clean
     * fallback to the JSON shards.
     */
    /**
     * Reads books_fts_docsize into the page cache, in slices.
     *
     * bm25 normalises by document length, and the lengths live in that shadow
     * table. Measured against dbstat, a search for 香港文學 spends 16 of its
     * 49 range requests there — as many as fetching the result rows — and a
     * broad query spends far more, because the table is read once per
     * matching document and 漫畫 matches 24,004 of them.
     *
     * The table is only 4.3 MB, and the build VACUUMs, so its 1,097 pages sit
     * in 139 chunks that are nearly all its own. Read start to end it is a
     * sequential scan, which is the one access pattern sql.js-httpvfs is good
     * at: it ramps from 32 KiB to 256 KiB and fetches the lot in about twenty
     * requests. After that every search in the session scores for free.
     *
     * Dropping the table instead was measured and rejected. Rebuilt with
     * columnsize=0 the index is 4.3 MB smaller and bm25 still runs, but over
     * 9,708 matches for 東立 it returns 2 distinct scores where the real index
     * returns 58, so ORDER BY bm25 collapses to insertion order. Across 30
     * real queries not one kept its top 20.
     *
     * Sliced rather than run as one statement because the worker takes one
     * query at a time: a reader who searches mid-warm would otherwise wait
     * for all of it, and this way they wait for at most one slice.
     */
    warm: function () {
      if (SqliteSource._warming) return SqliteSource._warming;

      var SLICES = 8;
      var span = Math.ceil(446090 / SLICES);
      var waits = 0;

      /* Yields to the reader: a slice goes in only when nothing else is
         waiting, so a reader who searches or scrolls mid-warm waits for at
         most the slice already in flight.

         Kept as a safeguard rather than a measured win. The run that
         prompted it — focus, type for two seconds, search 政治 — took 29.6 s
         with the warm starting on focus and 30.9 s after it was removed, so
         the slices were not what made that search slow; it was slow because
         it was the first, and nothing had been warmed yet. The yield still
         holds where the earlier shape could genuinely have cost something:
         the warm now runs while a reader scrolls a long result list, and
         loadMore must not queue behind it. */
      function slice(i) {
        if (i >= SLICES) return Promise.resolve();

        if (SqliteSource._pending > 0) {
          // Give up rather than spin for ever if something stays pending.
          if (++waits > 400) return Promise.resolve();
          return new Promise(function (go) { setTimeout(go, 300); }).then(function () {
            return slice(i);
          });
        }

        return SqliteSource.query(
          'SELECT count(*) AS n FROM books_fts_docsize WHERE id BETWEEN ? AND ?',
          [i * span, (i + 1) * span],
          true // background: nobody is waiting on this
        ).catch(function () {}).then(function () {
          return slice(i + 1);
        });
      }

      SqliteSource._warming = slice(0);
      return SqliteSource._warming;
    },

    verify: function () {
      var probe = manifest.db.probe;
      if (!probe) return Promise.resolve();
      return SqliteSource.query('SELECT id FROM books WHERE rowid = ?', [probe.rowid]).then(function (res) {
        if (!res.length || res[0].id !== probe.id) {
          throw new Error(
            'database read back wrong data (expected ' + probe.id + ', got ' +
              (res.length ? res[0].id : 'nothing') + ') — the host may be compressing it'
          );
        }
      });
    },
    page: function (offset, limit, knownTotal) {
      var where = sqlWhere(null);
      var order = sqlOrder();
      var columns =
        'b.id, b.dataset, b.title, b.subtitle, b.authors, b.publisher, b.year, b.isbn,' +
        ' b.classification, b.language, b.series, b.ref, b.src, b.price, b.currency, b.forsale, b.cover' +
        (SqliteSource._zh ? ', b.parallel_title' : '');
      var sql;

      if (where.onlyQuery && order === 'bm25(books_fts)') {
        // Rank inside the FTS index and take the page there, then fetch only
        // those rows. Joining first would make SQLite walk a row for every
        // match — which, over range requests, drags most of the table across
        // the network to display sixty results.
        sql =
          'SELECT ' + columns + ' FROM (SELECT rowid FROM books_fts WHERE books_fts MATCH ?' +
          ' ORDER BY bm25(books_fts) LIMIT ? OFFSET ?) h CROSS JOIN books b ON b.rowid = h.rowid';
        return Promise.all([
          SqliteSource.query(sql, [where.match, limit, offset]),
          knownTotal !== undefined
            ? Promise.resolve([{ n: knownTotal }])
            : SqliteSource.query('SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH ?', [where.match]),
        ]).then(function (res) {
          return { rows: res[0].map(mapSqlRow), total: res[1][0].n };
        });
      }

      sql = 'SELECT ' + columns + ' FROM ' + where.from + where.sql + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?';

      var counting;
      var countScope = precomputedScope(null);
      if (knownTotal !== undefined) {
        counting = Promise.resolve([{ n: knownTotal }]); // appending: the total cannot have changed
      } else if (!where.params.length) {
        counting = Promise.resolve([{ n: totalBooks }]); // unfiltered: already known
      } else if (countScope) {
        // One language, one dataset or one year — the views a reader lands on
        // or clicks first. COUNT(*) there walks every index entry in the slice,
        // which grows with the catalogue, and the count is the scope facet's
        // own tally in the unnarrowed scope, already worked out at build time.
        var at = countScope.indexOf(':');
        counting = SqliteSource.query(
          "SELECT n FROM facet_counts WHERE scope = '' AND facet = ? AND value = ? LIMIT 1",
          [countScope.slice(0, at), countScope.slice(at + 1)]
        ).then(function (res) {
          return res.length ? res : SqliteSource.query('SELECT COUNT(*) AS n FROM ' + where.from + where.sql, where.params);
        });
      } else if (where.onlyQuery) {
        // Counting a plain search needs the FTS index alone — joining `books`
        // would pull a page per matching row across the network for nothing.
        counting = SqliteSource.query('SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH ?', [where.match]);
      } else {
        counting = SqliteSource.query('SELECT COUNT(*) AS n FROM ' + where.from + where.sql, where.params);
      }

      return Promise.all([SqliteSource.query(sql, where.params.concat([limit, offset])), counting]).then(function (res) {
        return { rows: res[0].map(mapSqlRow), total: res[1][0].n };
      });
    },
    facets: function () {
      var base = sqlWhere(null);

      // A plain search: every facet sees the same hit set, so all eight counts
      // come back from one query over one bounded pass, instead of eight
      // queries each re-walking the matches.
      if (base.onlyQuery) {
        var selects = FACETS.map(function (facet) {
          var expr = SQL_FACET[facet.key];
          return (
            "SELECT '" + facet.key + "' AS k, " + expr + ' AS v, COUNT(*) AS n' +
            // CROSS JOIN, not JOIN: it is the documented way to pin the join
            // order. Left to itself the planner scans the whole covering index
            // for the facet's column and probes `hits` for each row — cheaper
            // on a local disk, and on this backend six full index scans, about
            // 20 MB. Driving from the few hundred materialised hits and
            // fetching each row by rowid is what the LIMIT is for.
            ' FROM hits CROSS JOIN books b ON b.rowid = hits.rowid' +
            ' WHERE ' + expr + " <> '' GROUP BY v"
          );
        });
        var sql =
          'WITH hits AS MATERIALIZED (SELECT rowid FROM books_fts WHERE books_fts MATCH ? LIMIT ' + FACET_SCAN_CAP + ') ' +
          selects.join(' UNION ALL ');

        return SqliteSource.query(sql, [base.match]).then(function (list) {
          var out = {};
          FACETS.forEach(function (facet) { out[facet.key] = []; });
          list.forEach(function (r) {
            if (out[r.k]) out[r.k].push(toOption(r));
          });
          Object.keys(out).forEach(function (key) {
            out[key].sort(function (a, b) { return b.count - a.count || String(a.value).localeCompare(String(b.value)); });
            out[key] = out[key].slice(0, FACET_LIMIT);
          });
          return out;
        });
      }

      // Each facet is counted against the *other* active filters, so its
      // options stay meaningful — same rule as the in-memory path.
      var jobs = FACETS.map(function (facet) {
        var where = sqlWhere(facet.key);
        var expr = SQL_FACET[facet.key];

        // Either nothing narrows this facet, or only a language does — both
        // were counted at build time. A few indexed rows instead of
        // aggregating the catalogue over the network.
        var scope = precomputedScope(facet.key);
        if (scope !== null) {
          return SqliteSource.query(
            'SELECT value AS v, n FROM facet_counts WHERE scope = ? AND facet = ? ORDER BY n DESC, value LIMIT ?',
            [scope, facet.key, FACET_LIMIT]
          ).then(function (list) {
            return { key: facet.key, list: list.map(toOption) };
          });
        }

        var sql =
          'SELECT ' + expr + ' AS v, COUNT(*) AS n FROM ' + where.from + where.sql +
          (where.sql ? ' AND ' : ' WHERE ') + expr + " <> '' GROUP BY v ORDER BY n DESC, v LIMIT " + FACET_LIMIT;
        return SqliteSource.query(sql, where.params).then(function (list) {
          return { key: facet.key, list: list.map(toOption) };
        });
      });

      return Promise.all(jobs).then(function (all) {
        var out = {};
        all.forEach(function (entry) {
          out[entry.key] = entry.list;
        });
        return out;
      });
    },
    record: function (id) {
      // One query, both halves. `docs` holds only what `books` does not, so
      // the detail view reads the row and the blob together — the same single
      // round trip it has always been, because the two live at the same rowid.
      var columns =
        'b.id, b.dataset, b.title, b.subtitle, b.parallel_title, b.authors, b.publisher,' +
        ' b.year, b.isbn, b.classification, b.language, b.series, b.ref, b.src,' +
        ' b.price, b.currency, b.forsale, b.cover';
      return SqliteSource.query(
        'SELECT ' + columns + ', d.doc AS doc FROM books b JOIN docs d ON d.rowid = b.rowid' +
          ' WHERE b.id = ? LIMIT 1',
        [id]
      ).then(function (res) {
        if (!res.length) return null;
        return inflateDoc(res[0].doc).then(function (doc) {
          return mergeRecord(res[0], doc);
        });
      });
    },
    /**
     * Every other record carrying this ISBN.
     *
     * One index seek on idx_isbn and however many rows hang off it — 166 at
     * the worst in the catalogue, two for almost everything — so it is cheap
     * enough to run on every book page. The ordering is left to a temp b-tree
     * on purpose: an index that satisfied it would have to be built over the
     * whole table to serve a handful of rows.
     */
    siblings: function (isbn, exclude) {
      if (!isbn) return Promise.resolve([]);
      var columns =
        'b.id, b.dataset, b.title, b.subtitle, b.authors, b.publisher, b.year, b.isbn,' +
        ' b.classification, b.language, b.series, b.ref, b.src, b.price, b.currency, b.forsale, b.cover' +
        (SqliteSource._zh ? ', b.parallel_title' : '');
      var order = SqliteSource._zh ? 'b.dataset, b.zh_first, b.title_display' : 'b.dataset, b.title';
      return SqliteSource.query(
        'SELECT ' + columns + ' FROM books b WHERE b.isbn = ? AND b.id <> ? ORDER BY ' + order + ' LIMIT 200',
        [isbn, exclude || '']
      ).then(function (res) {
        return res.map(mapSqlRow);
      });
    },
    byIds: function (ids) {
      if (!ids.length) return Promise.resolve([]);
      var columns =
        'b.id, b.dataset, b.title, b.subtitle, b.authors, b.publisher, b.year, b.isbn,' +
        ' b.classification, b.language, b.series, b.ref, b.src, b.price, b.currency, b.forsale, b.cover' +
        (SqliteSource._zh ? ', b.parallel_title' : '');
      var holes = ids.map(function () { return '?'; }).join(',');
      return SqliteSource.query('SELECT ' + columns + ' FROM books b WHERE b.id IN (' + holes + ')', ids).then(
        function (res) {
          var found = {};
          res.map(mapSqlRow).forEach(function (r) { found[r.id] = r; });
          return ids.map(function (id) { return found[id]; }).filter(Boolean);
        }
      );
    },
    /**
     * `background` marks a query nobody is waiting for — only the bm25 warm.
     * Everything else counts towards _pending, which the warm reads to decide
     * whether to keep going. The worker runs one query at a time, so a slice
     * submitted while a reader waits is a slice the reader waits for too.
     */
    query: function (sql, params, background) {
      if (!background) SqliteSource._pending = (SqliteSource._pending || 0) + 1;
      var settle = function () {
        if (!background) SqliteSource._pending--;
      };
      // Timed, because the cost of a query here is invisible everywhere else:
      // the range requests happen inside a Web Worker, so they appear in
      // neither the page's resource timeline nor the browser's network panel.
      // Without this there is no way to tell a slow query from many of them,
      // which is exactly the question that took four deploys to answer.
      var t0 = (window.performance || Date).now();
      return SqliteSource._worker.db.query(sql, params || []).then(function (res) {
        settle();
        recordTiming(sql, (window.performance || Date).now() - t0, res && res.length);
        return res;
      }, function (err) {
        settle();
        recordTiming(sql, (window.performance || Date).now() - t0, 'error');
        throw err;
      });
    },
  };

  /* SQL_FACET and FACET_LIMIT come from schema.js, shared with the builder. */

/**
 * The last few queries, with how long each took.
 *
 * Shown on the About page and left on window.__timings, so a slow page can be
 * reported as numbers rather than as "it takes forever" — which was accurate
 * every time it was said, and told neither of us which of nine queries was at
 * fault.
 */
  var timings = [];

  function recordTiming(sql, ms, rows) {
    var label = String(sql).replace(/\s+/g, ' ').trim();
    // Enough of the statement to tell the nine apart, not the whole thing.
    if (label.length > 72) label = label.slice(0, 72) + '…';
    timings.push({ ms: Math.round(ms), rows: rows, sql: label });
    if (timings.length > 40) timings.shift();
    window.__timings = timings;
  }

  function timingSummary() {
    if (!timings.length) return 'no queries yet';
    var total = timings.reduce(function (a, t) { return a + t.ms; }, 0);
    var lines = timings.slice(-12).map(function (t) {
      return String(t.ms).padStart(6) + ' ms  ' + String(t.rows).padStart(5) + ' rows  ' + t.sql;
    });
    return timings.length + ' queries, ' + total + ' ms in total\n\n' + lines.join('\n');
  }

  function toOption(r) {
    return { value: String(r.v), count: r.n };
  }

  /** WHERE clause for the active filters and query, optionally skipping one facet. */
  /**
   * Which build-time scope answers this facet, or null if nothing does.
   *
   * '' is the whole catalogue. A language code means every other filter is
   * idle and that one language is selected — the state the site opens in,
   * and the reason the scoped rows exist at all. Anything else (a search
   * term, a publisher, two languages at once) has to be counted live.
   */
  /**
   * The payload for the current view if the build step precomputed it: the
   * first screenful, in default order, of the whole catalogue or of a single
   * language, with nothing else narrowing it.
   */
  function prerendered() {
    if (!firstPage || !firstPage.scopes) return null;
    if (state.q || state.sort !== 'relevance') return null;
    var scope = precomputedScope(null);
    if (scope === null) return null;
    // firstpage.json only carries the whole catalogue and the single-language
    // views, keyed by the bare language, since those are the only ones a reader
    // can land on without clicking. Anything else comes from the database.
    if (scope === '') return firstPage.scopes[''] || null;
    if (scope.indexOf('language:') !== 0) return null;
    return firstPage.scopes[scope.slice('language:'.length)] || null;
  }

  /**
   * The same thing for every other scope, fetched rather than carried.
   *
   * The landing view ships inside firstpage.json because it is needed before
   * anything else. The other 763 are one file each, fetched when clicked:
   * loading them all up front would be 20 MB to open the homepage.
   *
   * This is what a filtered browse costs now — one HTTP request, cached by the
   * edge like any other static file. Against ~45 serial range requests, which
   * measured 20 s from Hong Kong and about three minutes through a US exit.
   */
  var scopePageCache = {};

  function scopePage() {
    if (!manifest.pages || !manifest.pages.scopes) return null;
    if (state.q || state.sort !== 'relevance') return null;
    var scope = precomputedScope(null);
    if (!scope) return null; // '' and null both fall through to firstPage
    var n = manifest.pages.scopes[scope];
    if (n === undefined) return null;

    if (!scopePageCache[n]) {
      scopePageCache[n] = fetch(DATA + manifest.pages.dir + n + '.json')
        .then(function (res) {
          if (!res.ok) throw new Error('scope page ' + n + ': ' + res.status);
          return res.json();
        })
        .catch(function () {
          // A missing or broken file must not break the view; the database
          // answers the same question, only slower.
          scopePageCache[n] = null;
          return null;
        });
    }
    return scopePageCache[n];
  }

  // The facets the builder precomputes a scope for. Their values select large
  // slices, so counting one live means reading every matching row.
  var SCOPE_FACETS = ['language', 'dataset', 'year', 'source', 'availability', 'identifier'];

  /**
   * Facets the builder scopes only above a size, because they have too many
   * values to scope exhaustively — 38,053 publishers, of which 312 have 200
   * records or more.
   *
   * The client does not need a list of which ones were precomputed: by the
   * time the facets run, the page query has already returned the result count,
   * and that is the same number the builder thresholded on. Above it the scope
   * exists; below it the live aggregation reads fewer than 200 rows and is
   * cheap anyway.
   */
  var BIG_SCOPE_FACETS = { publisher: 200, classification: 200 };

  function precomputedScope(skipFacet) {
    if (matchExpression(state.q)) return null;

    var scope = '';
    var usable = true;

    FACETS.forEach(function (facet) {
      if (!usable || facet.key === skipFacet) return;
      var set = state.filters[facet.key];
      if (!set || !set.size) return;
      var floor = BIG_SCOPE_FACETS[facet.key];
      var scopable =
        SCOPE_FACETS.indexOf(facet.key) !== -1 ||
        (floor !== undefined && totalResults >= floor);
      if (scopable && set.size === 1 && !scope) {
        set.forEach(function (value) { scope = facet.key + ':' + value; });
      } else {
        usable = false;
      }
    });

    return usable ? scope : null;
  }

  function sqlWhere(skipFacet) {
    var clauses = [];
    var params = [];
    var from = 'books b';

    var match = matchExpression(state.q);
    if (match) {
      from = 'books_fts f JOIN books b ON b.rowid = f.rowid';
      clauses.push('f.books_fts MATCH ?');
      params.push(match);
    }

    FACETS.forEach(function (facet) {
      if (facet.key === skipFacet) return;
      var set = state.filters[facet.key];
      if (!set || !set.size) return;
      var values = [];
      set.forEach(function (value) {
        values.push('?');
        params.push(value);
      });
      clauses.push(SQL_FACET[facet.key] + ' IN (' + values.join(',') + ')');
    });

    return {
      from: from,
      sql: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '',
      params: params,
      match: match,
      onlyQuery: !!match && clauses.length === 1,
    };
  }

  /* How many matches a search-time facet count will look at. Beyond this the
     counts are marked approximate rather than making the user wait while the
     whole result set is walked over the network. */
  var FACET_SCAN_CAP = 600;

  function sqlOrder() {
    // With the Chinese-first columns present, every title ordering groups CJK
    // titles ahead of Latin ones — the same rule the in-memory path applies.
    var t = SqliteSource._zh ? 'b.zh_first, b.title_display' : 'b.title';
    var tDesc = SqliteSource._zh ? 'b.zh_first, b.title_display DESC' : 'b.title DESC';
    // Every term reversed, so an index can be scanned backwards rather than
    // the result sorted. `tDesc` keeps zh_first ascending, which cannot be.
    var tDescAll = SqliteSource._zh ? 'b.zh_first DESC, b.title_display DESC' : 'b.title DESC';

    switch (state.sort) {
      case 'title':
        return t;
      case 'title-desc':
        return tDesc;
      // These three spell out the exact column order of idx_browse_year and
      // idx_browse_publisher, including the cover expression in the middle,
      // because anything else makes SQLite sort the whole table in a temp
      // b-tree — 446,090 rows fetched one range request at a time to return
      // sixty. Descending reverses every term, which is what lets the same
      // index be read backwards.
      //
      // The cost is that undated books, and books with no publisher, now lead
      // the ascending orders instead of trailing them: the old expressions put
      // them last with a `year IS NULL` or `publisher = ''` term in front, and
      // that term is what no index can satisfy.
      case 'year':
        return "b.year, b.cover = '', " + t;
      case 'year-desc':
        return "b.year DESC, b.cover = '' DESC, " + tDescAll;
      case 'publisher':
        return "b.publisher, b.cover = '', " + t;
      default:
        // Empty cover sorts last, so books with one lead the browse order.
        return state.q ? 'bm25(books_fts)' : "b.cover = '', " + t;
    }
  }

  /** SQL row -> the same shape the card renderer gets from the JSON index. */
  /** The precomputed counts are stored as {v, n}; toOption() shapes them. */
  function unpackFacets(packed) {
    var out = {};
    FACETS.forEach(function (facet) {
      out[facet.key] = (packed[facet.key] || []).map(toOption);
    });
    return out;
  }

  /**
   * Undo HTML escaping a source applied before we ever saw the text.
   *
   * 30 titles read "&lt;&lt;街頭巷尾&gt;&gt;咖啡小日曆" because that is how
   * the National Library's holdings records spell "<<街頭巷尾>>咖啡小日曆",
   * and nothing on the way in undid it. The importer does now — but the
   * database in R2 was built before that, so decoding here is what makes the
   * records already published read correctly. Once a rebuild has been
   * through, this finds nothing to do and costs an indexOf('&') per field.
   *
   * Safe against a title that genuinely contains a "<": every one of these
   * goes through highlight(), which escapes before it writes any HTML.
   */
  function deco(value) {
    return typeof decodeEntities === 'function' ? decodeEntities(value) : value || '';
  }

  function mapSqlRow(r) {
    var row = {
      id: r.id,
      _ds: r.dataset,
      title: deco(r.title),
      subtitle: deco(r.subtitle),
      authors: r.authors ? String(r.authors).split(', ').map(deco) : [],
      publisher: deco(r.publisher),
      year: r.year,
      isbn: r.isbn,
      classification: r.classification,
      language: r.language,
      series: deco(r.series),
      parallelTitle: deco(r.parallel_title || ''),
      ref: r.ref,
      src: r.src,
      cover: r.cover || '',
    };
    if (typeof r.price === 'number') {
      row.price = r.price;
      row.currency = r.currency;
    }
    if (r.forsale === 0 || r.forsale === 1) row.forSale = r.forsale === 1;
    return row;
  }

  /**
   * Rebuilds a full record from the `books` row and the thinned blob beside it.
   *
   * `docs` used to hold the whole record, which made it 60% of the database
   * and put the file over Cloudflare's 512 MB cacheable ceiling — past which
   * every range request is answered from origin, measured at +258 ms each. It
   * now holds only the fields the row does not, and this puts the two back
   * together.
   *
   * `authors`, `series` and `price` are read from the blob rather than the
   * row: the columns hold lossy forms of all three (a joined display string,
   * `series.title` where the description wants `series.raw`, and the numeric
   * amount where a tenth of priced books have only "Unpriced"). The fallbacks
   * below are for a record that predates the blob carrying them.
   */
  /**
   * The docs blob is a deflated, positionally-encoded record — see
   * site/doc-codec.js for why, and for the field order.
   *
   * Raw deflate, which DecompressionStream reads natively, so there is no
   * library to ship. Where the browser lacks it, or the row turns out to be
   * plain JSON from an older build, the detail view falls back rather than
   * failing: it then shows what the `books` row holds, which is most of the
   * page.
   */
  function inflateDoc(value) {
    if (value === null || value === undefined || value === '') return Promise.resolve({});

    // An older database stored JSON text here.
    if (typeof value === 'string') {
      try {
        return Promise.resolve(decodeDoc(JSON.parse(value)));
      } catch (err) {
        return Promise.resolve({});
      }
    }

    if (typeof DecompressionStream !== 'function' || typeof Response !== 'function') {
      return Promise.resolve({});
    }

    try {
      var stream = new Blob([value]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream)
        .text()
        .then(function (text) { return decodeDoc(JSON.parse(text)); })
        .catch(function () { return {}; });
    } catch (err) {
      return Promise.resolve({});
    }
  }

  /**
   * deco() over every string in a tree, in place.
   *
   * The detail view needs this and the grid does not, because the grid shows
   * the columns of `books` and the detail view also shows the deflated `doc`
   * — and the escaping is in there too: the record behind
   * 《街頭巷尾》咖啡小日曆 carries "&lt;&lt;街頭巷尾&gt;&gt;咖啡小日曆." as
   * its raw catalogued title, several levels down.
   *
   * Run on the doc alone, before anything from the manifest is attached to
   * it. The manifest's dataset objects are shared by every record on the
   * page, and walking into one would rewrite it for all of them.
   */
  function decodeDeep(node, depth) {
    if (!node || depth > 8) return node;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        node[i] = typeof node[i] === 'string' ? deco(node[i]) : decodeDeep(node[i], depth + 1);
      }
      return node;
    }
    if (typeof node !== 'object') return node;
    Object.keys(node).forEach(function (key) {
      var v = node[key];
      node[key] = typeof v === 'string' ? deco(v) : decodeDeep(v, depth + 1);
    });
    return node;
  }

  function mergeRecord(r, doc) {
    var rec = decodeDeep(doc || {}, 0);

    rec.id = r.id;
    rec.dataset = r.dataset;
    rec.title = deco(r.title);
    rec.subtitle = deco(r.subtitle);
    rec.parallelTitle = deco(r.parallel_title || '');
    rec.publisher = deco(r.publisher);
    rec.year = r.year;
    rec.isbn = r.isbn;
    rec.classification = r.classification;
    rec.language = r.language;
    rec.ref = r.ref;
    rec.cover = r.cover ? { url: r.cover } : null;

    // `src` indexes the dataset's own list of source files, which the manifest
    // already carries; the record used to spell the label and URL out again
    // for every book published from that file.
    var ds = datasetById(r.dataset);
    rec.source = ds && ds.sources ? ds.sources[Number(r.src || 0)] : null;

    if (!rec.authors) {
      rec.authors = r.authors
        ? String(r.authors).split(', ').map(function (n) {
            return { name: deco(n), display: deco(n) };
          })
        : [];
    }
    if (!rec.series && r.series) rec.series = { title: deco(r.series), raw: deco(r.series) };
    if (!rec.price && typeof r.price === 'number') {
      rec.price = { amount: r.price, currency: r.currency || '' };
    }
    if (rec.price && (r.forsale === 0 || r.forsale === 1)) rec.price.forSale = r.forsale === 1;

    // Derived, not stored: site/derive.js is the same code the build ran, so
    // these read exactly as they did when the database carried them.
    if (!rec.description && window.buildDescription) rec.description = window.buildDescription(rec);
    if (!rec.copyright && window.buildCopyright) rec.copyright = window.buildCopyright(rec);

    return rec;
  }

  function querySignature() {
    var parts = [state.q, state.sort];
    FACETS.forEach(function (facet) {
      var set = state.filters[facet.key];
      parts.push(facet.key + '=' + (set ? [...set].sort().join('|') : ''));
    });
    return parts.join(' ');
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = src;
      tag.onload = resolve;
      tag.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(tag);
    });
  }

  /* ---------------- render: browse ---------------- */

  /**
   * Shows that a query is in flight.
   *
   * A query the build step did not precompute costs dozens of serial range
   * requests — SQLite cannot ask for a page until it has read the page that
   * points at it — so a search can take seconds, and until it answers the grid
   * still holds the *previous* results. Without this the site looks like it
   * ignored the keystroke.
   *
   * The skeleton waits a moment before appearing, so a fast answer does not
   * flash an empty grid on its way past.
   */
  function setSearching(on) {
    clearTimeout(searchingTimer);
    el.search.classList.toggle('busy', !!on);
    el.results.setAttribute('aria-busy', on ? 'true' : 'false');

    if (!on) {
      el.count.classList.remove('searching');
      return;
    }
    searchingTimer = setTimeout(function () {
      if (!el.search.classList.contains('busy')) return;
      el.count.textContent = '搜尋中…';
      el.count.classList.add('searching');
      el.empty.hidden = true;
      el.grid.innerHTML = '';
      showSkeleton();
    }, 150);
  }

  function render() {
    var token = ++renderToken;
    state.page = 1;

    // Identical data to the query below, already on hand. Painting from it
    // costs no round trips, so the landing view appears with the page.
    var pre = prerendered();
    if (pre) {
      setSearching(false);
      results = pre.rows.map(mapSqlRow);
      totalResults = pre.total;
      totalExact = true;
      renderCount();
      renderChips();
      renderGrid(false);
      renderFacets(unpackFacets(pre.facets));
      facetCounts.fresh = true;
      requestAnimationFrame(maybeLoadMore);
      return Promise.resolve();
    }

    setSearching(true);

    // Every other precomputed scope: one fetch, no database. Falls through to
    // the queries below if the file is missing or the fetch fails, so a bad
    // deploy degrades to slow rather than to broken.
    var page = scopePage();
    if (page) {
      return page.then(function (data) {
        if (token !== renderToken) return;
        if (!data) return renderFromDatabase(token);
        setSearching(false);
        results = data.rows.map(mapSqlRow);
        totalResults = data.total;
        totalExact = true;
        renderCount();
        renderChips();
        renderGrid(false);
        renderFacets(unpackFacets(data.facets));
        facetCounts.fresh = true;
        requestAnimationFrame(maybeLoadMore);
      });
    }

    return renderFromDatabase(token);
  }

  /** The original path: page query, then facets. */
  function renderFromDatabase(token) {

    return ensureSource()
      .then(function () {
        return source.page(0, FIRST_DB_ROWS);
      })
      .then(function (res) {
        if (token !== renderToken) return null;
        setSearching(false);
        results = res.rows;
        totalResults = res.total;
        totalExact = res.exact !== false;
        renderCount();
        renderChips();
        renderGrid(false);
        // Unblocked here rather than after the facet query. The two are
        // independent, and gating the next page on 82 extra range requests
        // made a long list feel stuck part-way down.
        requestAnimationFrame(maybeLoadMore);
        facetCounts.fresh = false;
        warmScoring();
        return ensureFacets(token);
      })
      .catch(function (err) {
        if (token !== renderToken) return;

        // The API is an optimisation, not a dependency: the whole catalogue is
        // still in R2 and the file backend still answers every query it ever
        // did, slowly. A reader whose network — or our Worker — is having a bad
        // minute gets the slow answer rather than no answer.
        if (source === ApiSource && !ApiSource._failed) {
          ApiSource._failed = true;
          console.warn('search API unavailable: ' + err.message + '; falling back to the database file.');
          dbFallbackReason = err.message;
          source = SqliteSource;
          sourcePrepared = ensureFile(); // reuse it if the book page already opened it
          renderBuildId();
          return renderFromDatabase(token);
        }

        setSearching(false);
        el.grid.innerHTML = '';
        el.empty.hidden = false;
        el.empty.innerHTML = '<h3>查詢失敗</h3><p>' + escapeHtml(err.message) + '</p>';
      });
  }

  /**
   * Facet counts for the panel, computed only while the panel is on screen.
   *
   * For a plain search they are the expensive half of the work: measured over
   * 香港文學, 344 hits, the results take 95 range requests and the facets
   * another 82, because the query fetches each matching row once per facet and
   * each of those fetches drags its neighbouring pages along. Below 900px the
   * panel is `display: none` until 篩選 is tapped, so that was most of a
   * search spent on a list nobody had asked to see.
   *
   * Nothing is approximated: when the panel opens, the same query runs and the
   * same counts appear. Browsing is untouched — those counts come from the
   * precomputed `facet_counts` table and cost a single lookup.
   */
  var facetCounts = { fresh: false, running: false };

  /**
   * Above 900px the sidebar is laid out inline and always on screen; below it
   * is hidden until the toggle adds `open`. Asking the stylesheet's own
   * breakpoint keeps the two from drifting apart.
   */
  function sidebarVisible() {
    if (!el.sidebar) return false;
    if (!window.matchMedia || !window.matchMedia('(max-width: 900px)').matches) return true;
    return el.sidebar.classList.contains('open');
  }

  function ensureFacets(token) {
    if (facetCounts.fresh || facetCounts.running) return Promise.resolve();
    if (token !== undefined && token !== renderToken) return Promise.resolve();

    if (!sidebarVisible()) {
      // Drop what the panel is holding. Those numbers were counted against a
      // different result set, and leaving them in place would have the panel
      // assert, for as long as the recount takes after it is opened, that this
      // search has the previous one's languages and publishers. The panel is
      // display:none at this point, so there is nothing to see happen.
      renderFacets._counts = null;
      el.facets.innerHTML = '';
      return Promise.resolve();
    }

    facetCounts.running = true;
    el.facets.setAttribute('aria-busy', 'true');
    if (!renderFacets._counts) el.facets.innerHTML = '<p class="facets-pending">計算篩選項…</p>';

    var at = renderToken;
    return ensureSource()
      .then(function () { return source.facets(); })
      .then(function (counts) {
        facetCounts.running = false;
        el.facets.removeAttribute('aria-busy');
        if (at !== renderToken || !counts) return;
        facetCounts.fresh = true;
        renderFacets(counts);
      })
      .catch(function () {
        facetCounts.running = false;
        el.facets.removeAttribute('aria-busy');
      });
  }

  /**
   * Pulls the bm25 length table into the page cache, once, in the background.
   * Never awaited and never allowed to fail a render — see SqliteSource.warm.
   *
   * Called only after a search the database actually answered, never on the
   * way into one. Starting it when the search box was focused was measured
   * and dropped: eighteen requests do not finish in the seconds it takes to
   * type, so by the time the reader searched, nothing had been warmed and
   * the search cost what it always had (29.6 s for 政治 with the trigger,
   * 30.9 s without it). The trigger bought nothing, so it went.
   *
   * The first search of a session therefore pays full price, and every one
   * after it does not. Live, through a US-exit VPN: ~30 s for the first,
   * 9–15 s for later ones. The spread is network noise, not the query — the
   * same search varies by several seconds between runs.
   */
  function warmScoring() {
    if (!source || !source.warm) return;
    ensureSource().then(function () {
      if (source && source.warm) source.warm();
    }, function () {});
  }

  /** Fetches the next page and appends it, without re-running the facets. */
  function loadMore() {
    if (SqliteSource._busy) return;
    var token = renderToken;
    SqliteSource._busy = true;
    return ensureSource()
      .then(function () {
        return source.page(results.length, PAGE_SIZE, totalResults);
      })
      .then(function (res) {
        SqliteSource._busy = false;
        if (token !== renderToken) return;
        // A capped total keeps the button visible past the number, because
        // the number is a floor rather than the end. An empty page is the
        // end, and the only signal there is.
        if (!res.rows.length) {
          totalResults = results.length;
          totalExact = true;
          el.more.hidden = true;
          renderCount();
          return;
        }
        var start = results.length;
        results = results.concat(res.rows);
        totalResults = res.total;
        totalExact = res.exact !== false;
        renderGrid(true, start);
      })
      .catch(function () {
        SqliteSource._busy = false;
      });
  }

  /**
   * 筆書目, not 本.
   *
   * The catalogue is sixteen datasets held side by side rather than merged,
   * because provenance matters and a bad import has to be removable. So the
   * same book can be counted more than once: 446,090 records carry 335,148
   * distinct ISBN-13s, and a title registered for an ISBN, then catalogued by
   * the national library, then held by a university appears three times.
   *
   * "本" claims a number of books. "筆書目" says what this actually is — a
   * number of bibliographic records — which is both true and the thing a
   * reader of a union catalogue would expect.
   */
  function renderCount() {
    // "20,000+" rather than "20,000": past the cap the API stops counting
    // instead of reading every matching row for a number no one scrolls to.
    var n = fmt(totalResults) + (totalExact ? '' : '+');
    el.count.innerHTML =
      totalResults === totalBooks && totalExact
        ? '共 <strong>' + fmt(totalBooks) + '</strong> 筆書目'
        : '<strong>' + n + '</strong> 筆（全部 ' + fmt(totalBooks) + ' 筆書目）';
  }

  function renderGrid(append, from) {
    var start = append ? from || 0 : 0;
    var slice = results.slice(start);

    if (!append) {
      el.grid.innerHTML = '';
      el.grid.className = 'grid' + (state.view === 'list' ? ' list' : '');
      shown = new Map();
    }

    var terms = searchTerms(state.q);
    var frag = document.createDocumentFragment();
    slice.forEach(function (row) {
      // Folded at display time, not in the data: `results` and every count
      // still hold every record, and turning this off shows them all again.
      var key = grouping ? dedupeKey(row, displayTitle(row)) : '';
      var group = key && shown.get(key);
      if (group) {
        group.members.push(row);
        paintDupes(group);
        return;
      }
      var node = card(row, terms);
      if (key) shown.set(key, { node: node, members: [row], note: null });
      frag.appendChild(node);
    });
    el.grid.appendChild(frag);

    el.more.hidden = totalExact && results.length >= totalResults;
    el.empty.hidden = totalResults !== 0;
    if (!totalResults) {
      // A search for an English title finds nothing while the default Chinese
      // filter is on, so offer the way out rather than leaving a dead end.
      var langFilter = state.filters.language;
      el.empty.innerHTML =
        '<h3>沒有符合的書刊</h3><p>試試減少關鍵詞，或<button class="linkish" id="empty-reset">重設篩選</button>。</p>' +
        (langFilter && langFilter.size
          ? '<p><button class="linkish" id="empty-all-langs">搜尋全部語言的書刊</button></p>'
          : '');
      var reset = document.getElementById('empty-reset');
      if (reset) reset.addEventListener('click', function () { document.getElementById('clear-filters').click(); });
      var allLangs = document.getElementById('empty-all-langs');
      if (allLangs) {
        allLangs.addEventListener('click', function () {
          delete state.filters.language;
          state.page = 1;
          pushRoute();
          render();
        });
      }
    }
  }

  /**
   * Says on a card that it stands for more than one record.
   *
   * Written into the card already on screen rather than by re-rendering,
   * because the duplicate usually arrives with a later page: re-rendering the
   * grid under a reader who is scrolling it would lose their place, and
   * appending is the only reason infinite scroll is bearable here.
   *
   * The wording is 書目, not 本 — the catalogue counts records and these are
   * records. What the card is saying is that the others say the same thing.
   */
  function paintDupes(group) {
    var extra = group.members.length - 1;
    if (extra < 1) return;

    if (!group.note) {
      var body = group.node.querySelector('.card-body');
      if (!body) return;
      group.note = document.createElement('p');
      group.note.className = 'card-dupes';
      // Before the 我有 button, which the list view puts last in the body:
      // appending would otherwise leave a note about the catalogue sitting
      // underneath the one control on the card.
      body.insertBefore(group.note, body.querySelector('.own-inline'));
    }

    // Which datasets the folded records came from. This is the provenance the
    // fold would otherwise hide, so it is the tooltip, and the book page lists
    // every one of them with a link.
    var names = [];
    group.members.forEach(function (row) {
      var name = datasetName(row._ds);
      if (names.indexOf(name) === -1) names.push(name);
    });

    group.note.textContent = '另有 ' + extra + ' 筆相同書目';
    group.note.title =
      names.length > 1
        ? '同一本書在 ' + names.join('、') + ' 各有紀錄，書名、副題、ISBN 及出版年份完全相同。按下可見全部紀錄。'
        : names[0] + ' 有 ' + group.members.length + ' 筆完全相同的紀錄。按下可見全部紀錄。';
  }

  /* Keeps filling while the end of the list is in reach: an observer only
     reports *changes* in intersection, so a sentinel that stays on screen
     after an append would never fire again. */
  function maybeLoadMore() {
    if (el.browse.hidden || el.more.hidden) return;
    if (el.sentinel.getBoundingClientRect().top > window.innerHeight + 600) return;
    var pending = loadMore();
    if (pending) pending.then(function () { requestAnimationFrame(maybeLoadMore); });
  }

  /**
   * A card is a container rather than one big link, so the author and
   * publisher can be real links to their own listings. The title link is
   * stretched over the whole card in CSS, which keeps "click anywhere" while
   * leaving the inner links clickable, focusable and openable in a new tab —
   * none of which works with anchors nested inside an anchor.
   */
  function card(row, terms) {
    var a = document.createElement('article');
    a.className = 'card';

    a.appendChild(coverEl(row));

    // One control per card: the grid gets it over the cover, the list gets the
    // labelled one beside the text, where the thumbnail is too small for it.
    // It hangs off the card rather than the cover, because the cover picks up
    // a transform on hover, and a transform traps z-index in its own stacking
    // context — which put the button under the card's click overlay.
    if (state.view !== 'list') a.appendChild(ownButton(row.id, 'icon', row));

    var body = document.createElement('div');
    body.className = 'card-body';

    var title = document.createElement('h3');
    title.className = 'card-title';
    var titleLink = document.createElement('a');
    titleLink.className = 'card-link';
    titleLink.href = '#/book/' + encodeURIComponent(row.id);
    titleLink.innerHTML = highlight(displayTitle(row) || '無題', terms);
    title.appendChild(titleLink);
    body.appendChild(title);

    var other = altTitle(row);
    if (other) {
      var alt = document.createElement('p');
      alt.className = 'card-alt';
      alt.innerHTML = highlight(other, terms);
      body.appendChild(alt);
    }

    if (state.view === 'list' && row.subtitle) {
      var sub = document.createElement('p');
      sub.className = 'card-sub';
      sub.innerHTML = highlight(row.subtitle, terms);
      body.appendChild(sub);
    }

    body.appendChild(metaLine(row, terms));

    if (state.view === 'list') {
      var tags = document.createElement('div');
      tags.className = 'tagrow';
      if (row.classification) {
        tags.appendChild(
          tagLink(
            row.classification,
            '#/?classification=' + encodeURIComponent(row.classification),
            '瀏覽類別：' + row.classification
          )
        );
      }
      if (row.isbn) tags.appendChild(tag('ISBN ' + row.isbn));
      if (typeof row.price === 'number') tags.appendChild(tag(money(row.price, row.currency)));
      else if (row.forSale === false) tags.appendChild(tag('非賣品'));
      body.appendChild(tags);
    }

    if (state.view === 'list') body.appendChild(ownButton(row.id, 'inline', row));

    a.appendChild(body);
    return a;
  }

  /**
   * The own/not-own control.
   *
   * `mode` is 'icon' on a cover in the grid, 'inline' beside a row in the
   * list, and 'long' on a book page. The grid gets it on the cover because
   * below the text it sat at the bottom of a card, after the publisher line,
   * where nobody found it.
   */
  function ownButton(id, mode, row) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'own own-' + mode + (Shelf.has(id) ? ' owned' : '');
    b.dataset.id = id;
    paintOwn(b, mode);
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();

      if (Shelf.has(id)) {
        Shelf.remove(id);
        b.classList.remove('owned');
        paintOwn(b, mode);
        if (!el.shelf.hidden) renderShelf();
        return;
      }

      // Adding asks what it should sell for, starting from the catalogue price.
      askPrice({ title: displayTitle(row), original: row.price, currency: row.currency }).then(function (price) {
        if (price === undefined) return; // backed out
        Shelf.add(id, price);
        b.classList.add('owned');
        paintOwn(b, mode);
        if (!el.shelf.hidden) renderShelf();
      });
    });
    return b;
  }

  function paintOwn(b, mode) {
    var owned = b.classList.contains('owned');
    if (mode === 'icon') b.textContent = owned ? '✓' : '＋';
    else if (mode === 'long') b.textContent = owned ? '✓ 已在我的書架' : '＋ 加入我的書架';
    else b.textContent = owned ? '✓ 我有' : '＋ 我有';
    var label = owned ? '從我的書架移除' : '加入我的書架';
    b.setAttribute('aria-pressed', String(owned));
    b.setAttribute('aria-label', label);
    b.title = label;
  }

  /** Author and publisher as links to their own listings. */
  function metaLine(row, terms) {
    var meta = document.createElement('p');
    meta.className = 'card-meta';

    (row.authors || []).forEach(function (name, i) {
      if (i) meta.appendChild(document.createTextNode('、'));
      meta.appendChild(metaLink(name, searchHref(name), terms, '搜尋著者：' + name));
    });

    if ((row.authors || []).length) meta.appendChild(document.createElement('br'));

    if (row.publisher) {
      // The publisher is a facet, so this filters exactly rather than searching.
      meta.appendChild(
        metaLink(row.publisher, '#/?publisher=' + encodeURIComponent(row.publisher), terms, '瀏覽出版者：' + row.publisher)
      );
    }
    if (row.year) {
      if (row.publisher) meta.appendChild(document.createTextNode(' · '));
      meta.appendChild(document.createTextNode(String(row.year)));
    }
    return meta;
  }

  /** Same link, built as HTML for the book page's tables and byline. */
  function metaLinkHtml(text, href, label) {
    return (
      '<a class="meta-link" href="' + escapeAttr(href) + '" title="' + escapeAttr(label) + '">' +
      escapeHtml(text) +
      '</a>'
    );
  }

  function authorHref(author) {
    // Search the name as it is displayed and indexed: the catalogue stores it
    // inverted ("Luk, Ming Man Liza") but the index holds the natural form, so
    // searching the raw value finds nothing.
    return searchHref(author.display || author.name);
  }

  function metaLink(text, href, terms, label) {
    var link = document.createElement('a');
    link.className = 'meta-link';
    link.href = href;
    link.innerHTML = highlight(text, terms);
    link.title = label;
    return link;
  }

  /** A tag that filters, for the list view's category chip. */
  function tagLink(text, href, label) {
    var a = document.createElement('a');
    a.className = 'tag tag-link';
    a.href = href;
    a.textContent = text;
    a.title = label;
    return a;
  }

  function tag(text) {
    var span = document.createElement('span');
    span.className = 'tag';
    span.textContent = text;
    return span;
  }

  function joinMeta(row) {
    return [escapeHtml(row.publisher || ''), row.year ? String(row.year) : '']
      .filter(Boolean)
      .join(' · ');
  }

  /* Google Books answers a missing cover with a placeholder bitmap rather than
     a 404 — either "image not available" (PNG, 128×170) or a grey striped book
     (JPEG, 128×184). Both are fixed images, so at zoom=1 they are identifiable
     by size; every lookup is probed there before being upgraded to a larger
     rendering. A genuine cover of exactly those dimensions is rare and simply
     falls back to a generated one. */
  var GB_PLACEHOLDERS = { '128x170': 1, '128x184': 1 };

  function coverEl(row, large) {
    var wrap = document.createElement('div');
    wrap.className = 'cover';
    wrap.appendChild(fallbackCover(row));

    var sources = coverSources(row, large);
    if (!sources.length) return wrap;

    var img = document.createElement('img');
    img.decoding = 'async';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';

    var at = 0;
    var upgrading = false;

    function attempt() {
      if (at >= sources.length) {
        img.remove();
        return;
      }
      img.src = sources[at++];
    }

    function show() {
      img.classList.add('ready');
      var fb = wrap.querySelector('.cover-fallback');
      if (fb) fb.remove();
    }

    img.addEventListener('load', function () {
      if (upgrading) {
        show();
        return;
      }
      if (img.naturalWidth < 4 || GB_PLACEHOLDERS[img.naturalWidth + 'x' + img.naturalHeight]) {
        attempt();
        return;
      }
      show();
      // A real thumbnail means the book has a cover, so the detail view can
      // safely ask for the bigger rendering.
      if (large && row.isbn && img.src.indexOf('books.google.com') !== -1) {
        upgrading = true;
        img.src = googleCover(row.isbn, 2);
      }
    });
    img.addEventListener('error', function () {
      if (upgrading) return; // keep the thumbnail already on screen
      attempt();
    });

    wrap.appendChild(img);
    whenVisible(wrap, attempt);
    return wrap;
  }

  /* Deferred loading is done here rather than with loading="lazy": the native
     hint is unreliable for images that start out transparent or off-screen. */
  var coverQueue = null;
  var coverJobs = new WeakMap();

  function whenVisible(node, start) {
    if (!('IntersectionObserver' in window)) {
      start();
      return;
    }
    if (!coverQueue) {
      coverQueue = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            coverQueue.unobserve(entry.target);
            var job = coverJobs.get(entry.target);
            if (job) {
              coverJobs.delete(entry.target);
              job();
            }
          });
        },
        { rootMargin: '400px' }
      );
    }
    coverJobs.set(node, start);
    coverQueue.observe(node);
  }

  /* Covers are not in the source data; they are looked up by ISBN at render
     time, best source first, with a generated cover if nothing resolves. */
  function coverSources(row, large) {
    if (row.cover) return [row.cover];
    // When the build has already resolved covers, a record without one is
    // known not to have one. Probing again per visitor would mean two failed
    // requests for most of the catalogue, for nothing.
    if (manifest && manifest.coversResolvedAt) return [];
    if (!row.isbn) return [];
    return [
      googleCover(row.isbn, 1),
      'https://covers.openlibrary.org/b/isbn/' + row.isbn + (large ? '-L' : '-M') + '.jpg?default=false',
    ];
  }

  function googleCover(isbn, zoom) {
    return 'https://books.google.com/books/content?vid=ISBN' + isbn + '&printsec=frontcover&img=1&zoom=' + zoom;
  }

  /* A generated cover so every book still reads as a book. */
  function fallbackCover(row) {
    var div = document.createElement('div');
    div.className = 'cover-fallback';
    var hue = hash(row.id || row.title || '') % 360;
    div.style.background =
      'linear-gradient(150deg, hsl(' + hue + ' 42% 42%), hsl(' + ((hue + 38) % 360) + ' 38% 28%))';

    var t = document.createElement('div');
    t.className = 'ft';
    t.textContent = displayTitle(row) || '無題';
    var a = document.createElement('div');
    a.className = 'fa';
    a.textContent = (row.authors && row.authors[0]) || row.publisher || '';
    div.appendChild(t);
    div.appendChild(a);
    return div;
  }

  /* ---------------- render: facets ---------------- */

  function renderFacets(allCounts) {
    if (allCounts) renderFacets._counts = allCounts;
    var counts = renderFacets._counts || {};
    var open = {};
    el.facets.querySelectorAll('details').forEach(function (d) { open[d.dataset.key] = d.open; });
    var searches = {};
    el.facets.querySelectorAll('.facet-search').forEach(function (i) { searches[i.dataset.key] = i.value; });

    el.facets.innerHTML = '';
    var active = 0;

    FACETS.forEach(function (facet) {
      var options = counts[facet.key] || [];
      var selected = state.filters[facet.key] || new Set();
      active += selected.size;

      if (!options.length) return;
      if (facet.hideIfSingle && options.length < 2 && !selected.size) return;

      var details = document.createElement('details');
      details.className = 'facet';
      details.dataset.key = facet.key;
      // `collapsed` wins over having a selection: 語言 is ticked for everyone
      // on arrival, and opening it for that is noise. Whatever the reader
      // opens or closes themselves is remembered in `open` and takes
      // precedence over both.
      details.open =
        open[facet.key] !== undefined
          ? open[facet.key]
          : facet.collapsed
            ? false
            : selected.size > 0 || !!facet.open;

      var summary = document.createElement('summary');
      summary.textContent = facet.label;
      if (selected.size) {
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = String(selected.size);
        summary.appendChild(badge);
      }
      details.appendChild(summary);

      var body = document.createElement('div');
      body.className = 'facet-body';

      var limit = facet.limit || 999;
      var expanded = false;

      // Which 200 are shown is still decided by how many books each has — a
      // list of the rarest publishers would be useless. The order they are
      // shown in is another question, and facet.sort answers it.
      //
      // This used to be applied only on the JSON path, so 出版年份 asked for
      // newest-first and got most-books-first: 2024, 2025, 2026, 2023.
      var order = facetOrder(facet);
      if (order) options = options.slice().sort(order);

      // Only the options on show go into the DOM. `options` is the counted
      // list, capped at FACET_LIMIT, which is plenty to browse — but searching
      // it reached 200 of 38,053 publishers, so 天窗出版社有限公司 and its 181
      // records could not be found. When this facet has a published full list,
      // a search uses that instead and falls back to the capped one until it
      // arrives.
      function paintOptions() {
        var query = String(searches[facet.key] || '').trim().toLowerCase();
        var pool = options;
        if (query) {
          var full = fullFacetList(facet.key, paintOptions);
          if (full) pool = full;
        }
        var matches = query
          ? pool.filter(function (entry) {
              return displayName(facet, entry.value).toLowerCase().indexOf(query) !== -1;
            })
          : options;
        var cap = query || expanded ? 60 : limit;

        body.innerHTML = '';
        matches.slice(0, cap).forEach(function (entry) {
          body.appendChild(option(facet, entry, selected.has(entry.value)));
        });

        if (!matches.length) {
          var none = document.createElement('p');
          none.className = 'facet-empty';
          none.textContent = '沒有符合的項目';
          body.appendChild(none);
        } else if (matches.length > cap) {
          var rest = document.createElement('p');
          rest.className = 'facet-empty';
          rest.textContent = '另有 ' + fmt(matches.length - cap) + ' 項，請縮窄關鍵字';
          body.appendChild(rest);
        }
        if (more) more.hidden = !!query || expanded || options.length <= limit;
      }

      var more = null;

      if (facet.search) {
        var input = document.createElement('input');
        input.className = 'facet-search';
        input.type = 'search';
        input.dataset.key = facet.key;
        input.placeholder = '篩選' + facet.label + '…';
        input.value = searches[facet.key] || '';

        // Only the option list is repainted, never this input. Rebuilding the
        // sidebar on each keystroke destroyed the element an IME was composing
        // into, so 倉頡 or pinyin committed the raw Latin keys instead of the
        // character.
        input.addEventListener('input', function (e) {
          searches[facet.key] = input.value;
          if (e.isComposing) return; // mid-character: wait for the IME
          paintOptions();
        });
        input.addEventListener('compositionend', function () {
          searches[facet.key] = input.value;
          paintOptions();
        });

        details.appendChild(input); // body is appended after this, keeping order
      }

      details.appendChild(body);

      if (options.length > limit) {
        more = document.createElement('button');
        more.className = 'linkish facet-more';
        more.type = 'button';
        more.textContent = '顯示更多';
        more.addEventListener('click', function () {
          expanded = true;
          paintOptions();
        });
        details.appendChild(more);
      }

      paintOptions();

      el.facets.appendChild(details);
    });

    el.filtersCount.hidden = active === 0;
    el.filtersCount.textContent = String(active);
  }

  function option(facet, entry, checked) {
    var label = document.createElement('label');
    label.className = 'opt';

    var input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', function () {
      toggleFilter(facet.key, entry.value, input.checked);
    });

    var text = document.createElement('span');
    text.className = 'label';
    text.textContent = displayName(facet, entry.value);
    text.title = text.textContent;

    var n = document.createElement('span');
    n.className = 'n';
    // A search with more hits than FACET_SCAN_CAP counts its facets over the
    // first 600 of them, because counting all of them means fetching every
    // matching row. The number is then a sample, and saying so is cheaper and
    // more honest than either pretending or paying for the real figure.
    if (facetsAreSampled()) {
      n.textContent = '≈' + fmt(entry.count);
      n.title = '約數：此搜尋的篩選數字取自前 ' + fmt(facetScanCap()) + ' 筆結果';
    } else {
      n.textContent = fmt(entry.count);
    }

    label.appendChild(input);
    label.appendChild(text);
    label.appendChild(n);
    return label;
  }

  /**
   * Whether the facet numbers on screen are a sample rather than a count.
   *
   * True only for a text search that matched more than the scan cap: the facet
   * query materialises the first FACET_SCAN_CAP hits and counts those, so a
   * search for 香港 with 16,724 matches shows figures drawn from 600 of them.
   * Browsing is never sampled — those counts are precomputed over everything.
   */
  function facetsAreSampled() {
    // On the API backend any narrowed facet is counted over the first
    // facetScan matches, filters included — not only text searches. The old
    // test asked about state.q because on the file backend browsing really is
    // precomputed over everything, and on that backend it still is.
    if (source === ApiSource && ApiSource._scan) {
      return totalResults > ApiSource._scan && (!!matchExpression(state.q) || hasFilters());
    }
    return !!(state.q && matchExpression(state.q) && totalResults > FACET_SCAN_CAP);
  }

  /** Any facet filter active at all. */
  function hasFilters() {
    return Object.keys(state.filters).some(function (key) {
      var set = state.filters[key];
      return !!(set && set.size);
    });
  }

  /** The cap the backend in use actually counted facets over. */
  function facetScanCap() {
    return (source === ApiSource && ApiSource._scan) || FACET_SCAN_CAP;
  }

  /** The comparator a facet asked for, or null to leave it by count. */
  function facetOrder(facet) {
    if (facet.sort === 'stroke') return byStroke;
    if (facet.sort === 'key-desc') {
      return function (a, b) {
        var x = String(a.value);
        var y = String(b.value);
        return x === y ? 0 : x < y ? 1 : -1;
      };
    }
    return null;
  }

  /**
   * 部首筆畫 order, by comparing code points.
   *
   * True 筆畫 ordering needs a stroke count per character, which lives in
   * Unicode's Unihan database (kTotalStrokes) and is an 8 MB download this
   * project does not otherwise need. What code points give instead is very
   * close and free: the CJK Unified Ideographs block, U+4E00–U+9FA5, is
   * arranged by Kangxi radical and then by residual stroke count, so sorting
   * on them is the ordering a Chinese dictionary uses.
   *
   *   一 丁 七 三 上 下   radical 1
   *   人 今 代 以         radical 9
   *   天 太               radical 37
   *
   * Latin names sort before Chinese ones, since ASCII is below U+4E00.
   *
   * Comparing the strings directly rather than with localeCompare, because
   * localeCompare under zh-Hant may order by pinyin, by stroke, or by
   * whatever the platform decided, and differing between a reader's browsers
   * is worse than one predictable order.
   */
  var CJK_FIRST = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

  function byStroke(a, b) {
    var x = String(a.value);
    var y = String(b.value);
    // Chinese before Latin, as the catalogue's own title ordering does with
    // zh_first. Code points alone put every ASCII name first, and with eight
    // options on show that meant a reader saw Bo Yi, Cosmos and Crown and not
    // one Chinese publisher.
    var cx = CJK_FIRST.test(x) ? 0 : 1;
    var cy = CJK_FIRST.test(y) ? 0 : 1;
    if (cx !== cy) return cx - cy;
    if (x === y) return 0;
    return x < y ? -1 : 1;
  }

  function toggleFilter(key, value, on) {
    var set = state.filters[key] || new Set();
    if (on) set.add(value);
    else set.delete(value);
    if (set.size) state.filters[key] = set;
    else delete state.filters[key];
    state.page = 1;
    pushRoute();
    render();
  }

  /* Counts reflect the other facets' selections, so options stay meaningful. */
  function countFacet(facet) {
    var others = {};
    Object.keys(state.filters).forEach(function (key) {
      if (key !== facet.key) others[key] = state.filters[key];
    });

    var terms = searchTerms(state.q);
    var counts = new Map();

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!matches(row, others)) continue;
      if (terms.length) {
        var hay = row._hay;
        var ok = true;
        for (var t = 0; t < terms.length; t++) {
          if (hay.indexOf(terms[t]) === -1) { ok = false; break; }
        }
        if (!ok) continue;
      }
      var value = facet.get(row);
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }

    var list = [];
    counts.forEach(function (count, value) { list.push({ value: value, count: count }); });

    if (facet.sort === 'key-desc') list.sort(function (a, b) { return b.value.localeCompare(a.value); });
    else list.sort(function (a, b) { return b.count - a.count || String(a.value).localeCompare(String(b.value)); });

    return list;
  }

  /**
   * The complete value list for a facet with a search box, fetched once.
   *
   * Returns null while it is loading — the caller shows the capped list in the
   * meantime and is called back when the real one lands, so typing is never
   * blocked on a megabyte of publishers.
   */
  var facetLists = {};

  function fullFacetList(key, onReady) {
    if (!manifest.facetLists || !manifest.facetLists.counts[key]) return null;
    if (facetLists[key] && facetLists[key].ready) return facetLists[key].values;
    if (facetLists[key]) return null; // already in flight

    facetLists[key] = { ready: false, values: null };
    fetch(DATA + manifest.facetLists.dir + key + '.json')
      .then(function (res) {
        if (!res.ok) throw new Error(key + ' list: ' + res.status);
        return res.json();
      })
      .then(function (pairs) {
        facetLists[key] = {
          ready: true,
          values: pairs.map(function (p) { return { value: p[0], count: p[1] }; }),
        };
        if (onReady) onReady();
      })
      .catch(function () {
        // Leave it un-ready rather than marked failed: the capped list still
        // works, and a later keystroke can retry.
        delete facetLists[key];
      });
    return null;
  }

  function renderChips() {
    el.chips.innerHTML = '';
    var any = false;

    FACETS.forEach(function (facet) {
      var set = state.filters[facet.key];
      if (!set) return;
      set.forEach(function (value) {
        any = true;
        var chip = document.createElement('span');
        chip.className = 'chip';
        chip.appendChild(document.createTextNode(facet.label + ': ' + displayName(facet, value)));
        var close = document.createElement('button');
        close.type = 'button';
        close.setAttribute('aria-label', 'Remove filter');
        close.textContent = '×';
        close.addEventListener('click', function () { toggleFilter(facet.key, value, false); });
        chip.appendChild(close);
        el.chips.appendChild(chip);
      });
    });

    el.chips.hidden = !any;
  }

  /* ---------------- render: detail ---------------- */

  function renderDetail(id) {
    var token = ++renderToken;

    el.detail.innerHTML = '<div class="detail"><a class="backlink" href="' + backHref() + '">← 返回搜尋結果</a>' +
      '<div class="detail-head"><div class="cover skeleton"></div><div><div class="skeleton" style="height:30px;width:70%"></div>' +
      '<div class="skeleton" style="height:16px;width:40%;margin-top:12px"></div></div></div></div>';

    ensureSource().then(function () { return source.record(id); }).then(function (book) {
      if (token !== renderToken) return;
      if (!book) {
        el.detail.innerHTML =
          '<div class="detail"><a class="backlink" href="#/">← 返回全部書刊</a>' +
          '<h1>找不到此書刊</h1><p>已載入的資料集中沒有這個編號 <code>' +
          escapeHtml(id) +
          '</code>.</p></div>';
        return;
      }
      el.detail.innerHTML = detailHtml(book, book);
      var host = el.detail.querySelector('.detail-cover');
      if (host) host.replaceWith(bigCover(book, book));
      var ownHost = el.detail.querySelector('#detail-own');
      if (ownHost) {
        ownHost.replaceWith(
          ownButton(book.id, 'long', {
            id: book.id,
            title: book.title,
            parallelTitle: book.parallelTitle,
            price: book.price && typeof book.price.amount === 'number' ? book.price.amount : null,
            currency: book.price ? book.price.currency : 'HKD',
          })
        );
      }
      document.title = (displayTitle(book) || '書刊') + ' — 神保町';
      render3ook(book, token);
      renderSiblings(book, token);
    });
  }

  /**
   * Whether this book can be bought as an ebook on 3ook.com.
   *
   * The whole map is one static file, because it is small enough to be: of
   * 3ook's ~1,900 titles about two thirds carry an ISBN and about three
   * quarters of those are in this catalogue, so the answer for every book in
   * the catalogue fits in tens of kilobytes. Shipping it means a book page
   * asks 3ook nothing — no CORS arrangement to maintain, nothing to be slow
   * or down, and no record of what anyone reads here leaving this site.
   *
   * Loaded on the first book page rather than with the manifest, so a visitor
   * who only browses never fetches it at all. A failure is silent: the link
   * does not appear, which is the correct answer when we cannot tell.
   *
   * The edition is deliberately named 電子版 in the label. These records come
   * from print bibliographies, and a shared ISBN means an edition exists on
   * 3ook — not that it is the same object in the hand.
   *
   * The price comes from 3ook's own API, because a price cannot be shipped in
   * a build artefact and stay true. The map still decides whether to ask at
   * all: the ~944 books known to be listed cause one request, and the other
   * 445,000 book pages cause none. The link is drawn first and the price
   * added when it arrives, so a slow or missing answer costs a reader
   * nothing — they get the link without a figure, which is exactly what the
   * static file alone could offer.
   */
  var THREEOOK_API = 'https://api.like.co/likernft/book/store/search?isbn=';
  var threeookPromise = null;

  function threeookMap() {
    if (!threeookPromise) {
      threeookPromise = fetch(DATA + '3ook.json')
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; });
    }
    return threeookPromise;
  }

  function render3ook(book, token) {
    var host = el.detail.querySelector('#detail-3ook');
    if (!host) return;

    // .linkrow is a flex row with an 8px gap, so an empty placeholder is not
    // invisible — it is 8px of space between the buttons either side of it,
    // on the 99.8% of books that are not on 3ook. It goes away rather than
    // staying behind "just in case".
    var drop = function () {
      var h = el.detail.querySelector('#detail-3ook');
      if (h && h.parentNode) h.parentNode.removeChild(h);
    };

    if (!book.isbn) return drop();

    threeookMap()
      .then(function (map) {
        if (token !== renderToken) return;
        var addr = map && map.books ? map.books[book.isbn] : null;
        var host2 = el.detail.querySelector('#detail-3ook');
        if (!host2) return;
        if (!addr) return drop();
        var a = document.createElement('a');
        a.className = 'btn';
        a.href = (map.base || 'https://3ook.com/store/') + addr;
        a.target = '_blank';
        a.rel = 'noreferrer';
        a.textContent = '3ook.com 電子版 ↗';
        a.title = '在 3ook.com 購買此書的電子版';
        host2.replaceWith(a);
        threeookPrice(book.isbn, token, a);
      })
      .catch(drop);
  }

  /** Fills the live price into a link already on the page, or leaves it be. */
  function threeookPrice(isbn, token, a) {
    fetch(THREEOOK_API + encodeURIComponent(isbn))
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (d) {
        if (token !== renderToken || !a.parentNode) return;
        var b = d && d.list && d.list[0];
        if (!b) return;
        if (b.isSoldOut) {
          a.textContent = '3ook.com 電子版（已售罄） ↗';
          return;
        }
        // priceInDecimalByCurrency is in cents: hkd 7000 is HK$70. `price` is
        // the USD figure, which is not what this site quotes anywhere else.
        var p = (b.prices && b.prices[0]) || {};
        var cents = p.priceInDecimalByCurrency && p.priceInDecimalByCurrency.hkd;
        if (typeof cents !== 'number') return;
        a.textContent = '3ook.com 電子版 ' + money(cents / 100, 'HKD') + ' ↗';
      })
      .catch(function () {});
  }

  /**
   * The other records carrying this book's ISBN.
   *
   * This is where the datasets being held apart stops being a cost. Two
   * things end up here that the grid cannot show:
   *
   *   9780190481667   hkpl-2017  牛   · 吳煦斌   · 牛津大學出版社(中國)有限公司
   *                   ol-hk      Niu · Wu Xubin · Oxford University Press
   *
   * — one book catalogued twice, in two forms, neither of which can be
   * discarded without losing a name somebody searches by, so the grid keeps
   * both cards and this section connects them; and the records a card did
   * fold, which are reachable here rather than merged out of existence.
   *
   * It also shows what an ISBN is really worth as an identifier here: ask for
   * Halsbury's Laws of Hong Kong and 165 other records answer, because every
   * volume of a loose-leaf service shares the set's one number.
   *
   * Loaded after the page is painted, not with it. A book page should not wait
   * on this, and when the query fails the section simply does not appear.
   */
  function renderSiblings(book, token) {
    var host = el.detail.querySelector('#detail-siblings');
    if (!host || !book.isbn || !source.siblings) return;

    source
      .siblings(book.isbn, book.id)
      .then(function (list) {
        if (token !== renderToken || !list || !list.length) return;

        var out = [];
        out.push('<h2 class="section-title">相同 ISBN 的其他紀錄</h2>');
        out.push(
          '<p class="section-note">本目錄把各資料集並列保存，不作合併，因此同一本書可能有多筆紀錄；書名或會以不同方式著錄，' +
            '套書各冊亦往往共用一個 ISBN。瀏覽時，書名、副題及出版年份完全相同的紀錄會共用一張卡片，其餘各自顯示。</p>'
        );
        out.push('<ul class="siblings">');
        list.slice(0, 50).forEach(function (row) {
          var meta = [datasetName(row._ds), row.publisher, row.year ? String(row.year) : '']
            .filter(Boolean)
            .join(' · ');
          out.push(
            '<li><a href="#/book/' + escapeAttr(row.id) + '">' +
              escapeHtml(displayTitle(row) || '無題') +
              '</a>' +
              (row.subtitle ? ' <span class="siblings-sub">' + escapeHtml(row.subtitle) + '</span>' : '') +
              '<span class="siblings-meta">' + escapeHtml(meta) + '</span></li>'
          );
        });
        out.push('</ul>');
        if (list.length > 50) {
          out.push('<p class="section-note">共 ' + fmt(list.length) + ' 筆，以上為其中 50 筆。</p>');
        }
        host.innerHTML = out.join('');
      })
      .catch(function () {});
  }

  function fetchFull(row) {
    var ds = datasetById(row._ds);
    var file = ds && ds.files && ds.files.full ? ds.files.full[row._shard] : null;
    if (!file) return Promise.resolve(row);

    if (!fullShards.has(file)) {
      fullShards.set(
        file,
        fetch(DATA + file)
          .then(function (res) { return res.json(); })
          .catch(function () { return null; })
      );
    }
    return fullShards.get(file).then(function (list) {
      if (!list) return row;
      var book = list[row._off];
      return book && book.id === row.id ? book : list.find(function (b) { return b.id === row.id; }) || row;
    });
  }

  function detailHtml(book, row) {
    var ds = datasetById(book.dataset || row._ds) || {};
    var authors = (book.authors || []).map(function (a) {
      var name = a.display || a.name;
      return metaLinkHtml(name, authorHref(a), '搜尋著者：' + name);
    });

    var out = [];
    out.push('<div class="detail">');
    out.push('<a class="backlink" href="' + backHref() + '">← 返回搜尋結果</a>');
    out.push('<div class="detail-head"><div class="detail-cover"></div><div>');
    out.push('<h1>' + escapeHtml(displayTitle(book) || '無題') + '</h1>');
    var otherTitle = altTitle(book);
    if (otherTitle) out.push('<p class="sub">' + escapeHtml(otherTitle) + '</p>');
    if (book.subtitle) out.push('<p class="sub">' + escapeHtml(book.subtitle) + '</p>');
    if (authors.length) out.push('<p class="byline">' + authors.join(' · ') + '</p>');

    if (book.description && book.description.text) {
      out.push(
        '<p class="lede">' +
          escapeHtml(book.description.text) +
          (book.description.source === 'derived'
            ? '<span class="derived" title="由目錄各欄位組成——原始資料集沒有內容簡介">推算</span>'
            : '') +
          '</p>'
      );
    }

    out.push('<div class="linkrow"><span id="detail-own"></span>');
    out.push('<span id="detail-3ook"></span>');
    if (book.isbn) {
      out.push(link('https://openlibrary.org/isbn/' + book.isbn, 'Open Library'));
      out.push(link('https://www.google.com/search?q=' + encodeURIComponent('ISBN ' + book.isbn), '網上搜尋'));
    }
    out.push(catalogueLink(book));
    out.push('</div>');
    out.push('</div></div>');

    /* --- bibliographic --- */
    out.push('<h2 class="section-title">書目紀錄</h2>');
    out.push('<table class="meta-table"><tbody>');
    row2(out, '書刊名', book.title);
    row2(out, '副題', book.subtitle);
    row2(out, '並列書名', book.parallelTitle);
    row2(out, '完整書名著錄', book.titleFull);
    row2(out, '責任者說明', book.statementOfResponsibility);
    row2(
      out,
      '著者',
      (book.authors || [])
        .map(function (a) {
          var name = a.display || a.name;
          return metaLinkHtml(name, authorHref(a), '搜尋著者：' + name);
        })
        .join(' · '),
      true
    );
    row2(out, '版次', book.edition);
    row2(
      out,
      '叢書',
      book.series && book.series.title
        ? // No series facet exists, so this searches rather than filters.
          metaLinkHtml(book.series.title, searchHref(book.series.title), '搜尋叢書：' + book.series.title) +
          (book.series.number ? ' ; ' + escapeHtml(book.series.number) : '')
        : '',
      true
    );
    row2(out, '出版刊期', book.frequency);
    out.push('</tbody></table>');

    /* --- publication --- */
    out.push('<h2 class="section-title">出版資料</h2>');
    out.push('<table class="meta-table"><tbody>');
    row2(
      out,
      '出版者',
      book.publisher
        ? metaLinkHtml(book.publisher, '#/?publisher=' + encodeURIComponent(book.publisher), '瀏覽出版者：' + book.publisher)
        : '',
      true
    );
    row2(out, '出版地', book.place);
    row2(out, '出版年份', book.dateRaw || (book.year ? String(book.year) : ''));
    if (book.copyright) {
      row2(
        out,
        '版權',
        escapeHtml(book.copyright.statement) +
          (book.copyright.source === 'derived'
            ? '<span class="derived" title="出版者及出版年份；原始資料集沒有版權欄位">derived</span>'
            : ''),
        true
      );
    }
    row2(out, '目錄語言', languageName(book.language));
    out.push('</tbody></table>');

    /* --- identifiers --- */
    out.push('<h2 class="section-title">識別號及形態</h2>');
    out.push('<table class="meta-table"><tbody>');
    if (book.isbns && book.isbns.length) {
      var isbnHtml = book.isbns
        .map(function (entry) {
          return (
            '<code>' + escapeHtml(entry.value) + '</code>' +
            (entry.qualifier ? ' <span class="tag">' + escapeHtml(entry.qualifier) + '</span>' : '')
          );
        })
        .join('<br>');
      row2(out, '國際標準書號', isbnHtml, true);
      if (book.isbns[0] && book.isbns[0].isbn13) row2(out, 'ISBN-13（標準化）', '<code>' + book.isbns[0].isbn13 + '</code>', true);
    }
    row2(out, '國際標準期刊號', book.issn ? '<code>' + escapeHtml(book.issn) + '</code>' : '', true);
    row2(out, '著錄', book.physical ? book.physical.raw : '');
    row2(out, '頁數', book.physical && book.physical.pages ? book.physical.pages + ' 頁' : '');
    row2(out, '尺寸', book.physical ? book.physical.dimensions : '');
    row2(
      out,
      '類別',
      book.classification
        ? metaLinkHtml(
            book.classification,
            '#/?classification=' + encodeURIComponent(book.classification),
            '瀏覽類別：' + book.classification
          )
        : '',
      true
    );
    row2(out, '附註', book.notes);
    if (book.price) {
      var price =
        typeof book.price.amount === 'number'
          ? money(book.price.amount, book.price.currency)
          : escapeHtml(book.price.raw || '');
      row2(out, '定價', price + (book.price.availability ? ' <span class="tag">' + escapeHtml(book.price.availability) + '</span>' : ''), true);
    }
    if (book.extra) {
      Object.keys(book.extra).forEach(function (key) { row2(out, titleCase(key), book.extra[key]); });
    }
    out.push('</tbody></table>');

    /* --- provenance --- */
    out.push('<h2 class="section-title">紀錄來源</h2>');
    out.push('<table class="meta-table"><tbody>');
    row2(out, '資料集', '<a href="#/about">' + escapeHtml(ds.title || book.dataset || '') + '</a>', true);
    row2(out, '參考編號', book.ref);
    row2(out, '順序編號', book.serial);
    if (book.source) {
      row2(out, '發佈期間', book.source.label || book.source.quarter || book.source.period);
      if (book.source.url) row2(out, '來源檔案', '<a href="' + escapeAttr(book.source.url) + '" rel="noreferrer">' + escapeHtml(fileName(book.source.url)) + '</a>', true);
      if (book.source.file) row2(out, 'Source file', '<code>' + escapeHtml(book.source.file) + '</code>', true);
    }
    row2(out, '紀錄編號', '<code>' + escapeHtml(book.id) + '</code>', true);
    out.push('</tbody></table>');

    /* --- other records of the same book, filled in by renderSiblings() --- */
    out.push('<div id="detail-siblings"></div>');
    out.push('</div>');

    return out.join('');
  }

  function bigCover(book) {
    return coverEl(
      {
        id: book.id,
        title: book.title,
        authors: (book.authors || []).map(function (a) { return a.display || a.name; }),
        publisher: book.publisher,
        isbn: book.isbn,
        cover: book.cover ? book.cover.url : '',
      },
      true
    );
  }

  function row2(out, label, value, isHtml) {
    if (value === undefined || value === null || value === '') return;
    out.push('<tr><th>' + escapeHtml(label) + '</th><td>' + (isHtml ? value : escapeHtml(String(value))) + '</td></tr>');
  }

  /* ---------------- render: bookshelf ---------------- */

  /**
   * Renders either the reader's own shelf, or one someone sent them — the
   * shared case is read-only and carries its books in the URL, because there
   * is no server holding profiles.
   */
  function renderShelf() {
    var params = new URLSearchParams((location.hash.split('?')[1] || ''));
    var shared = params.get('s');
    var decoded = shared ? decodeShelf(shared) : null;
    var ids = shared ? decoded.ids : Shelf.ids();
    var sharedPrices = shared ? decoded.prices : null;
    var mine = !shared;

    var out = [];
    out.push('<div class="shelf">');
    out.push('<a class="backlink" href="#/">← 返回全部書刊</a>');
    out.push('<h1>' + (mine ? '我的書架' : '分享的書架') + '</h1>');

    if (!ids.length) {
      out.push(
        mine
          ? '<p class="shelf-empty">書架還是空的。在任何書刊上按「＋ 我有」，就會收進這裡。</p>'
          : '<p class="shelf-empty">這個分享連結沒有包含任何書刊。</p>'
      );
      out.push('</div>');
      el.shelf.innerHTML = out.join('');
      document.title = (mine ? '我的書架' : '分享的書架') + ' — 神保町';
      return;
    }

    var priced = mine ? ids.filter(function (id) { return Shelf.price(id) !== null; }).length : sharedPrices ? Object.keys(sharedPrices).length : 0;
    var total = mine ? Shelf.total() : Object.keys(sharedPrices || {}).reduce(function (n, k) { return n + (sharedPrices[k] || 0); }, 0);
    out.push(
      '<p class="shelf-count">共 <strong>' + fmt(ids.length) + '</strong> 本' +
        (priced ? ' · 已標價 <strong>' + fmt(priced) + '</strong> 本，合計 <strong>' + money(total, 'HKD') + '</strong>' : '') +
        '</p>'
    );
    if (mine) {
      out.push(
        '<div class="shelf-actions">' +
          '<button class="btn" id="shelf-share">分享書架</button>' +
          '<button class="btn" id="shelf-export">匯出 JSON</button>' +
          '<label class="btn" for="shelf-import">匯入 JSON<input id="shelf-import" type="file" accept="application/json" hidden></label>' +
          '</div>' +
          '<p class="shelf-note">書架儲存在這部裝置的瀏覽器中，並未上載。清除瀏覽資料會一併清除書架，建議匯出備份。</p>'
      );
    } else {
      out.push('<p class="shelf-note">這是別人分享的書架，內容來自連結本身。</p>');
    }
    out.push('<div class="grid" id="shelf-grid"></div>');
    out.push('</div>');
    el.shelf.innerHTML = out.join('');
    document.title = (mine ? '我的書架' : '分享的書架') + ' — 神保町';

    var grid = document.getElementById('shelf-grid');
    grid.className = 'grid' + (state.view === 'list' ? ' list' : '');
    ensureSource().then(function () { return source.byIds(ids); }).then(function (rows) {
      if (!rows.length) {
        grid.outerHTML = '<p class="shelf-empty">找不到這些書刊，可能來自尚未載入的資料集。</p>';
        return;
      }
      var frag = document.createDocumentFragment();
      rows.forEach(function (row) {
        var el2 = card(row, []);
        el2.appendChild(priceTag(row, mine, sharedPrices));
        frag.appendChild(el2);
      });
      grid.appendChild(frag);
    });

    if (mine) wireShelfActions(ids);
  }

  /** The asking price under a book on the shelf — editable when it is yours. */
  function priceTag(row, mine, sharedPrices) {
    var price = mine ? Shelf.price(row.id) : sharedPrices && typeof sharedPrices[row.id] === 'number' ? sharedPrices[row.id] : null;
    var wrap = document.createElement('div');
    wrap.className = 'price-tag';

    var label = document.createElement('span');
    label.className = 'price-value' + (price === null ? ' unpriced' : '');
    label.textContent = price === null ? '未定價' : money(price, 'HKD');
    wrap.appendChild(label);

    if (!mine) return wrap;

    var edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'price-edit';
    edit.textContent = '改價';
    edit.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      askPrice({
        title: displayTitle(row),
        original: row.price,
        currency: row.currency,
        current: price,
        editing: true,
      }).then(function (next) {
        if (next === undefined) return;
        Shelf.setPrice(row.id, next);
        renderShelf();
      });
    });
    wrap.appendChild(edit);
    return wrap;
  }

  function wireShelfActions(ids) {
    var share = document.getElementById('shelf-share');
    share.addEventListener('click', function () {
      var url = location.origin + location.pathname + '#/shelf?s=' + encodeShelf(ids);
      copyText(url).then(function (ok) {
        share.textContent = ok ? '已複製連結 ✓' : '請手動複製';
        if (!ok) window.prompt('複製這個連結來分享書架：', url);
        setTimeout(function () { share.textContent = '分享書架'; }, 2500);
      });
    });

    document.getElementById('shelf-export').addEventListener('click', function () {
      var blob = new Blob(
        [
          JSON.stringify(
            {
              version: 2,
              owned: ids.map(function (id) { return { id: id, price: Shelf.price(id) }; }),
            },
            null,
            2
          ),
        ],
        { type: 'application/json' }
      );
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'my-bookshelf.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });

    document.getElementById('shelf-import').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(String(reader.result));
          var incoming = Array.isArray(data) ? data : data.owned;
          if (!Array.isArray(incoming)) throw new Error('格式不符');
          // Merge rather than replace: an import should not silently drop books.
          incoming.forEach(function (entry) {
            if (typeof entry === 'string') { if (!Shelf.has(entry)) Shelf.add(entry, null); }
            else if (entry && entry.id && !Shelf.has(entry.id)) Shelf.add(entry.id, entry.price);
          });
          renderShelf();
        } catch (err) {
          alert('無法匯入：' + err.message);
        }
      };
      reader.readAsText(file);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    return Promise.resolve(false);
  }

  /* ---------------- render: about ---------------- */

  function renderAbout() {
    var out = [];
    out.push('<div class="about">');
    out.push('<a class="backlink" href="' + backHref() + '">← 返回搜尋結果</a>');
    out.push('<h1>關於本站</h1>');
    out.push(
      // manifest, not rows.length: rows is the in-memory JSON array, which is
      // empty whenever the catalogue is large enough to use the SQLite
      // backend — which is always, at 446,090. This read「收錄 0 項書刊」on
      // the live site.
      '<p><strong>神保町</strong>（jimbocho.app）是一個靜態書刊資料目錄，收錄 ' +
        fmt(manifest.totalBooks || rows.length) +
        ' 項書刊，全部瀏覽與搜尋均在瀏覽器內完成。資料由一個小型 Node 程式從公開資料集匯入。</p>'
    );

    if (dbFallbackReason) {
      out.push(
        '<p class="lede">本站備有供大型目錄使用的 SQLite 資料庫，但在此無法使用：' +
          escapeHtml(dbFallbackReason) +
          '。現改用同一批紀錄的 JSON 版本，所見資料同樣正確。</p>'
      );
    }

    // The same line the footer carries, repeated here because the footer is
    // unreachable on the browse view: the result list loads more as you scroll
    // and there are 446,090 records, so scrolling to the bottom never ends.
    // This page is finite, and it is where someone looks when something is
    // wrong.
    out.push('<h2>版本</h2>');
    out.push('<p class="buildblock"><code id="about-build">…</code></p>');
    out.push('<p class="muted">最近的資料庫查詢及耗時（供回報問題用）：</p>');
    out.push('<pre class="timings" id="about-timings">—</pre>');
    out.push(
      '<p class="muted">上方第一段為資料庫檔名（含內容雜湊）、製作日期、' +
        '實際使用的後端（<code>sqlite</code> 或 <code>json shards</code>），' +
        '以及 Service Worker 的快取名稱。回報問題時請一併附上。</p>'
    );

    out.push('<h2>資料集</h2>');
    manifest.datasets.forEach(function (ds) {
      out.push('<div class="dscard">');
      out.push('<h3>' + escapeHtml(ds.title) + '</h3>');
      if (ds.description) out.push('<p>' + escapeHtml(ds.description) + '</p>');
      out.push('<ul class="stats">');
      out.push('<li><strong>' + fmt(ds.count) + '</strong>項書刊</li>');
      if (ds.stats) {
        out.push('<li><strong>' + fmt(ds.stats.withIsbn) + '</strong>設有 ISBN</li>');
        out.push('<li><strong>' + fmt(ds.stats.publishers) + '</strong>個出版者</li>');
        out.push('<li><strong>' + fmt(ds.stats.classifications) + '</strong>個類別</li>');
        if (ds.stats.yearRange) out.push('<li><strong>' + ds.stats.yearRange[0] + '–' + ds.stats.yearRange[1] + '</strong>出版年份跨度</li>');
      }
      out.push('</ul>');
      out.push('<p style="margin-top:14px">');
      if (ds.provider) out.push('資料提供：' + escapeHtml(ds.provider) + '<br>');
      if (ds.homepage) out.push('<a href="' + escapeAttr(ds.homepage) + '" rel="noreferrer">資料集首頁</a> · ');
      if (ds.dataDictionary) out.push('<a href="' + escapeAttr(ds.dataDictionary) + '" rel="noreferrer">資料字典</a> · ');
      if (ds.licenseUrl) out.push('<a href="' + escapeAttr(ds.licenseUrl) + '" rel="noreferrer">' + escapeHtml(ds.license || '使用條款') + '</a>');
      else if (ds.license) out.push(escapeHtml(ds.license));
      out.push('</p>');
      out.push('<p style="font-size:12.5px">匯入日期 ' + escapeHtml(String(ds.importedAt || '').slice(0, 10)) + ' · ' + ds.sources.length + ' 個來源檔案 · 轉換器 <code>' + escapeHtml(ds.adapter) + '</code></p>');
      out.push('</div>');
    });

    out.push('<h2>加入其他資料集</h2>');
    out.push('<p>資料集在 <code>datasets.json</code> 中宣告，並以下列指令匯入：</p>');
    out.push(
      '<pre>npm run import                        # 匯入全部已登記資料集\n' +
        'npm run import -- --add-hkpl-year 2026  # 下一年香港目錄\n' +
        'npm run import -- --file books.csv --id my-shelf --title "My shelf"\n' +
        'npm run import -- --url https://host/books.json --id x --title "X"</pre>'
    );
    out.push(
      '<p>CSV 與 JSON 來源會按欄位名稱自動對應（書名、著者、出版者、ISBN、簡介、封面…），因此大部分匯出檔無需設定即可匯入。每次匯入會在 <code>site/data/</code> 寫入精簡的瀏覽分片及完整紀錄分片，並更新 manifest。</p>'
    );

    out.push('<h2>資料如何整理</h2>');
    out.push(
      '<p>目錄紀錄採用 ISBD 標點，因此<em>「正書名 : 副題 = 並列書名 / 責任者說明」</em>會拆分為獨立欄位。ISBN、定價、頁數與尺寸皆從自由文本中解析。兩個欄位標示為<span class="derived">推算</span>：內容簡介由目錄欄位組成（原始資料沒有簡介），版權一行則為出版者加出版年份。</p><p>目錄分中英文兩冊出版，不少英文紀錄以並列書名記載中文書名。本站以中文書名為主，另一語言的書名顯示於其下。</p>'
    );

    out.push('<h2>重複紀錄</h2>');
    out.push(
      '<label class="switch"><input type="checkbox" id="grouping-toggle"' + (grouping ? ' checked' : '') + '> 相同的書目共用一張卡片</label>'
    );
    // Counted by the build with the same function the grid folds with, so a
    // rebuild cannot leave this paragraph quoting last month's catalogue.
    var dup = manifest.duplicates;
    out.push(
      '<p style="margin-top:8px">本目錄把各資料集並列保存而不作合併：一本書向書號中心登記、由國家圖書館編目、再由大學圖書館收藏，三筆紀錄都是真的，而刪去任何一筆都會失去一個來源。' +
        '代價是同一本書會出現多次' +
        (dup && dup.records
          ? '——全目錄 ' + fmt(manifest.totalBooks || 0) + ' 筆紀錄中，有 ' + fmt(dup.records) +
            ' 筆的 ISBN、書名、副題及出版年份完全相同，分屬 ' + fmt(dup.books) + ' 本書'
          : '') +
        '。瀏覽時這些紀錄共用一張卡片，卡片上註明「另有 N 筆相同書目」，書頁則列出全部紀錄。</p>'
    );
    out.push(
      '<p>只在四項全部相同時才合併。套書各冊共用一個 ISBN（《民間私藏臺灣宗教資料彙編》34 冊同一書號，冊次寫在副題），' +
        '而同一個 ISBN 也可能有不同的書名著錄（<em>牛／Niu</em>、<em>吳煦斌／Wu Xubin</em>），兩者都有人搜尋。' +
        '這些紀錄一概各自顯示，不作取捨。關閉此選項後，每筆紀錄各佔一張卡片。</p>'
    );

    out.push('<h2>封面圖片</h2>');
    out.push(
      '<p>原始資料集並不包含封面。封面已於製作資料時逐一以 ISBN 向 Google Books 查證' +
        (manifest.coversFound ? '，當中 ' + fmt(manifest.coversFound) + ' 項找到封面' : '') +
        '，其餘自動生成，瀏覽時不會再逐本查詢。香港出版的書刊大多未被掃描收錄：本目錄以上市公司年報、教科書及政府刊物為主，Open Library 幾乎沒有香港 ISBN，而有收錄的網上書店則拒絕程式存取。</p>'
    );
    out.push('</div>');

    el.about.innerHTML = out.join('');
    renderBuildId(); // the node above only exists once this is in the DOM
    var t = document.getElementById('about-timings');
    if (t) t.textContent = timingSummary();
    var group = document.getElementById('grouping-toggle');
    group.addEventListener('change', function () {
      grouping = group.checked;
      localStorage.setItem('grouping', grouping ? 'on' : 'off');
      // route() re-renders the grid on the way back to it, which resets this
      // anyway; dropped here so nothing can fold against the old setting in
      // between.
      shown = new Map();
      renderAbout();
    });
    document.title = '資料說明 — 神保町';
  }

  /* ---------------- helpers ---------------- */

  function updateChrome() {
    var names = manifest.datasets.map(function (d) { return d.shortTitle || d.title; }).join(', ');
    el.footer.innerHTML =
      escapeHtml(names) +
      ' · ' +
      fmt(manifest.totalBooks || 0) +
      ' 項紀錄 · 製作於 ' +
      escapeHtml(String(manifest.generatedAt || '').slice(0, 10)) +
      ' · <a href="#/about">資料說明及新增資料集方法</a>' +
      '<span class="build" id="build-id"></span>';

    renderBuildId();
  }

  /**
   * Which build this page is actually running.
   *
   * Not vanity — a diagnostic. The site is three things deployed separately:
   * the page, the manifest, and a 467 MiB database in R2 whose object name
   * carries its content hash. A service worker sits in front of all of it. So
   * "I deployed a fix and it is still broken" has several possible meanings,
   * and they are indistinguishable from the outside: a stale page, a stale
   * manifest pointing at the previous database, or a fix that simply did not
   * work.
   *
   * This says which database the page is querying, and which service worker
   * cache is answering for it. If the object name here does not match the one
   * the build printed, a reload is the whole problem.
   */
  function renderBuildId() {
    // Both places, because the footer cannot be reached while browsing.
    var nodes = [document.getElementById('build-id'), document.getElementById('about-build')]
      .filter(Boolean);
    if (!nodes.length) return;
    var node = {
      set textContent(v) { nodes.forEach(function (n) { n.textContent = v; }); },
      set title(v) { nodes.forEach(function (n) { n.title = v; }); },
    };

    var file = manifest.db && manifest.db.url ? manifest.db.url.split('/').pop() : '';
    // Production names carry the content hash — books-4f71445f.db — and the
    // hash alone is the useful part. A local build is plain books.db, which
    // has nothing to shorten, so it is shown whole rather than mangled into
    // the word "books".
    var hashed = /^books-([0-9a-f]{6,})\.db$/.exec(file);
    var object = hashed ? hashed[1] : file;
    var built = String((manifest.db && manifest.db.builtAt) || manifest.generatedAt || '').slice(0, 10);

    // Which backend is actually answering. This is the important one: when the
    // SQLite database cannot be used the app falls back to loading every index
    // shard — 109 files, 90 MB — and says so only on the About page. From the
    // outside that is indistinguishable from a slow database, and it is the
    // difference between a filter taking half a second and taking minutes.
    var backend = !sourcePrepared
      ? '…'
      : source === JsonSource ? 'json shards' : source === ApiSource ? 'api' : 'sqlite';

    var parts = [];
    if (object) parts.push('db ' + object);
    if (built) parts.push(built);
    parts.push(backend);

    function paint(worker) {
      node.textContent = parts.concat(worker ? ['sw ' + worker] : []).join(' · ');
      node.title =
        'Database object: ' + (file || '(none — reading the JSON shards)') +
        '\nBuilt: ' + built +
        '\nBackend: ' + backend +
        (dbFallbackReason ? ' — ' + dbFallbackReason : '') +
        '\nService worker: ' + (worker || 'not controlling this page') +
        '\n\nIf these look old, reload. The worker name matches the database hash.' +
        '\n"json shards" means the database could not be used and everything is' +
        '\nbeing read from 90 MB of JSON instead, which is very much slower.';
    }

    paint('');
    // The cache name is stamped with the database hash at build time, so the
    // two agreeing is proof the page, the manifest and the worker are one
    // build.
    if (navigator.serviceWorker && navigator.serviceWorker.controller && window.caches) {
      caches.keys().then(function (keys) {
        var mine = keys.filter(function (k) { return k.indexOf('jimbocho-') === 0; })[0] || '';
        paint(mine.replace('jimbocho-', ''));
      }).catch(function () {});
    }
  }

  function datasetById(id) {
    return manifest.datasets.filter(function (d) { return d.id === id; })[0];
  }

  function datasetName(id) {
    var ds = datasetById(id);
    return ds ? ds.shortTitle || ds.title : id;
  }

  function sourceName(value) {
    var parts = String(value).split('#');
    var ds = datasetById(parts[0]);
    var source = ds && ds.sources ? ds.sources[Number(parts[1])] : null;
    return source ? source.label || source.quarter || parts[1] : value;
  }

  // The Hong Kong catalogue is Chinese and English only; the Taiwan feed adds
  // the language a translation was written in, so the facet is no longer a
  // two-value one.
  var LANGUAGE_NAMES = {
    zh: '中文',
    en: '英文',
    ja: '日文',
    ko: '韓文',
    fr: '法文',
    de: '德文',
    es: '西班牙文',
    vi: '越南文',
    th: '泰文',
    id: '印尼文',
  };

  /**
   * The library catalogue worth searching depends on where the book was
   * registered: a Taiwanese ISBN application is not in Hong Kong's public
   * library, and sending a reader there finds nothing.
   */
  function catalogueLink(book) {
    // A grid row carries the dataset as `_ds`; a full record, which is what
    // the detail view has, carries it as `dataset`.
    var dataset = datasetOf(book.dataset || book._ds);
    var region = dataset && dataset.region;
    if (region === 'Taiwan' || /臺灣|台灣/.test(String(region || ''))) {
      return link(
        'https://isbn.ncl.edu.tw/NEW_ISBNNet/main_DisplayBookList.php?Pfile=&FM=1&Ptype=001&searchtext=' +
          encodeURIComponent(book.title || ''),
        '全國新書資訊網'
      );
    }
    return link(
      'https://www.hkpl.gov.hk/en/search?q=' + encodeURIComponent(book.title || ''),
      '香港公共圖書館'
    );
  }

  function datasetOf(id) {
    if (!manifest || !manifest.datasets) return null;
    for (var i = 0; i < manifest.datasets.length; i++) {
      if (manifest.datasets[i].id === id) return manifest.datasets[i];
    }
    return null;
  }

  function languageName(code) {
    return LANGUAGE_NAMES[code] || code || '';
  }

  function displayName(facet, value) {
    return facet.name ? facet.name(value) : value;
  }

  function backHref() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.sort !== 'relevance') params.set('sort', state.sort);
    Object.keys(state.filters).forEach(function (key) {
      var set = state.filters[key];
      if (set && set.size) params.set(key, [...set].join('|'));
    });
    var qs = params.toString();
    return '#/' + (qs ? '?' + qs : '');
  }

  function searchHref(term) {
    return '#/?q=' + encodeURIComponent(term);
  }

  function link(href, text) {
    return '<a class="btn" href="' + escapeAttr(href) + '" target="_blank" rel="noreferrer">' + escapeHtml(text) + ' ↗</a>';
  }

  function money(amount, currency) {
    try {
      return new Intl.NumberFormat('en-HK', { style: 'currency', currency: currency || 'HKD' }).format(amount);
    } catch (err) {
      return (currency || '') + ' ' + amount;
    }
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  function fileName(url) {
    return String(url).split('/').pop();
  }

  function titleCase(text) {
    return String(text).charAt(0).toUpperCase() + String(text).slice(1);
  }

  function highlight(text, terms) {
    var safe = escapeHtml(text);
    if (!terms || !terms.length) return safe;
    terms.forEach(function (term) {
      if (term.length < 1) return;
      var re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      safe = safe.replace(re, '<mark>$1</mark>');
    });
    return safe;
  }

  function escapeHtml(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(text) {
    return escapeHtml(text).replace(/'/g, '&#39;');
  }

  function hash(text) {
    var h = 0;
    for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return h;
  }

  /**
   * The result count belongs beside 篩選 on a narrow screen and beside the
   * sort control on a wide one. It is moved rather than duplicated, so
   * there is only ever one element to write the number into — `el.count`
   * keeps pointing at the same node wherever it lands.
   */
  function initCountPlacement() {
    var head = document.getElementById('browse-head');
    var toolbar = document.querySelector('.toolbar');
    if (!head || !toolbar || !el.count || !window.matchMedia) return;
    var narrow = window.matchMedia('(max-width: 900px)');

    function place() {
      if (narrow.matches) {
        if (el.count.parentNode !== head) head.appendChild(el.count);
      } else if (el.count.parentNode !== toolbar) {
        toolbar.insertBefore(el.count, toolbar.firstChild);
      }
    }
    place();
    if (narrow.addEventListener) narrow.addEventListener('change', place);
    else if (narrow.addListener) narrow.addListener(place);
  }

  /**
   * The ☰ takes a bite out of the search box on a narrow screen, which left
   * the full placeholder cut off mid-word. Shorter wording there instead.
   */
  function initSearchPlaceholder() {
    if (!el.q || !window.matchMedia) return;
    var narrow = window.matchMedia('(max-width: 900px)');
    var long = el.q.getAttribute('placeholder');
    var short = '搜尋書名、著者、ISBN…';

    function apply() {
      el.q.setAttribute('placeholder', narrow.matches ? short : long);
    }
    apply();
    if (narrow.addEventListener) narrow.addEventListener('change', apply);
    else if (narrow.addListener) narrow.addListener(apply);
  }

  /**
   * The narrow-screen ☰. The panel is the same markup the wide layout shows
   * inline, so there is nothing to open or close above 900px — the toggle is
   * simply not displayed there, and a stray `open` class would do nothing.
   */
  function initMenu() {
    var toggle = document.getElementById('menu-toggle');
    var panel = document.getElementById('menu-panel');
    if (!toggle || !panel) return;

    function setOpen(open) {
      panel.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!panel.classList.contains('open'));
    });

    // Anything chosen inside closes it — the theme toggle included, since
    // leaving the menu hanging over the page after a tap feels broken.
    panel.addEventListener('click', function (e) {
      if (e.target.closest('a, button')) setOpen(false);
    });

    document.addEventListener('click', function (e) {
      if (!panel.contains(e.target) && e.target !== toggle) setOpen(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('open')) {
        setOpen(false);
        toggle.focus();
      }
    });

    // Any route change at all, including the back button — the panel should
    // never be left hanging over a view the reader has already moved on from.
    window.addEventListener('hashchange', function () {
      setOpen(false);
    });
  }

  function prefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyTheme(theme) {
    if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
    syncThemeColor(theme);
  }

  /**
   * Keep the status-bar / title-bar colour matched to the top bar. It matters
   * once the app is installed, where that strip is part of the window rather
   * than part of the browser.
   *
   * Two media-scoped <meta theme-color> tags cover the system-driven case with
   * no script at all. A browser uses the first one whose media matches, so the
   * only way to express "the visitor overrode the system" is to give both tags
   * the same colour; clearing the override puts each back to its own.
   */
  var THEME_COLOR = { light: '#ffffff', dark: '#1e1e18' };

  function syncThemeColor(theme) {
    var light = document.getElementById('tc-light');
    var dark = document.getElementById('tc-dark');
    if (!light || !dark) return;
    var forced = theme === 'dark' || theme === 'light' ? THEME_COLOR[theme] : null;
    light.setAttribute('content', forced || THEME_COLOR.light);
    dark.setAttribute('content', forced || THEME_COLOR.dark);
  }

  function setViewButtons() {
    document.querySelectorAll('.viewtoggle button').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.view === state.view);
    });
  }

  function showSkeleton() {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 18; i++) {
      var card = document.createElement('div');
      card.className = 'card';
      var cover = document.createElement('div');
      cover.className = 'cover skeleton';
      var line = document.createElement('div');
      line.className = 'skeleton';
      line.style.height = '13px';
      card.appendChild(cover);
      card.appendChild(line);
      frag.appendChild(card);
    }
    el.grid.appendChild(frag);
  }
  // Started here, not above: the objects init() touches are assigned as it
  // reads down the file, so calling earlier finds them undefined.
  init();
})();
