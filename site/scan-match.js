
/**
 * Turning what was read off a spine into books from the catalogue.
 *
 * The thing to understand here is that the recogniser does not have to be
 * right. A photographed spine is vertical text in a display face, 30 pixels
 * wide, at whatever angle the shelf was shot from, and no OCR engine small
 * enough to send to a phone reads that cleanly. What comes back is a handful
 * of correct characters in a mess of wrong ones.
 *
 * That is enough, because the catalogue is doing the recognising. 448,000
 * records indexed as overlapping bigrams means two adjacent correct
 * characters already cut the field to a few hundred, and four cut it to one.
 * So the query is not the OCR's guess at the title — it is every bigram the
 * OCR produced, ORed together, and the ranking afterwards asks which
 * candidate shares the longest unbroken run of characters with what was
 * read. A run of four is almost always the book; a run of two is a guess
 * worth showing but not worth trusting.
 *
 * This is also why the same code path serves a reader who types. Two
 * characters they can see on the spine go through exactly the same funnel as
 * two characters the engine guessed, which is what makes the manual fallback
 * fast rather than a punishment.
 */

/**
 * The bigrams and words to ask the index for.
 *
 * Ordered by the length of the run they came from, longest first, because a
 * spine's longest unbroken run of Chinese is nearly always its title and the
 * short fragments are the publisher's logotype, a series name, or noise. The
 * cap matters: each term in an FTS5 OR is its own postings list to walk, and
 * 漫 and 書 appear in tens of thousands of records, so an uncapped query from
 * a long strip is a slow query against someone else's read budget.
 *
 * @returns {string[]} lowercased, deduplicated, most promising first
 */
function scanTokens(text, cap) {
  var limit = cap === undefined ? 12 : cap;
  var segments = segmentsOf(text);

  // Longest run first, and within a run left to right.
  segments.sort(function (a, b) { return b.text.length - a.text.length; });

  var out = [];
  var seen = {};
  for (var i = 0; i < segments.length && out.length < limit; i++) {
    var seg = segments[i];
    var terms = seg.cjk ? bigrams(seg.text) : [seg.text];
    for (var j = 0; j < terms.length && out.length < limit; j++) {
      var term = terms[j];
      if (!term || seen[term]) continue;
      // A single Latin character matches most of the catalogue and tells us
      // nothing; a single CJK character would have to be a prefix search,
      // which an OR of prefix searches makes ruinous.
      if (!seg.cjk && term.length < 2) continue;
      seen[term] = true;
      out.push(term);
    }
  }
  return out;
}

/**
 * The candidate queries, narrowest window first — and a record of why the
 * app does not walk them.
 *
 * The idea was that a flat OR of every bigram is too loose: the five bigrams
 * of 寂天文化事業 ORed together match 20,000 records, because 文化 alone is
 * in thousands, so the right book is ranked somewhere inside twenty thousand
 * and may never reach the page. ANDing the bigrams *within* a sliding window
 * and ORing the windows is far more selective — a record then has to share
 * four consecutive characters, and the same text matches 266 instead of
 * 20,000. That part is true and measured.
 *
 * What is not true is that it helps. tools/scan-accuracy.js runs 150 real
 * titles through both, corrupted the way an engine corrupts them, and the
 * flat OR is better at every level of corruption and costs one request
 * instead of up to three:
 *
 *   a third of characters wrong     top 1    in the shown 8   missed
 *   narrow window first, then wider   43%           67%          26%
 *   one flat OR of every bigram       45%           75%          18%
 *
 * The 20,000 matches were real and the inference from them was wrong. bm25
 * already ranks a loose OR sensibly, rankCandidates re-sorts the rows that
 * come back, and a narrow window buys selectivity by sometimes excluding the
 * right book — which is the one error that cannot be recovered from, because
 * the reader never sees it to correct it. Being shown the book matters more
 * than being shown few books.
 *
 * So the app calls scanExpression, which is the last of these tiers. The
 * tiers stay because they are what the harness compares against, and because
 * the conclusion is a measurement rather than a law: it depends on how big
 * the catalogue is and how common its bigrams are, and both will change.
 *
 * The clause cap is measured too. Accuracy climbs to ten bigrams and stops:
 * fourteen scans 27% more matches for nothing.
 *
 * @returns {{ window: number, expr: string }[]} widest window first
 */
function scanQueries(text, options) {
  var opts = options || {};
  var maxClauses = opts.maxClauses === undefined ? 10 : opts.maxClauses;
  var segments = segmentsOf(text);

  // Longest run first: a spine’s longest unbroken run of Chinese is nearly
  // always its title, and when the clause budget runs out it should be the
  // short fragments — a logotype, a series name, noise — that are dropped.
  segments.sort(function (a, b) { return b.text.length - a.text.length; });

  var latin = [];
  segments.forEach(function (seg) {
    // A Latin word of three characters or fewer is "the", "and", a volume
    // number: it would widen every tier and narrow none.
    if (!seg.cjk && seg.text.length >= 4) latin.push(quoteTerm(seg.text));
  });

  var tiers = [];
  [4, 3, 2].forEach(function (size) {
    var clauses = [];
    var seen = {};

    for (var i = 0; i < segments.length && clauses.length < maxClauses; i++) {
      var seg = segments[i];
      if (!seg.cjk || seg.text.length < size) continue;
      for (var start = 0; start + size <= seg.text.length && clauses.length < maxClauses; start++) {
        var window = seg.text.slice(start, start + size);
        if (seen[window]) continue;
        seen[window] = true;
        var terms = bigrams(window).map(quoteTerm);
        if (!terms.length) continue;
        clauses.push(terms.length === 1 ? terms[0] : '(' + terms.join(' AND ') + ')');
      }
    }

    // Latin words ride along at every tier. They are already whole words, so
    // there is no window to slide and nothing to make them more selective.
    latin.forEach(function (term) {
      if (clauses.length < maxClauses + latin.length) clauses.push(term);
    });

    if (clauses.length) tiers.push({ window: size, expr: clauses.join(' OR ') });
  });

  return tiers;
}

