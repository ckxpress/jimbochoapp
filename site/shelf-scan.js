
/**
 * A photograph of a shelf, turned into something the catalogue can answer.
 *
 * Three ways in, in descending order of how much they can be trusted:
 *
 *   1. A barcode in the frame. An EAN-13 starting 978/979 *is* an ISBN, and
 *      the catalogue is keyed by it, so this is not recognition at all — it
 *      is a lookup, and it is right or it is absent. Costs nothing to try:
 *      the browser's own BarcodeDetector reads the photo already in memory,
 *      with no download and no camera permission. A shelf shot finds none,
 *      and a stack of books laid barcode-up finds all of them.
 *
 *   2. Spine segmentation plus the reader. The photo is cut into spines
 *      (spine-split.js), and each one becomes a card the reader can answer
 *      by typing the two or three characters they can read off it, with the
 *      strip shown beside the box. This is the path that always works: no
 *      download, no third-party request, no model, every browser.
 *
 *   3. Spine segmentation plus OCR. The same strips, with an engine fetched
 *      on demand to pre-fill the guesses. Off unless the reader asks for it,
 *      because it is several megabytes from a third party and because
 *      vertical Chinese on a photographed spine is genuinely hard — it is an
 *      accelerator for 2, not a replacement.
 *
 * Nothing here leaves the device except the catalogue queries, which carry
 * characters rather than pixels. The photograph is never uploaded, and the
 * only reason to say so is that a feature which photographs someone's home
 * should be explicit about it.
 */

