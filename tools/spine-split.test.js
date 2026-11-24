/**
 * Does the spine splitter find the books?
 *
 * Tested against a synthetic shelf rather than a photograph, because a
 * photograph has no answer key: nobody can assert that a cut at x=413 was
 * correct. Here the boundaries are known exactly, so the test can say how
 * close the splitter got and how much it invented.
 *
 * The synthetic shelf is built to carry the two things that defeat a naive
 * gradient sum — printed text on the spines, and sensor noise — so passing
 * this is evidence the cue choice is right, not just that the arithmetic is.
 *
 *   node tools/spine-split.test.js
 */
'use strict';

const { splitSpines } = require('../site/spine-split.js');

/* A fixed generator: a test that flakes one run in ten teaches nothing. */
function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Builds a shelf of flat vertical spines and returns both the image and the
 * boundaries used to draw it.
 */
function shelf(opts) {
  const o = Object.assign(
    { width: 1200, height: 800, widths: null, gutter: 2, noise: 6, text: true, seed: 7 },
    opts
  );
  const rand = rng(o.seed);
  const w = o.width;
  const h = o.height;
  const gray = new Uint8Array(w * h);

  // Spine widths: whatever was asked for, else a plausible spread.
  let widths = o.widths;
  if (!widths) {
    widths = [];
    let used = 0;
    while (used < w) {
      const span = Math.round(22 + rand() * 60);
      widths.push(Math.min(span, w - used));
      used += span;
    }
  }

  const boundaries = [];
  const spines = [];
  let x = 0;
  for (const span of widths) {
    if (x > 0) boundaries.push(x);
    spines.push({ x0: x, x1: Math.min(x + span, w), tone: o.tones ? o.tones[spines.length % o.tones.length] : Math.round(60 + rand() * 170) });
    x += span;
    if (x >= w) break;
  }

  // Fill each spine, then darken the gutter at its left edge.
  for (const sp of spines) {
    for (let y = 0; y < h; y++) {
      for (let px = sp.x0; px < sp.x1; px++) gray[y * w + px] = sp.tone;
    }
  }
  if (o.gutter > 0) {
    for (const bx of boundaries) {
      for (let y = 0; y < h; y++) {
        for (let g = 0; g < o.gutter; g++) {
          const px = bx + g - (o.gutter >> 1);
          if (px >= 0 && px < w) gray[y * w + px] = 28;
        }
      }
    }
  }

  // Printed matter: a centred column of glyphs, which is what a vertical
  // Chinese title is. This is the thing a gradient-sum splitter mistakes for
  // a boundary, and because the glyphs of a vertical title all sit at the
  // same x, their left and right edges are coherent down the spine — so it
  // is not enough to test against speckle.
  //
  // Glyphs are drawn as strokes with the spine showing between them, not as
  // solid blocks, because that is what a character is: 文 covers maybe a
  // third of its own box. The distinction decides the test. Against solid
  // blocks the median column tone flips to the ink and the cue that ignores
  // printing stops ignoring it — so a fixture made of solid blocks is not a
  // hard version of this test, it is a different and unreal one. Kept as its
  // own worst case below, with its own looser bound.
  if (o.text) {
    for (const sp of spines) {
      // The shape that actually defeats a median: one unbroken band of ink
      // past half the height, so the ink *is* the majority of the column.
      if (o.solidText) {
        const inset0 = Math.max(1, Math.round((sp.x1 - sp.x0) * 0.2));
        const tone0 = sp.tone > 128 ? 20 : 235;
        const from = Math.round(h * 0.14);
        const to = Math.round(h * 0.76);
        for (let y = from; y < to; y++) {
          for (let px = sp.x0 + inset0; px < sp.x1 - inset0; px++) gray[y * w + px] = tone0;
        }
        continue;
      }
      const glyphs = 3 + Math.floor(rand() * 6);
      const inset = Math.max(1, Math.round((sp.x1 - sp.x0) * 0.2));
      const tone = sp.tone > 128 ? 20 : 235;
      let gy = Math.round(h * (0.12 + rand() * 0.2));
      for (let i = 0; i < glyphs; i++) {
        const box = Math.round((sp.x1 - sp.x0 - 2 * inset) * (o.solidText ? 1.0 : 1.0));
        const gh = Math.max(6, box);
        if (gy + gh > h * 0.9) break;
        if (o.solidText) {
          for (let y = gy; y < gy + gh; y++) {
            for (let px = sp.x0 + inset; px < sp.x1 - inset; px++) gray[y * w + px] = tone;
          }
        } else {
          // Three horizontal strokes and one vertical: a plausible character,
          // about a third ink.
          const strokes = [0, Math.floor(gh / 2), gh - 2];
          for (const sy of strokes) {
            for (let y = gy + sy; y < Math.min(h, gy + sy + 2); y++) {
              for (let px = sp.x0 + inset; px < sp.x1 - inset; px++) gray[y * w + px] = tone;
            }
          }
          const mid = Math.round((sp.x0 + sp.x1) / 2);
          for (let y = gy; y < Math.min(h, gy + gh); y++) {
            for (let px = mid - 1; px <= mid; px++) {
              if (px >= 0 && px < w) gray[y * w + px] = tone;
            }
          }
        }
        gy += gh + Math.max(2, Math.round(gh * 0.25));
      }
    }
  }

  if (o.noise > 0) {
    for (let i = 0; i < gray.length; i++) {
      const n = Math.round((rand() * 2 - 1) * o.noise);
      const v = gray[i] + n;
      gray[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  return { image: { gray, width: w, height: h }, boundaries, spines };
}

/** How well did `cuts` recover `truth`? */
function score(truth, cuts, tolerance) {
  const matched = new Set();
  let found = 0;
  for (const t of truth) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < cuts.length; i++) {
      if (matched.has(i)) continue;
      const d = Math.abs(cuts[i] - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && bestD <= tolerance) { matched.add(best); found++; }
  }
  return { found, missed: truth.length - found, spurious: cuts.length - matched.size };
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  — ' + detail : ''));
  if (!ok) failures++;
}

console.log('\nspine-split\n');

/* ---- 1. the ordinary case ---- */
{
  const s = shelf({});
  const out = splitSpines(s.image);
  const r = score(s.boundaries, out.cuts, 4);
  console.log('  shelf of ' + s.spines.length + ' spines, ' + s.boundaries.length + ' boundaries');
  check(
    'finds at least 90% of the boundaries',
    r.found >= s.boundaries.length * 0.9,
    r.found + '/' + s.boundaries.length + ' within 4px'
  );
  check(
    'invents few boundaries',
    r.spurious <= Math.max(1, s.boundaries.length * 0.15),
    r.spurious + ' spurious'
  );
}

/* ---- 2. text must not read as a boundary ---- */
// The same shelf with and without printing should find the same cuts; if the
// printing moves them, the cue is measuring contrast rather than coherence.
{
  const plain = shelf({ text: false, seed: 11 });
  const printed = shelf({ text: true, seed: 11 });
  const a = splitSpines(plain.image);
  const b = splitSpines(printed.image);
  const ra = score(plain.boundaries, a.cuts, 4);
  const rb = score(printed.boundaries, b.cuts, 4);
  check(
    'printing on the spines costs little accuracy',
    rb.found >= ra.found - 1 && rb.spurious <= ra.spurious + 2,
    'plain ' + ra.found + '/' + ra.spurious + ' vs printed ' + rb.found + '/' + rb.spurious + ' (found/spurious)'
  );
}

/* ---- 2b. the worst case: solid blocks of ink ---- */
// Not a real spine — no character is a filled rectangle — but it is the
// shape that breaks the median cue, because ink covering more than half a
// column's height *is* that column's colour as far as a median is concerned,
// and the step detector then reads the edge of the title as the edge of a
// book. Kept with a looser bound so the failure is measured rather than
// forgotten: over-segmenting is the error this feature can afford, since a
// reader skips a half-spine in one tap but never notices a book that was
// never offered.
{
  const s = shelf({ solidText: true, seed: 11 });
  const out = splitSpines(s.image);
  const r = score(s.boundaries, out.cuts, 4);
  check(
    'solid ink keeps every real boundary',
    r.found >= s.boundaries.length * 0.9,
    r.found + '/' + s.boundaries.length
  );
  check(
    'solid ink over-segments by under a third',
    r.spurious <= s.boundaries.length / 3,
    r.spurious + ' spurious of ' + s.boundaries.length
  );
}

/* ---- 3. identical neighbours, separated only by a gutter ---- */
{
  const s = shelf({ tones: [150, 150], text: false, gutter: 3, seed: 3 });
  const out = splitSpines(s.image);
  const r = score(s.boundaries, out.cuts, 4);
  check(
    'a shadow between two same-coloured spines is still a boundary',
    r.found >= s.boundaries.length * 0.9,
    r.found + '/' + s.boundaries.length
  );
}

/* ---- 4. touching neighbours with no gutter, different colours ---- */
{
  const s = shelf({ tones: [80, 170], text: false, gutter: 0, seed: 5 });
  const out = splitSpines(s.image);
  const r = score(s.boundaries, out.cuts, 4);
  check(
    'a colour step with no shadow is still a boundary',
    r.found >= s.boundaries.length * 0.9,
    r.found + '/' + s.boundaries.length
  );
}

/* ---- 4b. what a photograph actually is ---- */
// The fixtures above are drawn with a ruler: perfectly vertical boundaries,
// even lighting, every edge one pixel wide. A phone held up to a shelf
// produces none of that, and a splitter tuned on clean synthetic input is a
// splitter tuned on the wrong thing. So the same shelf is degraded the three
// ways a real photograph is degraded — out of focus, shot off-axis so the
// spines lean, and darker at the edges than the middle — and has to survive
// all three at once at the default sensitivity.
{
  function degrade(img, opts) {
    const w = img.width, h = img.height;
    let g = Uint8Array.from(img.gray);

    // Off-axis: each row slides sideways, so a boundary is a slanted line
    // rather than a column. This is the one that should hurt most, because
    // the whole method assumes a boundary stacks up in one column.
    if (opts.tilt) {
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        const shift = Math.round(opts.tilt * (y / h - 0.5));
        for (let x = 0; x < w; x++) {
          const sx = Math.min(w - 1, Math.max(0, x - shift));
          out[y * w + x] = g[y * w + sx];
        }
      }
      g = out;
    }

    // Out of focus: a separable box blur, run twice to approximate a
    // gaussian. Spreads every edge over several columns and flattens the
    // peak the threshold has to clear.
    if (opts.blur) {
      const r = opts.blur;
      for (let pass = 0; pass < 2; pass++) {
        const out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            let sum = 0, n = 0;
            for (let d = -r; d <= r; d++) {
              const sx = x + d;
              if (sx < 0 || sx >= w) continue;
              sum += g[y * w + sx]; n++;
            }
            out[y * w + x] = sum / n;
          }
        }
        g = out;
      }
    }

    // Uneven light: the middle of the frame is brighter than the corners, so
    // the absolute contrast of a boundary depends on where it is.
    if (opts.vignette) {
      const cx = w / 2, cy = h / 2;
      const far = Math.sqrt(cx * cx + cy * cy);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - cx, dy = y - cy;
          const t = Math.sqrt(dx * dx + dy * dy) / far;
          g[y * w + x] = Math.max(0, g[y * w + x] * (1 - opts.vignette * t * t));
        }
      }
    }
    return { gray: g, width: w, height: h };
  }

  const s = shelf({ seed: 19 });

  // The lean has to be found, not just survived: whoever cuts the picture up
  // uses this number to lean the cut the same way, and a strip cut straight
  // through a leaning boundary holds half of one book and half of the next.
  for (const tilt of [-24, 24]) {
    const out = splitSpines(degrade(s.image, { tilt }));
    check(
      'a lean of ' + tilt + 'px is measured, not ignored',
      Math.sign(out.shear) === Math.sign(tilt) && Math.abs(out.shear) >= 8,
      'shear ' + out.shear
    );
  }
  check('a square photograph is left alone', splitSpines(s.image).shear === 0,
    'shear ' + splitSpines(s.image).shear);

  const cases = [
    ['out of focus', { blur: 3 }],
    ['off-axis', { tilt: 24 }],
    ['all three at once', { blur: 3, tilt: 24, vignette: 0.55 }],
  ];
  for (const [name, opts] of cases) {
    const out = splitSpines(degrade(s.image, opts));
    const r = score(s.boundaries, out.cuts, 6);
    check(
      name + ' keeps the boundaries',
      r.found >= s.boundaries.length * 0.9,
      r.found + '/' + s.boundaries.length + ', ' + r.spurious + ' spurious'
    );
  }
}

