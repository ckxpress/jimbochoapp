
/**
 * Where one book spine ends and the next begins, in a photograph of a shelf.
 *
 * A shelf photographed head-on is a row of vertical strips, and the useful
 * property is that a boundary between two books is an edge that runs the
 * whole height of the shelf, while the text and decoration printed on a
 * spine is an edge that runs for part of it. So boundaries are found by
 * asking, for each column of pixels, *at how many heights* does something
 * change horizontally here — not how strongly. Summing gradient magnitude
 * instead was tried first and is worse, because one high-contrast glyph on a
 * white spine outscores a real gutter.
 *
 * That cue alone misses the other common boundary: two books touching with
 * no shadow between them, where the join is a step in colour rather than a
 * line. So a second cue compares the k columns either side, which answers a
 * step and ignores a line — comparing their *median* tone, because a
 * vertical Chinese title is a centred column of glyphs that drags the mean
 * of the columns it occupies and fooled this cue into cutting books at the
 * edges of their own titles.
 *
 * Deliberately a pure function over a single channel, with no canvas, no
 * ImageData and no DOM: the segmentation is the part worth testing, and this
 * way it can be tested in Node against a synthetic shelf
 * (tools/spine-split.test.js) instead of against a photograph nobody can
 * assert about.
 *
 * It does not know what a book is. It reports where the frame changes
 * character vertically, and a photograph that is half wall or taken at an
 * angle will produce strips that are not books — which is why nothing
 * downstream trusts a strip until a reader confirms it.
 */

/**
 * @param image {{ gray: Uint8Array|number[], width: number, height: number }}
 *        One byte per pixel, row-major, 0–255. Luminance is what the browser
 *        passes; any single channel works.
 * @param options {{
 *   top, bottom:   fractions of the height to measure between (default 0.08–0.92)
 *   minWidth:      narrowest spine, as a fraction of the image width (default 0.012)
 *   edge:          gradient that counts as an edge, 0–255 (default 18)
 *   sensitivity:   lower finds more cuts (default 1)
 * }}
 * @returns {{ width, height, band, profile, threshold, cuts, strips }}
 *          strips are { x0, x1, width, score } in pixels, left to right,
 *          x1 exclusive. `score` is the weaker of the two edges that bound
 *          the strip — how much the split either side was believed.
 */
function splitSpines(image, options) {
  var opts = options || {};
  var w = image.width | 0;
  var h = image.height | 0;
  var gray = image.gray;

  if (!w || !h || !gray || gray.length < w * h) {
    throw new Error('splitSpines: need gray of width*height bytes');
  }

  // The top and bottom of a shelf photograph are usually the shelf itself:
  // a board, a lip, a shadow — all of which run horizontally and so register
  // at every column equally, raising the floor without favouring any cut.
  // Trimming them costs nothing and keeps the threshold meaningful.
  var y0 = clampInt(h * frac(opts.top, 0.08), 0, h - 2);
  var y1 = clampInt(h * frac(opts.bottom, 0.92), y0 + 2, h);
  var bandH = y1 - y0;

  var minWidth = Math.max(3, Math.round(w * frac(opts.minWidth, 0.012)));
  var sensitivity = opts.sensitivity === undefined ? 1 : opts.sensitivity;
  var edge = opts.edge === undefined ? adaptiveEdge(gray, w, y0, y1) : opts.edge;

  // How far the frame leans, in pixels of horizontal drift from the top of
  // the band to the bottom. Searched unless the caller already knows.
  var shear = opts.shear === undefined ? findShear(gray, w, h, y0, y1, edge) : opts.shear;

  var coherence = coherenceProfile(gray, w, y0, y1, edge, shear, 1);
  var step = stepProfile(gray, w, y0, y1, minWidth, shear);

  // Coherence is squared before it is mixed. A real gutter is an edge at
  // essentially every height, so it scores 1 either way; a column of title
  // text is an edge at perhaps half the heights, and squaring takes that
  // from 0.5 to 0.25 while leaving the gutter alone. Linear, the two are 2:1
  // apart and a run of text outscores a faint gutter; squared they are 4:1
  // and the threshold separates them.
  var raw = new Float64Array(w);
  for (var mx = 0; mx < w; mx++) {
    var c2 = coherence[mx] * coherence[mx];
    raw[mx] = 0.6 * c2 + 0.4 * step[mx] * c2;
  }

  // A gutter is two or three pixels wide and a photograph is never quite
  // square to the shelf, so the same boundary lands on slightly different
  // columns at different heights. Without this the peak splits in two and
  // the suppression below keeps the wrong one.
  var profile = smooth(raw, 1);

  /* ---- choose the cuts ---- */

  var stats = meanStd(profile);
  // Mean plus one deviation: a shelf of twenty books puts ~2% of columns on
  // a boundary, so the distribution is nearly all floor and the deviation is
  // set by the peaks themselves. The absolute floor is what stops a photo of
  // a blank wall from being carved into imaginary books.
  var threshold = Math.max(0.06, stats.mean + sensitivity * stats.std);

  var order = [];
  for (var ox = minWidth; ox < w - minWidth; ox++) {
    if (profile[ox] < threshold) continue;
    // Local maximum only, so one boundary offers one candidate.
    if (profile[ox] < profile[ox - 1] || profile[ox] < profile[ox + 1]) continue;
    order.push(ox);
  }
  order.sort(function (a, b) { return profile[b] - profile[a]; });

  // Greedy, strongest first, refusing anything that would make a strip
  // narrower than a book. Taken left to right instead, a run of noise early
  // in the frame would reserve the space a real gutter needed.
  var cuts = [];
  for (var c = 0; c < order.length; c++) {
    var at = order[c];
    var ok = true;
    for (var j = 0; j < cuts.length; j++) {
      if (Math.abs(cuts[j] - at) < minWidth) { ok = false; break; }
    }
    if (ok) cuts.push(at);
  }
  cuts.sort(function (a, b) { return a - b; });

  /* ---- cuts to strips ---- */

  var bounds = [0].concat(cuts, [w]);
  var strips = [];
  for (var b = 0; b + 1 < bounds.length; b++) {
    var sx0 = bounds[b];
    var sx1 = bounds[b + 1];
    if (sx1 - sx0 < minWidth) continue; // a sliver against the frame edge
    strips.push({
      x0: sx0,
      x1: sx1,
      width: sx1 - sx0,
      // The strip is only as trustworthy as its weaker side.
      score: Math.min(
        b === 0 ? 1 : profile[sx0],
        b + 2 === bounds.length ? 1 : profile[sx1]
      ),
    });
  }

  return {
    width: w,
    height: h,
    band: [y0, y1],
    // Measured at the middle of the frame: a strip is a parallelogram when
    // the shelf was shot off-axis, and whoever cuts the picture up needs to
    // lean the cut the same way or every strip holds two half-books.
    shear: shear,
    edge: edge,
    profile: profile,
    threshold: threshold,
    cuts: cuts,
    strips: strips,
  };
}

