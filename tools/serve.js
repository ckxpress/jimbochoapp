#!/usr/bin/env node
'use strict';

/** Zero-dependency static server for site/. Usage: npm start [-- --port 8080] */

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', 'site');

/**
 * A SQLite file states its own page size in bytes 16-17 of the header, so the
 * log never has to be kept in step with the build by hand. Cached per file;
 * anything that is not a database logs in 4 KiB units, which is only a label.
 */
const pageSizes = {};
function dbPageSize(file) {
  if (pageSizes[file]) return pageSizes[file];
  let size = 4096;
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(18);
    fs.readSync(fd, head, 0, 18, 0);
    fs.closeSync(fd);
    if (head.slice(0, 15).toString('latin1') === 'SQLite format 3') {
      const stated = head.readUInt16BE(16);
      // 1 is how the format spells 65536.
      size = stated === 1 ? 65536 : stated;
    }
  } catch (err) {
    /* fall back to 4 KiB */
  }
  pageSizes[file] = size;
  return size;
}
const PORT = Number(process.env.PORT || argValue('--port') || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // GitHub Pages serves these two; match it so a manifest or icon problem
  // shows up here rather than only after a deploy.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const rangeBytes = {};
const rangeCount = {};

const devSearchApi = require('./lib/dev-search-api.js');

const server = http.createServer((req, res) => {
  let url;
  let pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch (err) {
    res.writeHead(400).end('Bad request');
    return;
  }

  // Stands in for the Cloudflare Worker, using the Worker's own SQL. Without
  // it the site cannot be developed against the API at all: production allows
  // the jimbocho.app origin, so a page on localhost cannot call it.
  if (devSearchApi.handle(req, res, url)) return;

  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = path.join(ROOT, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + pathname);
      return;
    }

    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // Dev server: never cache, so an edit is always the thing you reload.
    const headers = {
      'content-type': type,
      'cache-control': 'no-store, max-age=0',
      'last-modified': stat.mtime.toUTCString(),
      'accept-ranges': 'bytes',
    };

    // The SQLite database is read by byte range — the whole point is never
    // shipping the entire file — so range requests must be honoured exactly.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      let start = range[1] === '' ? null : Number(range[1]);
      let end = range[2] === '' ? null : Number(range[2]);

      if (start === null && end === null) {
        res.writeHead(416, { 'content-range': 'bytes */' + stat.size }).end();
        return;
      }
      if (start === null) {
        start = Math.max(0, stat.size - end); // suffix range: last N bytes
        end = stat.size - 1;
      } else if (end === null || end >= stat.size) {
        end = stat.size - 1;
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'content-range': 'bytes */' + stat.size }).end();
        return;
      }

      headers['content-range'] = 'bytes ' + start + '-' + end + '/' + stat.size;

      // LOG_RANGES=1 prints a running total per file. Range traffic is the
      // whole cost model of the SQLite backend, and it is invisible from the
      // page — the reads happen inside a worker, where neither the resource
      // timeline nor devtools' network list shows them.
      if (process.env.LOG_RANGES) {
        const name = path.basename(file);
        rangeBytes[name] = (rangeBytes[name] || 0) + (end - start + 1);
        rangeCount[name] = (rangeCount[name] || 0) + 1;
        // The offset matters as much as the size: a page number maps back to
        // a table or index via `dbstat`, which is how a read-ahead ramp is
        // traced to the query that caused it. The divisor has to be the
        // database's real page size, not a fixed 1 KiB — the build moved to
        // 4096-byte pages, which silently made every offset printed here four
        // times too large, and so pointed at pages past the end of the file.
        const pageSize = dbPageSize(file);
        console.log(
          '  range ' + name + '  ' + String(Math.round((end - start + 1) / 1024)).padStart(5) + ' KiB' +
            '  @page ' + String(Math.floor(start / pageSize) + 1).padStart(7) +
            '   total ' + (rangeBytes[name] / 1048576).toFixed(2) + ' MB in ' + rangeCount[name] + ' requests'
        );
      }
      headers['content-length'] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(file, { start: start, end: end }).pipe(res);
      return;
    }

    const compressible = /json|text|javascript|svg/.test(type);
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');

    if (compressible && acceptsGzip) {
      headers['content-encoding'] = 'gzip';
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);
    } else {
      headers['content-length'] = stat.size;
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    }
  });
});

server.listen(PORT, () => {
  const manifest = path.join(ROOT, 'data', 'manifest.json');
  if (!fs.existsSync(manifest)) {
    console.log('! No data yet — run `npm run import` first.\n');
  }
  console.log('Book metadata site → http://localhost:' + PORT + '\n');
});

function argValue(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : process.argv[at + 1];
}