/**
 * The one query the app actually sends: every bigram, ORed, capped at ten.
 *
 * See scanQueries above for why this and not the selective version.
 */
function scanExpression(text, options) {
  var tiers = scanQueries(text, options);
  return tiers.length ? tiers[tiers.length - 1].expr : '';
}

function quoteTerm(term) {
  return '"' + term.replace(/"/g, '""') + '"';
}

/**
 * Orders candidates by how much of the strip they actually explain.
 *
 * Scored on the longest unbroken run of characters shared with what was
 * read, rather than on how many bigrams matched, because the two say
 * different things. Five scattered bigrams spread across a long title is
 * usually coincidence — common characters are common. Four *consecutive*
 * characters is the title. Measured on real OCR output the run length sorts
 * the right book to the top far more often than bigram count does, and it
 * also gives the UI something honest to show a reader: "four characters
 * matched" is a claim they can check against the photograph themselves.
 *
 * @param rows   candidate records, in whatever order the index returned
 * @param text   what was read off the strip
 * @returns the same rows, best first, each with `_run` and `_confidence`
 */
function rankCandidates(rows, text) {
  var read = normalizeForRun(text);
  var scored = (rows || []).map(function (row, index) {
    var title = normalizeForRun(
      (row.title || '') + ' ' + (row.subtitle || '') + ' ' + (row.parallel_title || '')
    );
    var people = normalizeForRun((row.authors || '') + ' ' + (row.publisher || ''));

    var titleRun = longestSharedRun(read, title);
    var peopleRun = longestSharedRun(read, people);

    // The title carries the weight. An author or publisher match is
    // corroboration — a spine shows both, so a hit there is real evidence,
    // but on its own it narrows the catalogue to a publisher's whole list.
    var score = titleRun + Math.min(peopleRun, 4) * 0.5;

    row._run = titleRun;
    row._peopleRun = peopleRun;
    row._confidence = titleRun >= 4 ? 'high' : titleRun >= 3 ? 'medium' : 'low';
    row._score = score;
    row._order = index;
    return row;
  });

  scored.sort(function (a, b) {
    // Ties broken by the index's own relevance, not by title or id: it has
    // already weighed term rarity, which nothing here knows about.
    return b._score - a._score || a._order - b._order;
  });
  return scored;
}

/* ---------------- the pieces ---------------- */

/**
 * Splits text into runs of CJK and runs of Latin/digits, dropping
 * everything else.
 *
 * Deliberately the same rule the index was built with — see tokenize.js,
 * which owns it. The two must agree or a query finds nothing, so the test
 * asserts every token produced here is one `indexTokens` would have
 * produced.
 */
function segmentsOf(text) {
  var str = String(text || '').toLowerCase();
  var out = [];
  var current = null;
  for (var i = 0; i < str.length; i++) {
    var ch = str.charAt(i);
    var cjk = isCjkChar(ch);
    var latin = /[a-z0-9]/.test(ch);
    if (!cjk && !latin) {
      current = null;
      continue;
    }
    if (!current || current.cjk !== cjk) {
      current = { cjk: cjk, text: '' };
      out.push(current);
    }
    current.text += ch;
  }
  return out.filter(function (seg) { return seg.text.length > 0; });
}

var SCAN_CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;

function isCjkChar(ch) {
  return SCAN_CJK.test(ch);
}

function bigrams(run) {
  var out = [];
  if (run.length === 1) return [];
  for (var i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  return out;
}

/** Everything that is not a letter, digit or CJK character removed. */
function normalizeForRun(text) {
  var str = String(text || '').toLowerCase();
  var out = '';
  for (var i = 0; i < str.length; i++) {
    var ch = str.charAt(i);
    if (isCjkChar(ch) || /[a-z0-9]/.test(ch)) out += ch;
  }
  return out;
}

/**
 * Length of the longest substring the two share.
 *
 * Rolling one row of the usual table, because both strings are short — a
 * strip's worth of OCR against one title — and allocating a full matrix per
 * candidate, sixty candidates a strip, is how this would become the slow
 * part of a feature whose point is speed.
 */
function longestSharedRun(a, b) {
  if (!a || !b) return 0;
  var n = b.length;
  var previous = new Uint16Array(n + 1);
  var row = new Uint16Array(n + 1);
  var best = 0;

  for (var i = 1; i <= a.length; i++) {
    var ai = a.charAt(i - 1);
    for (var j = 1; j <= n; j++) {
      if (ai === b.charAt(j - 1)) {
        row[j] = previous[j - 1] + 1;
        if (row[j] > best) best = row[j];
      } else {
        row[j] = 0;
      }
    }
    var swap = previous;
    previous = row;
    row = swap;
  }
  return best;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scanTokens: scanTokens,
    scanQueries: scanQueries,
    scanExpression: scanExpression,
    rankCandidates: rankCandidates,
    longestSharedRun: longestSharedRun,
    normalizeForRun: normalizeForRun,
  };
}

if (typeof window !== 'undefined') {
  window.scanTokens = scanTokens;
  window.scanQueries = scanQueries;
  window.scanExpression = scanExpression;
  window.rankCandidates = rankCandidates;
  window.normalizeForRun = normalizeForRun;
}