/* ---- 5. nothing there ---- */
// A photograph of a wall must not be carved into imaginary books. This is
// what the absolute floor under the threshold is for.
{
  const w = 1200, h = 800;
  const gray = new Uint8Array(w * h);
  const rand = rng(21);
  for (let i = 0; i < gray.length; i++) gray[i] = 180 + Math.round((rand() * 2 - 1) * 6);
  const out = splitSpines({ gray, width: w, height: h });
  check('a blank wall yields no spines', out.cuts.length === 0, out.cuts.length + ' cuts');
}

/* ---- 6. no strip narrower than a book ---- */
{
  const s = shelf({ seed: 33 });
  const out = splitSpines(s.image);
  const min = Math.max(3, Math.round(s.image.width * 0.012));
  const tooNarrow = out.strips.filter((st) => st.width < min);
  check('every strip is at least ' + min + 'px wide', tooNarrow.length === 0, tooNarrow.length + ' too narrow');
  const covers = out.strips.every((st) => st.x1 > st.x0 && st.x0 >= 0 && st.x1 <= s.image.width);
  check('strips stay inside the frame', covers);
}

/* ---- 7. sensitivity is monotone ---- */
// Not cosmetic: the UI offers this as "找到太少／太多", and it would be a
// confusing control if turning it down found fewer.
{
  const s = shelf({ seed: 44 });
  const low = splitSpines(s.image, { sensitivity: 0.4 }).cuts.length;
  const mid = splitSpines(s.image, { sensitivity: 1 }).cuts.length;
  const high = splitSpines(s.image, { sensitivity: 2 }).cuts.length;
  check(
    'lower sensitivity finds at least as many cuts',
    low >= mid && mid >= high,
    low + ' ≥ ' + mid + ' ≥ ' + high
  );
}

console.log('\n' + (failures ? '✗ ' + failures + ' failed\n' : '✓ all passed\n'));
process.exit(failures ? 1 : 0);
