/**
 * Does bad OCR still find the right book?
 *
 *   node tools/scan-match.test.js
 *
 * The important test here is the first one. scan-match.js re-implements the
 * index's tokenisation rule so it can order terms by the run they came from,
 * which tokenize.js has no reason to expose — and a re-implementation that
 * drifts from the real one produces queries that match nothing, silently,
 * for only some inputs. So every token this module would ask the index for
 * is checked to be a token the index was actually built with.
 */
'use strict';

const { scanTokens, scanQueries, rankCandidates, longestSharedRun } = require('../site/scan-match.js');
const { indexTokens } = require('../site/tokenize.js');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  — ' + detail : ''));
  if (!ok) failures++;
}

console.log('\nscan-match\n');

/* ---- 1. the drift guard ---- */
{
  const samples = [
    '寂天文化事業',
    '香港三聯書店 2024',
    'Oxford University Press',
    '董啟章 天工開物 Vol.2',
    '〇〇文学～【漫畫】',
    'a 氣 b',
    '',
  ];
  let bad = [];
  for (const text of samples) {
    const theirs = new Set(indexTokens(text));
    for (const token of scanTokens(text, 50)) {
      if (!theirs.has(token)) bad.push(JSON.stringify(text) + ' → ' + JSON.stringify(token));
    }
  }
  check(
    'every token is one the index was built with',
    bad.length === 0,
    bad.length ? bad.join('; ') : samples.length + ' samples'
  );
}

/* ---- 2. the tiered queries ---- */
{
  const tiers = scanQueries('\u5bc2\u5929\u6587\u5316\u4e8b\u696d');
  check('three tiers, widest window first', tiers.map((t) => t.window).join(',') === '4,3,2', tiers.map((t) => t.window).join(','));

  // The whole point: the widest tier ANDs within each window so a record has
  // to share four consecutive characters, not two. Measured against the live
  // index this is the difference between 266 matches and 20,000.
  const widest = tiers[0];
  check('the widest tier ANDs inside its windows', widest.expr.indexOf(' AND ') !== -1, widest.expr);
  check('and ORs the windows together', widest.expr.indexOf(') OR (') !== -1, widest.expr);

  const narrowest = tiers[tiers.length - 1];
  check(
    'the last resort is a plain OR of bigrams',
    narrowest.expr.indexOf(' AND ') === -1 && narrowest.expr.indexOf(' OR ') !== -1,
    narrowest.expr
  );
  check('terms are quoted everywhere', /^[()" \u0041-\u005a\w]*$|"/.test(widest.expr) && widest.expr.split('"').length % 2 === 1, widest.expr);

  check('nothing readable gives no query', scanQueries('\u3001\u3002\uff1f !!').length === 0);
  check('a single character gives no query', scanQueries('\u6587').length === 0, JSON.stringify(scanQueries('\u6587')));

  // A two-character read still has somewhere to go — the last tier.
  const two = scanQueries('\u6f2b\u756b');
  check('two characters reach the last tier only', two.length === 1 && two[0].window === 2, JSON.stringify(two.map((t) => t.window)));

  const many = scanQueries('\u9999\u6e2f\u4e2d\u6587\u5927\u5b78\u51fa\u7248\u793e\u4e8c\u96f6\u4e8c\u56db\u5e74\u7248\u672c', { maxClauses: 6 });
  check('clauses are capped', many[0].expr.split(' OR ').length <= 6, many[0].expr.split(' OR ').length + ' clauses');

  // Latin words long enough to mean something ride along; short ones do not.
  const mixed = scanQueries('Oxford \u6587\u5b78\u53f2 vol');
  check(
    'a long Latin word is kept and a short one dropped',
    mixed[mixed.length - 1].expr.indexOf('"oxford"') !== -1 && mixed[mixed.length - 1].expr.indexOf('"vol"') === -1,
    mixed[mixed.length - 1].expr
  );
}

/* ---- 3. the longest run first ---- */
{
  // The title is the long run; "漫畫" is a series word the OCR also caught.
  const tokens = scanTokens('漫畫 天工開物記', 4);
  check(
    'terms come from the longest run first',
    tokens.every((t) => '天工開物記'.indexOf(t) !== -1),
    tokens.join(',')
  );
}

/* ---- 4. runs ---- */
{
  check('shared run of a prefix', longestSharedRun('abcdef', 'zzabcz') === 3, String(longestSharedRun('abcdef', 'zzabcz')));
  check('no shared run', longestSharedRun('abc', 'xyz') === 0);
  check('empty is zero', longestSharedRun('', 'abc') === 0);
}

/* ---- 5. garbled OCR still sorts the right book first ---- */
{
  // What the engine actually hands back from a vertical spine: a few right
  // characters among wrong ones, in roughly the right order.
  const read = '宋天文化事粛 □□';
  const candidates = [
    { id: 'a', title: '漫畫大全', authors: '', publisher: '東立' },
    { id: 'b', title: '寂天文化英語教室', authors: '', publisher: '寂天文化' },
    { id: 'c', title: '天氣與文學', authors: '', publisher: '三聯' },
    { id: 'd', title: '事業經營學', authors: '', publisher: '商務' },
  ];
  const ranked = rankCandidates(candidates, read);
  check(
    'the book sharing the longest run wins',
    ranked[0].id === 'b',
    ranked.map((r) => r.id + ':' + r._run).join(' ')
  );
  // Three shared characters out of a six-character read: the right book, but
  // offered rather than asserted, which is what "medium" means in the UI.
  check('three shared characters is medium confidence', ranked[0]._run === 3 && ranked[0]._confidence === 'medium',
    ranked[0]._run + '/' + ranked[0]._confidence);

  // One more character right, and it is no longer a guess.
  const better = rankCandidates(candidates.map((r) => Object.assign({}, r)), '\u5bc2\u5929\u6587\u5316\u4e8b\u7c9b');
  check('four shared characters is high confidence',
    better[0].id === 'b' && better[0]._run === 4 && better[0]._confidence === 'high',
    better[0].id + ':' + better[0]._run + '/' + better[0]._confidence);
  check(
    'a two-character coincidence does not',
    ranked[ranked.length - 1]._confidence !== 'high',
    ranked[ranked.length - 1].id + ':' + ranked[ranked.length - 1]._confidence
  );
}

/* ---- 6. index order breaks ties ---- */
{
  const rows = [
    { id: 'first', title: '完全不同' },
    { id: 'second', title: '完全不同' },
  ];
  const ranked = rankCandidates(rows, '完全不同');
  check('equal scores keep the index’s order', ranked[0].id === 'first', ranked.map((r) => r.id).join(','));
}

console.log('\n' + (failures ? '✗ ' + failures + ' failed\n' : '✓ all passed\n'));
process.exit(failures ? 1 : 0);