/**
 * How far the shelf leans, in pixels across the measured band.
 *
 * Everything else here assumes a boundary stacks up in one column. Nobody
 * photographs a shelf square on: a few degrees of yaw and the join between
 * two books drifts twenty pixels from the top of the frame to the bottom, so
 * each row contributes its edge to a different column and the evidence that
 * should pile up in one place is spread across twenty. Measured, that costs
 * a fifth of the boundaries — 20 of 25 — and they are lost by
 * under-segmenting, which is the direction that cannot be recovered: a book
 * that never becomes a strip is never offered to the reader at all.
 *
 * So the profile is computed at a few leans and the best one kept. "Best" is
 * the one that concentrates the most energy into the fewest columns, which
 * is what being aligned means — the top 5% of columns carry more when the
 * boundaries land on top of each other.
 *
 * On a third of the rows, because this is choosing between seven coarse
 * options and not measuring anything that needs precision.
 */
function findShear(gray, w, h, y0, y1, edge) {
  var span = h * 0.03; // ±3% of the height, about ±2 degrees
  var best = 0;
  var bestScore = -1;

  for (var i = -3; i <= 3; i++) {
    var candidate = Math.round((span * i) / 3);
    var profile = coherenceProfile(gray, w, y0, y1, edge, candidate, 3);
    var score = topMass(profile, 0.05);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Sum of the largest `fraction` of the values. */
function topMass(values, fraction) {
  var copy = Array.prototype.slice.call(values);
  copy.sort(function (a, b) { return b - a; });
  var take = Math.max(1, Math.round(copy.length * fraction));
  var sum = 0;
  for (var i = 0; i < take; i++) sum += copy[i];
  return sum;
}

/**
 * For each column, the fraction of the band's height at which something
 * changes horizontally — following the lean.
 *
 * The count, not the sum. A book boundary is an edge at nearly every height;
 * a glyph printed on a spine is a strong edge at a few heights. Summing
 * gradient magnitude lets one high-contrast serif outscore a real gutter,
 * which is the first thing this was written to do and the first thing it got
 * wrong.
 */
function coherenceProfile(gray, w, y0, y1, edge, shear, rowStep) {
  var out = new Float64Array(w);
  var bandH = y1 - y0;
  var step = rowStep || 1;
  var counted = 0;

  for (var y = y0; y < y1; y += step) {
    // Where this row sits relative to the middle decides how far it slides.
    var offset = Math.round(shear * ((y - y0) / bandH - 0.5));
    var base = y * w;
    for (var x = 1; x < w - 1; x++) {
      var sx = x + offset;
      if (sx < 1 || sx >= w - 1) continue;
      var d = gray[base + sx + 1] - gray[base + sx - 1];
      if (d < 0) d = -d;
      if (d >= edge) out[x]++;
    }
    counted++;
  }

  if (counted) for (var k = 0; k < w; k++) out[k] /= counted;
  return out;
}

/**
 * For each column, how big a step in colour the k columns either side show.
 *
 * The companion to coherence, and it answers the boundary coherence misses:
 * two books touching with no shadow between them, where the join is a change
 * of colour rather than a line.
 *
 * Compared by *median* tone, not mean, and this is the difference between
 * the cue working and not. A spine carries a column of printed title text,
 * and in vertical Chinese that text is one centred column running much of
 * the height, so every glyph sits at the same few x positions. Averaged,
 * those columns come out darker than the blank margin beside them, this
 * detector reads the edge of the title as the edge of a book, and a shelf of
 * 21 books is cut into 31. The median asks what colour the column mostly is,
 * which is the spine, and is unmoved by anything covering less than half the
 * height.
 */
function stepProfile(gray, w, y0, y1, minWidth, shear) {
  var bandH = y1 - y0;

  // From a 256-bin histogram rather than by sorting: O(bandH + 256) a column
  // against O(bandH log bandH), which on a 1400-column photo is the
  // difference between a frame and several.
  var colTone = new Float64Array(w);
  var hist = new Uint32Array(256);
  var half = bandH >> 1;

  for (var cx = 0; cx < w; cx++) {
    for (var z = 0; z < 256; z++) hist[z] = 0;
    var seen = 0;
    for (var y = y0; y < y1; y++) {
      var sx = cx + Math.round(shear * ((y - y0) / bandH - 0.5));
      if (sx < 0 || sx >= w) continue;
      hist[gray[y * w + sx]]++;
      seen++;
    }
    var want = seen >> 1;
    var acc = 0;
    var med = 0;
    for (med = 0; med < 255; med++) {
      acc += hist[med];
      if (acc > want) break;
    }
    colTone[cx] = seen ? med : 0;
  }

  // Prefix sums so the k-column averages either side are O(1) per column.
  var prefix = new Float64Array(w + 1);
  for (var i = 0; i < w; i++) prefix[i + 1] = prefix[i] + colTone[i];

  var k = Math.max(2, Math.round(minWidth / 2));
  var out = new Float64Array(w);
  for (var sx2 = k; sx2 < w - k; sx2++) {
    var left = (prefix[sx2] - prefix[sx2 - k]) / k;
    var right = (prefix[sx2 + k] - prefix[sx2]) / k;
    var diff = right - left;
    if (diff < 0) diff = -diff;
    // 48 grey levels between neighbouring spines is already unambiguous;
    // past that the cue is saturated and should not outvote coherence.
    out[sx2] = Math.min(1, diff / 48);
  }
  return out;
}

/**
 * The gradient a pixel shows when nothing is there, times four.
 *
 * Median rather than mean: the mean is dragged by the boundaries themselves,
 * which is precisely backwards — the more boundaries a shelf has, the higher
 * the bar would become for finding them.
 */
function adaptiveEdge(gray, w, y0, y1) {
  var hist = new Uint32Array(256);
  var count = 0;
  // Every fourth row: this is an estimate of a bulk property, and four times
  // the work buys no more precision than the clamp below already throws away.
  for (var y = y0; y < y1; y += 4) {
    var base = y * w;
    for (var x = 1; x < w - 1; x++) {
      var d = gray[base + x + 1] - gray[base + x - 1];
      hist[d < 0 ? -d : d]++;
      count++;
    }
  }
  if (!count) return 18;

  var half = count >> 1;
  var acc = 0;
  var median = 0;
  for (median = 0; median < 255; median++) {
    acc += hist[median];
    if (acc > half) break;
  }

  var edge = median * 4;
  return edge < 6 ? 6 : edge > 40 ? 40 : edge;
}

/** Triangular blur, radius r, edges held rather than darkened. */
function smooth(values, r) {
  if (r <= 0) return values;
  var n = values.length;
  var out = new Float64Array(n);
  for (var i = 0; i < n; i++) {
    var sum = 0;
    var weight = 0;
    for (var d = -r; d <= r; d++) {
      var j = i + d;
      if (j < 0 || j >= n) continue;
      var wgt = r + 1 - Math.abs(d);
      sum += values[j] * wgt;
      weight += wgt;
    }
    out[i] = sum / weight;
  }
  return out;
}

function meanStd(values) {
  var n = values.length;
  var sum = 0;
  for (var i = 0; i < n; i++) sum += values[i];
  var mean = sum / n;
  var sq = 0;
  for (var j = 0; j < n; j++) {
    var d = values[j] - mean;
    sq += d * d;
  }
  return { mean: mean, std: Math.sqrt(sq / n) };
}

function frac(value, fallback) {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : fallback;
}

function clampInt(value, lo, hi) {
  var v = Math.round(value);
  return v < lo ? lo : v > hi ? hi : v;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { splitSpines: splitSpines };
}

/* Shared by the browser and the test, which is the whole reason it is a
   separate file: see tools/spine-split.test.js. */
if (typeof window !== 'undefined') {
  window.splitSpines = splitSpines;
}