(function () {
  'use strict';

  /* The longest edge the photo is reduced to before anything looks at it.
     A phone camera hands over 4000px, segmentation is O(pixels), and nothing
     downstream is better off for the extra: a spine is ~20px wide at this
     size, which is enough to cut between and enough to read. */
  var WORK_WIDTH = 1400;

  /* What a strip is scaled to for OCR. Engines trained on scanned pages want
     an x-height of roughly 30px; a spine 25px wide in the photo has to come
     up, not down, and interpolating up genuinely helps the engine. */
  var OCR_STRIP_WIDTH = 220;

  var ShelfScan = {
    /**
     * Decodes the file, corrects its orientation, scales it down, and
     * extracts the single channel the splitter wants.
     *
     * Orientation is not optional. A phone writes the sensor's own pixel
     * order and an EXIF tag saying how to turn it, so a portrait photo
     * arrives on its side — and a shelf on its side has horizontal spines,
     * which the splitter will cut into nonsense. `imageOrientation` makes
     * the browser apply the tag during decode; the <img> fallback below gets
     * it right too, because browsers have applied EXIF to <img> since 2019.
     */
    prepare: function (file, options) {
      var opts = options || {};
      var maxWidth = opts.maxWidth || WORK_WIDTH;

      return decode(file).then(function (bitmap) {
        var scale = Math.min(1, maxWidth / Math.max(bitmap.width, bitmap.height));
        var w = Math.max(1, Math.round(bitmap.width * scale));
        var h = Math.max(1, Math.round(bitmap.height * scale));

        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, w, h);
        if (bitmap.close) bitmap.close();

        var data = ctx.getImageData(0, 0, w, h).data;
        var gray = new Uint8Array(w * h);
        for (var i = 0, p = 0; i < gray.length; i++, p += 4) {
          // Rec. 601 luma. The exact coefficients do not matter much here,
          // but using a plain average does: it flattens the red/green
          // difference that distinguishes a lot of neighbouring spines.
          gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
        }

        return { canvas: canvas, width: w, height: h, gray: gray };
      });
    },

    /**
     * Strips, left to right, each with a picture of itself.
     *
     * The thumbnail is the spine as photographed — upright, not rotated —
     * because the row of them is then a picture of the shelf, and a reader
     * working through it can see at a glance where they are. Rotating them
     * to read the titles sounds helpful and loses that completely.
     */
    split: function (prepared, options) {
      var out = window.splitSpines(
        { gray: prepared.gray, width: prepared.width, height: prepared.height },
        options || {}
      );

      // How far the shelf leans, and over which rows that lean was measured.
      // Carried on every strip because the cut has to lean with it: on a
      // photograph taken a couple of degrees off-square a vertical cut
      // through a leaning boundary puts half of one book and half of the
      // next into the same strip, and the reader is then asked to identify
      // something that does not exist.
      var lean = { shear: out.shear || 0, band: out.band };

      return out.strips.map(function (strip, index) {
        return {
          index: index,
          x0: strip.x0,
          x1: strip.x1,
          width: strip.width,
          score: strip.score,
          lean: lean,
          thumb: crop(prepared.canvas, strip, 260, lean),
          /* Deferred: a canvas per strip at OCR scale is several megabytes
             for a shelf, and most strips never get asked. */
          ocrCanvas: null,
        };
      });
    },

    /** The same strip, scaled up and turned so its text reads across. */
    ocrCanvas: function (prepared, strip) {
      var scale = OCR_STRIP_WIDTH / Math.max(1, strip.width);
      var sw = Math.round(strip.width * scale);
      var sh = Math.round(prepared.height * scale);

      var canvas = document.createElement('canvas');
      // Rotated a quarter turn anticlockwise, so the top of the spine
      // becomes the left of the image and a vertical title reads
      // left-to-right, which is the only direction an engine trained on
      // pages can read.
      canvas.width = sh;
      canvas.height = sw;
      var ctx = canvas.getContext('2d');
      ctx.translate(0, sw);
      ctx.rotate(-Math.PI / 2);
      ctx.scale(scale, scale);
      leanTransform(ctx, prepared.canvas, strip);
      ctx.drawImage(prepared.canvas, 0, 0);
      return canvas;
    },

    /**
     * ISBNs visible in the photograph.
     *
     * Chrome and Android have had BarcodeDetector for years; Safari and
     * Firefox have not, and there is no point shimming it with a megabyte of
     * WebAssembly when the reader can fall back to the strips. So this
     * resolves to an empty list rather than failing, and the UI simply does
     * not mention barcodes when none were found.
     */
    barcodes: function (prepared) {
      if (typeof window.BarcodeDetector !== 'function') return Promise.resolve([]);

      var detector;
      try {
        detector = new window.BarcodeDetector({ formats: ['ean_13'] });
      } catch (err) {
        return Promise.resolve([]);
      }

      return detector
        .detect(prepared.canvas)
        .then(function (found) {
          var seen = {};
          var out = [];
          (found || []).forEach(function (code) {
            var value = String(code.rawValue || '').replace(/[^0-9]/g, '');
            // 978/979 is Bookland. Any other EAN-13 in the frame is a tin of
            // something, and looking it up in a book catalogue would only
            // produce a confident wrong answer.
            if (value.length !== 13) return;
            if (value.slice(0, 3) !== '978' && value.slice(0, 3) !== '979') return;
            if (seen[value]) return;
            seen[value] = true;
            out.push({
              isbn: value,
              box: code.boundingBox
                ? { x: code.boundingBox.x, y: code.boundingBox.y, w: code.boundingBox.width, h: code.boundingBox.height }
                : null,
            });
          });
          return out;
        })
        .catch(function () {
          return [];
        });
    },

    /**
     * The optional OCR engine.
     *
     * Kept behind this object rather than called directly so that the thing
     * it is optional *about* stays true: every caller handles `state` being
     * 'absent' or 'failed', and the feature is complete without it. Swapping
     * the engine, or moving it off a third-party CDN and into R2 beside the
     * database, is a change to `configure` and nothing else.
     */
    Ocr: {
      state: 'absent', // absent | loading | ready | failed
      error: null,
      _worker: null,
      _config: null,

      /**
       * @param config {{ script, languages, workerPath, corePath, langPath }}
       *        Supplied by the manifest, so where the engine comes from is a
       *        deploy decision and not baked into the page.
       */
      configure: function (config) {
        ShelfScan.Ocr._config = config && config.script ? config : null;
        if (ShelfScan.Ocr._config && ShelfScan.Ocr.state === 'absent') {
          ShelfScan.Ocr.state = 'offered';
        }
      },

      offered: function () {
        return !!ShelfScan.Ocr._config;
      },

      load: function () {
        var Ocr = ShelfScan.Ocr;
        if (Ocr._loading) return Ocr._loading;
        if (!Ocr._config) return Promise.reject(new Error('no OCR engine configured'));

        Ocr.state = 'loading';
        var config = Ocr._config;

        Ocr._loading = loadScript(config.script)
          .then(function () {
            if (!window.Tesseract || typeof window.Tesseract.createWorker !== 'function') {
              throw new Error('engine loaded but exported nothing usable');
            }
            var options = {};
            if (config.workerPath) options.workerPath = config.workerPath;
            if (config.corePath) options.corePath = config.corePath;
            if (config.langPath) options.langPath = config.langPath;
            return window.Tesseract.createWorker(config.languages || 'chi_tra', 1, options);
          })
          .then(function (worker) {
            Ocr._worker = worker;
            Ocr.state = 'ready';
            return worker;
          })
          .catch(function (err) {
            // A failure here is not a failure of the feature. The strips are
            // still there and still answerable by hand, so this is recorded
            // and surfaced as a missing convenience.
            Ocr.state = 'failed';
            Ocr.error = err;
            Ocr._loading = null;
            throw err;
          });

        return Ocr._loading;
      },

      /** @returns Promise<string> whatever was read, however wrong. */
      read: function (canvas) {
        return ShelfScan.Ocr.load().then(function (worker) {
          return worker.recognize(canvas).then(function (result) {
            return (result && result.data && result.data.text) || '';
          });
        });
      },
    },
  };

  /* ---------------- pieces ---------------- */

  function decode(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () {
        // Safari rejected `imageOrientation` for years rather than ignoring
        // it, so a browser that refuses the option still gets a decode.
        return createImageBitmap(file).catch(viaImgElement(file));
      });
    }
    return viaImgElement(file)();
  }

  function viaImgElement(file) {
    return function () {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          resolve(img);
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error('could not read that image'));
        };
        img.src = url;
      });
    };
  }

  /** One strip as a data URL, upright and de-leaned, at most maxHeight tall. */
  function crop(source, strip, maxHeight, lean) {
    var scale = Math.min(1, maxHeight / source.height);
    var w = Math.max(1, Math.round(strip.width * scale));
    var h = Math.max(1, Math.round(source.height * scale));

    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    leanTransform(ctx, source, { x0: strip.x0, lean: lean });
    ctx.drawImage(source, 0, 0);

    // JPEG, not PNG: a photograph of a spine is a photograph, and a shelf of
    // forty PNG strips is several megabytes of data URL held in the DOM.
    return canvas.toDataURL('image/jpeg', 0.75);
  }

  /**
   * Shifts and leans the source so the strip lands square on the canvas.
   *
   * The splitter measures a boundary's drift as `shear` pixels across the
   * band it looked at, with no drift at the band's middle. Undoing it is a
   * horizontal skew: a row's sample point moves by shear × (how far down the
   * band it is, from the middle). Written as a matrix rather than a loop so
   * the browser does it in the compositor and the result is interpolated
   * rather than stepped.
   */
  function leanTransform(ctx, source, strip) {
    var lean = strip.lean;
    var shear = lean && lean.shear ? lean.shear : 0;
    if (!shear || !lean.band) {
      ctx.translate(-strip.x0, 0);
      return;
    }
    var top = lean.band[0];
    var bandH = Math.max(1, lean.band[1] - lean.band[0]);
    // x_dest = x_src − x0 − shear × ((y − top) / bandH − 0.5)
    ctx.transform(1, 0, -shear / bandH, 1, shear * (top / bandH + 0.5) - strip.x0, 0);
  }

  var scripts = {};
  function loadScript(src) {
    if (scripts[src]) return scripts[src];
    scripts[src] = new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = src;
      tag.async = true;
      tag.onload = function () { resolve(); };
      tag.onerror = function () {
        reject(new Error('could not load ' + src));
      };
      document.head.appendChild(tag);
    });
    return scripts[src];
  }

  window.ShelfScan = ShelfScan;
})();
