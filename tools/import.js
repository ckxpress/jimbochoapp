#!/usr/bin/env node
'use strict';

/**
 * Dataset importer.
 *
 *   node tools/import.js                       import every dataset in datasets.json
 *   node tools/import.js hkpl-2025             import one dataset by id
 *   node tools/import.js --refresh             ignore the download cache
 *   node tools/import.js --list                show what is registered / imported
 *   node tools/import.js --add-hkpl-year 2026  register + import another HK catalogue year
 *   node tools/import.js --add-ncl-year 2026   register + import a Taiwan NCL year
 *   node tools/import.js --add-openlibrary-hk  register + import pre-2017 HK from Open Library
 *   node tools/import.js --file books.csv --id my-shelf --title "My shelf"
 *   node tools/import.js --url https://host/books.csv --id x --title "X" [--adapter generic-csv]
 *
 * Ad-hoc --file/--url imports are written back into datasets.json so they
 * re-import next time; pass --no-save to keep them out of the registry.
 */

const fs = require('fs');
const path = require('path');

const { download, decode } = require('./lib/fetch');

const ROOT = path.join(__dirname, '..');
const REGISTRY = path.join(ROOT, 'datasets.json');
const DATA_DIR = path.join(ROOT, 'site', 'data');
const SHARD_SIZE = 3000;

/** The earliest month isbn.ncl.edu.tw still serves. Probed, not documented. */
const NCL_FIRST_YEAR = 2024;

/** Editions per Open Library query.json page. */
const OL_PAGE = 500;

const ADAPTERS = {
  'hkpl-bro': require('./adapters/hkpl-bro'),
  'ncl-isbn': require('./adapters/ncl-isbn'),
  'openlibrary-editions': require('./adapters/openlibrary-editions'),
  'ncl-nbinet': require('./adapters/ncl-nbinet'),
  'ncl-holdings': require('./adapters/ncl-holdings'),
  '3ook': require('./adapters/3ook'),
  'generic-csv': require('./adapters/generic-csv'),
  json: require('./adapters/json'),
};

main().catch((err) => {
  console.error('\n✗ ' + err.message);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.help) return usage();

  const registry = readRegistry();

  if (args.flags.list) return list(registry);

  if (args.options.remove) {
    return removeDataset(registry, args.options.remove);
  }

  if (args.options['add-hkpl-year']) {
    const dataset = hkplYearDataset(args.options['add-hkpl-year']);
    upsertDataset(registry, dataset);
    writeRegistry(registry);
    console.log('Registered dataset "' + dataset.id + '" in datasets.json');
    return importDatasets(registry, [dataset.id], args);
  }

  if (args.options['add-ncl-year']) {
    const dataset = await nclYearDataset(args.options['add-ncl-year']);
    upsertDataset(registry, dataset);
    writeRegistry(registry);
    console.log('Registered dataset "' + dataset.id + '" in datasets.json');
    return importDatasets(registry, [dataset.id], args);
  }

  if (args.flags['add-openlibrary-hk']) {
    const dataset = await openLibraryHkDataset();
    upsertDataset(registry, dataset);
    writeRegistry(registry);
    console.log('Registered dataset "' + dataset.id + '" in datasets.json');
    return importDatasets(registry, [dataset.id], args);
  }

  if (args.options.file || args.options.url) {
    const dataset = adHocDataset(args);
    if (!args.flags['no-save']) {
      upsertDataset(registry, dataset);
      writeRegistry(registry);
      console.log('Registered dataset "' + dataset.id + '" in datasets.json');
    } else {
      registry.datasets.push(dataset);
    }
    return importDatasets(registry, [dataset.id], args);
  }

  const ids = args.positional.length ? args.positional : registry.datasets.map((d) => d.id);
  if (!ids.length) throw new Error('No datasets registered. See `node tools/import.js --help`.');
  return importDatasets(registry, ids, args);
}

async function importDatasets(registry, ids, args) {
  const manifest = readManifest();

  for (const id of ids) {
    const dataset = registry.datasets.find((d) => d.id === id);
    if (!dataset) throw new Error('Unknown dataset id "' + id + '". Try --list.');
    const summary = await importDataset(dataset, args);
    const at = manifest.datasets.findIndex((d) => d.id === summary.id);
    if (at === -1) manifest.datasets.push(summary);
    else manifest.datasets[at] = summary;
  }

  manifest.datasets.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  manifest.generatedAt = new Date().toISOString();
  manifest.totalBooks = manifest.datasets.reduce((n, d) => n + d.count, 0);
  writeManifest(manifest);

  console.log(
    '\n✓ ' +
      manifest.totalBooks.toLocaleString('en-US') +
      ' books across ' +
      manifest.datasets.length +
      ' dataset(s) → site/data/'
  );
  console.log('  Run `npm start` and open the site.');
}

async function importDataset(dataset, args) {
  const adapter = ADAPTERS[dataset.adapter];
  if (!adapter) {
    throw new Error(
      'Unknown adapter "' + dataset.adapter + '". Available: ' + Object.keys(ADAPTERS).join(', ')
    );
  }

  console.log('\n▸ ' + dataset.id + '  (' + dataset.title + ')');

  const records = [];
  const sourceSummaries = [];
  const seen = new Map();

  for (let s = 0; s < dataset.sources.length; s++) {
    const source = dataset.sources[s];
    let text;
    try {
      text = await readSource(source, args.flags.refresh);
    } catch (err) {
      // The current year is published a quarter at a time, so the later
      // quarters legitimately do not exist yet. Only a missing file is
      // skipped; anything else still stops the import.
      if (/HTTP 404/.test(err.message)) {
        // A missing file means two very different things. A period that has
        // not ended yet simply is not out. A period long past is not coming:
        // both archives only reach back so far — HKPL to 2017 Q1, the NCL to
        // 2024-01 — and saying "not published yet" about 2018 reads as "try
        // again later", which is wrong.
        console.log(
          '  ' + pad(source.label || source.url, 26) + '   ' + missingReason(source) + ' — skipped'
        );
        continue;
      }
      throw err;
    }
    let parsed;
    try {
      parsed = adapter.parse({ text: text, source: source, dataset: dataset, datasetId: dataset.id });
    } catch (err) {
      throw new Error('Failed parsing ' + (source.label || source.url || source.file) + ': ' + err.message);
    }

    const kept = parsed.filter((r) => r.title);
    for (const rec of kept) {
      // A source that lists the same record twice — Open Library returns an
      // edition once per spelling of its place — asks for it to be dropped by a
      // field it can be identified by, rather than kept as a second copy.
      if (dataset.dedupeBy && rec[dataset.dedupeBy] && seen.has(rec.id)) {
        seen.set(rec.id, (seen.get(rec.id) || 0) + 1);
        continue;
      }
      // Ids must be unique across the whole dataset; the odd upstream row has
      // a blank reference number.
      const count = (seen.get(rec.id) || 0) + 1;
      seen.set(rec.id, count);
      if (count > 1) rec.id = rec.id + '-' + count;
      rec.source = compactSource(source);
      rec.sourceIndex = s;
      records.push(rec);
    }

    console.log(
      '  ' +
        pad(source.label || source.url || source.file, 26) +
        String(kept.length).padStart(6) +
        ' records' +
        (parsed.length !== kept.length ? '  (' + (parsed.length - kept.length) + ' skipped: no title)' : '')
    );
    sourceSummaries.push({
      label: source.label || '',
      url: source.url || '',
      file: source.file || '',
      quarter: source.quarter || '',
      language: source.language || '',
      count: kept.length,
    });
  }

  records.sort(byTitle);

  const files = writeShards(dataset.id, records);

  return {
    id: dataset.id,
    title: dataset.title,
    shortTitle: dataset.shortTitle || dataset.title,
    description: dataset.description || '',
    provider: dataset.provider || '',
    homepage: dataset.homepage || '',
    dataDictionary: dataset.dataDictionary || '',
    license: dataset.license || '',
    licenseUrl: dataset.licenseUrl || '',
    region: dataset.region || '',
    year: dataset.year || null,
    adapter: dataset.adapter,
    count: records.length,
    files: files,
    sources: sourceSummaries,
    stats: statsFor(records),
    importedAt: new Date().toISOString(),
  };
}

async function readSource(source, refresh) {
  if (source.file) {
    const file = path.isAbsolute(source.file) ? source.file : path.join(ROOT, source.file);
    if (!fs.existsSync(file)) throw new Error('File not found: ' + file);
    return decode(fs.readFileSync(file), source.file);
  }
  if (!source.url) throw new Error('Source has neither `url` nor `file`');

  // HKPL has renamed and moved these files over the years, so a source may
  // carry alternates. The first that is actually there wins; only if every
  // one 404s does the quarter count as missing.
  const candidates = [source.url].concat(source.altUrls || []);
  let last;
  for (const url of candidates) {
    try {
      const res = await download(url, { refresh: refresh });
      return decode(res.body, url);
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) throw err;
      last = err;
    }
  }
  throw last;
}

/**
 * Two tiers, sharded in the same order so a record's position in the index
 * gives its position in the full data:
 *   <id>.index.<n>.json  slim rows — browsing, searching, filtering
 *   <id>.full.<n>.json   every field — fetched only when a book is opened
 * That keeps the up-front download to a fraction of the complete metadata.
 */
function writeShards(datasetId, records) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  for (const name of fs.readdirSync(DATA_DIR)) {
    if (name.startsWith(datasetId + '.') && name.endsWith('.json')) {
      fs.unlinkSync(path.join(DATA_DIR, name));
    }
  }

  const files = { index: [], full: [], shardSize: SHARD_SIZE };
  const shardCount = Math.max(1, Math.ceil(records.length / SHARD_SIZE));

  for (let i = 0; i < shardCount; i++) {
    const slice = records.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);

    const indexName = datasetId + '.index.' + i + '.json';
    fs.writeFileSync(path.join(DATA_DIR, indexName), JSON.stringify(slice.map(toIndexRow)));
    files.index.push(indexName);

    slice.forEach((rec) => delete rec.sourceIndex); // bookkeeping, not metadata

    const fullName = datasetId + '.full.' + i + '.json';
    fs.writeFileSync(path.join(DATA_DIR, fullName), JSON.stringify(slice));
    files.full.push(fullName);
  }

  return files;
}

/** The fields the browse/search grid needs. Everything else waits for the detail view. */
function toIndexRow(rec) {
  const row = {
    id: rec.id,
    title: rec.title,
    // Many English-catalogue records carry the Chinese form of the title here
    // ("... = 葉智榮"). The site leads with it, so the grid needs it too.
    parallelTitle: rec.parallelTitle || '',
    subtitle: rec.subtitle || '',
    authors: (rec.authors || []).map((a) => a.display || a.name),
    publisher: rec.publisher || '',
    year: rec.year || null,
    isbn: rec.isbn || '',
    classification: rec.classification || '',
    language: rec.language || '',
    series: rec.series ? rec.series.title : '',
    ref: rec.ref || '',
    src: rec.sourceIndex || 0,
  };
  if (rec.cover && rec.cover.url) row.cover = rec.cover.url;
  if (rec.price) {
    if (typeof rec.price.amount === 'number') {
      row.price = rec.price.amount;
      row.currency = rec.price.currency || '';
    }
    if (typeof rec.price.forSale === 'boolean') row.forSale = rec.price.forSale;
  }
  for (const key of Object.keys(row)) {
    if (row[key] === '' || row[key] === null || (Array.isArray(row[key]) && !row[key].length)) delete row[key];
  }
  return row;
}

function statsFor(records) {
  const classifications = new Map();
  const publishers = new Map();
  const languages = new Map();
  let withIsbn = 0;
  let minYear = null;
  let maxYear = null;

  for (const rec of records) {
    if (rec.isbn) withIsbn++;
    if (rec.classification) bump(classifications, rec.classification);
    if (rec.publisher) bump(publishers, rec.publisher);
    if (rec.language) bump(languages, rec.language);
    if (rec.year) {
      if (minYear === null || rec.year < minYear) minYear = rec.year;
      if (maxYear === null || rec.year > maxYear) maxYear = rec.year;
    }
  }

  return {
    withIsbn: withIsbn,
    classifications: classifications.size,
    publishers: publishers.size,
    languages: Object.fromEntries(languages),
    yearRange: minYear === null ? null : [minYear, maxYear],
    topPublishers: top(publishers, 5),
    topClassifications: top(classifications, 8),
  };
}

function compactSource(source) {
  const out = {};
  for (const key of ['label', 'url', 'file', 'quarter', 'language']) {
    if (source[key]) out[key] = source[key];
  }
  return out;
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function top(map, n) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name: name, count: count }));
}

function byTitle(a, b) {
  return String(a.title).localeCompare(String(b.title), 'zh-Hant', { numeric: true });
}

/* ---------- dataset definitions ---------- */

/** True once the quarter ("2019 Q1") is over, so a missing file is final. */
/**
 * Why a file is not there, which is two quite different things. A period that
 * has not ended, or ended recently, simply is not out: both publishers lag,
 * the NCL by a month or more. A period long past is not coming — the archives
 * only reach back so far, HKPL to 2017 Q1 and the NCL to 2024-01 — and saying
 * "not published yet" about 2018 reads as "try again later", which is wrong.
 */
function missingReason(source) {
  const ended = periodEndedAt(source.quarter || source.period);
  if (ended === null) return 'not available';
  const LAG_DAYS = 75;
  const settled = ended + LAG_DAYS * 86400000 < Date.now();
  return settled ? 'not in the archive' : 'not published yet';
}

/**
 * When the period this source covers ended, in epoch milliseconds, or null if
 * the label says nothing. "2025 Q3" for the quarterly Hong Kong catalogue,
 * "2026-01" for the monthly Taiwan one.
 */
function periodEndedAt(label) {
  const text = String(label || '');

  const quarter = /^(\d{4}) Q([1-4])$/.exec(text);
  if (quarter) return Date.UTC(Number(quarter[1]), Number(quarter[2]) * 3, 1);

  const month = /^(\d{4})-(\d{2})$/.exec(text);
  if (month) return Date.UTC(Number(month[1]), Number(month[2]), 1);

  return null;
}

function hkplYearDataset(yearArg) {
  const year = Number(String(yearArg).trim());
  if (!/^\d{4}$/.test(String(year))) throw new Error('--add-hkpl-year expects a 4-digit year');

  // The same quarterly catalogue has lived at three different addresses.
  // 2020 onwards uses a four-digit year under BRO-PSI-CSV/; 2017, 2018 and
  // 2019 Q4 use a two-digit year in the same folder; 2019 Q1 to Q3 use a
  // two-digit year one level up. Rather than encode which year is which,
  // every quarter offers all three and takes whichever answers.
  const root =
    'https://www.hkpl.gov.hk/en/common/attachments/about-us/services/book-registration/';
  const yy = String(year).slice(2);
  const forms = (q, lang) => [
    root + 'BRO-PSI-CSV/catalogueHK' + year + 'Q' + q + lang + '.csv',
    root + 'BRO-PSI-CSV/catalogueHK' + yy + 'Q' + q + lang + '.csv',
    root + 'catalogueHK' + yy + 'Q' + q + lang + '.csv',
  ];

  const sources = [];
  for (let q = 1; q <= 4; q++) {
    const en = forms(q, 'e');
    const zh = forms(q, 'c');
    sources.push({
      url: en[0],
      altUrls: en.slice(1),
      label: year + ' Q' + q + ' (English)',
      language: 'en',
      quarter: year + ' Q' + q,
    });
    sources.push({
      url: zh[0],
      altUrls: zh.slice(1),
      label: year + ' Q' + q + ' (Chinese)',
      language: 'zh',
      quarter: year + ' Q' + q,
    });
  }

  return {
    id: 'hkpl-' + year,
    // Shown in a Traditional Chinese interface, so named in Chinese.
    title: '香港印刷書刊目錄 — ' + year,
    shortTitle: '香港 ' + year,
    adapter: 'hkpl-bro',
    description:
      year + '年內向香港書刊註冊組（ISBN 註冊機構）登記的全部書刊。',
    provider: '康樂及文化事務署書刊註冊組 · 香港公共圖書館',
    homepage: 'https://data.gov.hk/en-data/dataset/hk-lcsd-lib-lib-bro',
    dataDictionary:
      'https://www.hkpl.gov.hk/en/common/attachments/about-us/services/book-registration/catalogueHK_datadic_en.pdf',
    license: 'Terms of use of DATA.GOV.HK',
    licenseUrl: 'https://data.gov.hk/en/terms-and-conditions',
    region: 'Hong Kong',
    year: year,
    sources: sources,
  };
}

/**
 * 臺灣出版新書預告書訊, a year of it — the National Central Library's monthly
 * feed of ISBN applications, dataset 6730 on data.gov.tw.
 *
 * Two awkward facts shape this. The listing is a rolling twelve months, and
 * the newer months are served from www.ncl.edu.tw under opaque UUIDs that
 * cannot be derived from a date — so the addresses have to be read from the
 * catalogue rather than constructed. The older months keep a predictable name
 * on isbn.ncl.edu.tw and, usefully, stay reachable long after they drop out of
 * the listing: everything from 2024-01 is still served, nothing before it.
 *
 * So: ask the API for the months it knows, and fall back to the predictable
 * form for any month of the year it no longer lists. The resolved addresses are
 * written into datasets.json, which is what makes a re-import reproducible once
 * a month has aged out of the catalogue.
 */
async function nclYearDataset(yearArg) {
  const year = Number(String(yearArg).trim());
  if (!/^\d{4}$/.test(String(year))) throw new Error('--add-ncl-year expects a 4-digit year');
  if (year < NCL_FIRST_YEAR) {
    throw new Error(
      'The NCL feed only reaches back to ' + NCL_FIRST_YEAR + '-01; ' + year + ' is not published.'
    );
  }

  const listed = await nclListedMonths();
  const now = new Date();
  const sources = [];

  for (let month = 1; month <= 12; month++) {
    const key = year + '-' + String(month).padStart(2, '0');
    // Months that have not started yet are left out entirely, rather than
    // registered and then reported missing on every future import.
    if (Date.UTC(year, month - 1, 1) > now.getTime()) continue;

    const stamp = String(year) + String(month).padStart(2, '0');
    const predictable = 'https://isbn.ncl.edu.tw/NEW_ISBNNet/opendata/' + stamp + '_isbn.csv';
    const fromApi = listed.get(key);

    sources.push({
      url: fromApi || predictable,
      // Either address may be the live one; try both before calling it missing.
      altUrls: fromApi && fromApi !== predictable ? [predictable] : [],
      label: key,
      language: '',
      period: key,
    });
  }

  if (!sources.length) throw new Error('No months of ' + year + ' have begun yet.');

  return {
    id: 'ncl-' + year,
    title: '臺灣出版新書預告書訊 — ' + year,
    shortTitle: '臺灣 ' + year,
    adapter: 'ncl-isbn',
    description:
      year + '年各出版者向國家圖書館國際標準書號中心申請 ISBN 的新書預告書目。' +
      '資料為出版前申請紀錄，出版日為預訂日期。',
    provider: '國家圖書館 國際標準書號中心',
    homepage: 'https://data.gov.tw/dataset/6730',
    dataDictionary: 'https://isbn.ncl.edu.tw/NEW_ISBNNet/',
    license: '政府資料開放授權條款－第1版',
    licenseUrl: 'https://data.gov.tw/license',
    region: 'Taiwan',
    currency: 'TWD',
    year: year,
    sources: sources,
  };
}

/**
 * The month -> URL map the catalogue currently advertises, keyed "2026-01".
 * Descriptions carry the ROC year ("提供115年1月份…"), which is the AD year
 * less 1911. A catalogue that cannot be reached is not fatal: every month of
 * 2024 and 2025, and the earlier months of this year, have a predictable
 * address to fall back on.
 */
async function nclListedMonths() {
  const api = 'https://data.gov.tw/api/v2/rest/dataset/6730';
  const out = new Map();
  try {
    const res = await download(api, { refresh: true });
    const body = JSON.parse(res.body.toString('utf8'));
    for (const item of (body.result && body.result.distribution) || []) {
      const url = item.resourceDownloadUrl;
      const m = /(\d{2,3})年(\d{1,2})月/.exec(item.resourceDescription || '');
      if (!url || !m) continue;
      const key = Number(m[1]) + 1911 + '-' + String(Number(m[2])).padStart(2, '0');
      out.set(key, url);
    }
  } catch (err) {
    console.log('  (could not read data.gov.tw: ' + err.message + ' — using predictable URLs)');
  }
  return out;
}

/**
 * Hong Kong editions from Open Library — the pre-2017 years no registry covers.
 *
 * The one crowd-sourced source here, so it stays a dataset of its own and is
 * never merged into the registry datasets. See the adapter for why this uses
 * the older `query.json` rather than `search.json`.
 *
 * Place is free text upstream, so the same city is spelled several ways and
 * each has to be asked for separately. Sizes are probed rather than assumed:
 * the API reports no total, so the only way to know how many pages to ask for
 * is to walk the offset until it comes back empty. An edition listed under two
 * spellings arrives twice, which `dedupeBy` then drops.
 */
async function openLibraryHkDataset() {
  const places = ['Hong Kong', 'Hongkong', 'Kowloon', 'Hong Kong, China', '香港', 'Hong Kong SAR'];
  const sources = [];

  await assertOpenLibraryFilters();

  for (const place of places) {
    const depth = await openLibraryDepth(place);
    if (!depth) {
      console.log('  ' + pad(place, 22) + '   no editions — skipped');
      continue;
    }
    const pages = Math.ceil(depth / OL_PAGE) + 1; // +1 for growth since probing
    console.log('  ' + pad(place, 22) + '   about ' + depth.toLocaleString('en-US') + ' editions, ' + pages + ' pages');
    for (let i = 0; i < pages; i++) {
      sources.push({
        url: openLibraryUrl(place, i * OL_PAGE),
        label: place + ' +' + i * OL_PAGE,
        language: '',
        // query.json does not echo the field it filtered on, so the place the
        // records came from is recorded here.
        place: place,
      });
    }
  }

  if (!sources.length) throw new Error('Open Library returned no Hong Kong editions.');

  return {
    id: 'ol-hk',
    title: '香港書刊 — Open Library',
    shortTitle: 'OL 香港',
    adapter: 'openlibrary-editions',
    description:
      'Open Library 收錄的香港出版書刊（2017 年前）。此資料集由公眾協作編輯，並非官方書刊註冊紀錄，' +
      '完整度與準確度不及其他資料集：約四分之一有國際標準書號，絕大部分沒有封面。',
    provider: 'Open Library · Internet Archive',
    homepage: 'https://openlibrary.org/',
    dataDictionary: 'https://openlibrary.org/dev/docs/api/search',
    license: 'Open Data Commons Attribution License / CC0 (see openlibrary.org)',
    licenseUrl: 'https://openlibrary.org/developers/licensing',
    region: 'Hong Kong',
    crowdsourced: true,
    dedupeBy: 'ref',
    sources: sources,
  };
}

/**
 * A query.json URL for one page of one place.
 *
 * `publish_places` must NOT appear among the requested fields. In this API a
 * field is requested by naming it with an empty value, so asking for it also
 * sets it to empty — which silently clears the filter and returns arbitrary
 * editions. Asked for both ways, "Hong Kong SAR" returns 500 rows of British
 * parliamentary debates; asked for correctly, it returns its 6. The filtered
 * field is not echoed back, so the place is carried on the source instead.
 */
function openLibraryUrl(place, offset) {
  const fields = [
    'title', 'subtitle', 'by_statement', 'isbn_13', 'isbn_10', 'publishers',
    'publish_date', 'languages', 'number_of_pages',
    'pagination', 'subjects', 'series', 'edition_name', 'covers',
  ];
  const params = new URLSearchParams();
  params.set('type', '/type/edition');
  params.set('publish_places', place);
  params.set('limit', String(OL_PAGE));
  if (offset) params.set('offset', String(offset));
  for (const field of fields) params.append(field, '');
  return 'https://openlibrary.org/query.json?' + params.toString();
}

/**
 * Proves the place filter is actually being applied before importing tens of
 * thousands of records on the strength of it.
 *
 * This exists because the filter once silently stopped working and the import
 * reported success: 33,500 records, every page exactly full, not one of them
 * from Hong Kong. The tell was that a spelling with six editions returned a
 * full page, so that is what this checks — ask for the smallest spelling and
 * refuse to continue if it comes back full.
 */
async function assertOpenLibraryFilters() {
  const canary = 'Hong Kong SAR';
  const res = await download(openLibraryUrl(canary, 0), { refresh: true });
  const rows = JSON.parse(res.body.toString('utf8'));
  if (!Array.isArray(rows)) throw new Error('Open Library: expected an array from query.json');
  if (rows.length >= OL_PAGE) {
    throw new Error(
      'Open Library is ignoring the publish_places filter — "' + canary + '" returned a full page of ' +
        rows.length + ' records. Importing would fill the dataset with books from everywhere. ' +
        'Check that publish_places is not also in the requested field list.'
    );
  }
}

/**
 * Roughly how many editions a place has, by doubling the offset until the API
 * returns nothing. Coarse on purpose — it only has to decide a page count, and
 * each probe is a request against someone else's server.
 */
async function openLibraryDepth(place) {
  let reached = 0;
  let offset = 1;
  while (offset <= 65536) {
    const url = 'https://openlibrary.org/query.json?type=%2Ftype%2Fedition&publish_places=' +
      encodeURIComponent(place) + '&limit=1&offset=' + offset;
    let rows;
    try {
      const res = await download(url, { refresh: true });
      rows = JSON.parse(res.body.toString('utf8'));
    } catch (err) {
      break;
    }
    if (!Array.isArray(rows) || !rows.length) break;
    reached = offset;
    offset *= 2;
  }
  // offset 0 is the first record, so a place with any at all reaches at least 1.
  if (!reached) {
    try {
      const res = await download(openLibraryUrl(place, 0), { refresh: true });
      const rows = JSON.parse(res.body.toString('utf8'));
      return Array.isArray(rows) ? rows.length : 0;
    } catch (err) {
      return 0;
    }
  }
  return reached * 2;
}

function adHocDataset(args) {
  const target = args.options.file || args.options.url;
  const id = args.options.id || slugify(path.basename(target).replace(/\.[a-z]+$/i, ''));
  if (!id) throw new Error('Could not derive an id; pass --id');

  const adapter = args.options.adapter || (/\.json$/i.test(target) ? 'json' : 'generic-csv');

  return {
    id: id,
    title: args.options.title || id,
    shortTitle: args.options.title || id,
    adapter: adapter,
    description: args.options.description || '',
    provider: args.options.provider || '',
    currency: args.options.currency || '',
    homepage: args.options.homepage || '',
    license: args.options.license || '',
    region: args.options.region || '',
    sources: [
      args.options.file
        ? { file: args.options.file, label: args.options.label || path.basename(args.options.file), language: args.options.language || '' }
        : { url: args.options.url, label: args.options.label || args.options.url, language: args.options.language || '' },
    ],
  };
}

/** Drop a dataset from the registry, the manifest and site/data/. */
function removeDataset(registry, id) {
  const manifest = readManifest();
  const known = registry.datasets.some((d) => d.id === id) || manifest.datasets.some((d) => d.id === id);
  if (!known) throw new Error('Unknown dataset id "' + id + '". Try --list.');

  registry.datasets = registry.datasets.filter((d) => d.id !== id);
  writeRegistry(registry);

  manifest.datasets = manifest.datasets.filter((d) => d.id !== id);
  manifest.totalBooks = manifest.datasets.reduce((n, d) => n + d.count, 0);
  manifest.generatedAt = new Date().toISOString();
  writeManifest(manifest);

  let removed = 0;
  if (fs.existsSync(DATA_DIR)) {
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (name.startsWith(id + '.') && name.endsWith('.json')) {
        fs.unlinkSync(path.join(DATA_DIR, name));
        removed++;
      }
    }
  }

  console.log('Removed dataset "' + id + '" (' + removed + ' data file(s)).');
  console.log('✓ ' + manifest.totalBooks.toLocaleString('en-US') + ' books remain across ' + manifest.datasets.length + ' dataset(s)');
}

/* ---------- registry / manifest io ---------- */

function readRegistry() {
  if (!fs.existsSync(REGISTRY)) return { datasets: [] };
  const data = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  if (!Array.isArray(data.datasets)) data.datasets = [];
  return data;
}

function writeRegistry(registry) {
  fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + '\n');
}

function upsertDataset(registry, dataset) {
  const at = registry.datasets.findIndex((d) => d.id === dataset.id);
  if (at === -1) registry.datasets.push(dataset);
  else registry.datasets[at] = Object.assign({}, registry.datasets[at], dataset);
}

function readManifest() {
  const file = path.join(DATA_DIR, 'manifest.json');
  if (!fs.existsSync(file)) return { generatedAt: null, totalBooks: 0, datasets: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.datasets)) data.datasets = [];
    return data;
  } catch (err) {
    return { generatedAt: null, totalBooks: 0, datasets: [] };
  }
}

function writeManifest(manifest) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

/* ---------- cli helpers ---------- */

function list(registry) {
  const manifest = readManifest();
  console.log('\nRegistered datasets (datasets.json)\n');
  if (!registry.datasets.length) console.log('  (none)');
  for (const d of registry.datasets) {
    const imported = manifest.datasets.find((m) => m.id === d.id);
    console.log('  ' + pad(d.id, 18) + pad(d.adapter, 14) + pad(d.sources.length + ' source(s)', 14) +
      (imported ? imported.count.toLocaleString('en-US') + ' books imported' : 'not imported yet'));
  }
  console.log('\nAdapters: ' + Object.keys(ADAPTERS).join(', ') + '\n');
}

function usage() {
  console.log(
    [
      '',
      'Import book datasets into site/data/.',
      '',
      '  node tools/import.js                       import every dataset in datasets.json',
      '  node tools/import.js <id> [<id>...]        import specific datasets',
      '  node tools/import.js --list                show registered / imported datasets',
      '  node tools/import.js --refresh             re-download instead of using cache/',
      '  node tools/import.js --remove <id>         delete a dataset and its data files',
      '',
      'Add more data:',
      '  node tools/import.js --add-hkpl-year 2026',
      '  node tools/import.js --add-ncl-year 2026',
      '  node tools/import.js --add-openlibrary-hk',
      '  node tools/import.js --file books.csv  --id my-shelf --title "My shelf"',
      '  node tools/import.js --url  https://host/books.json --id x --title "X"',
      '',
      'Options: --adapter <' + Object.keys(ADAPTERS).join('|') + '> --title --description --provider',
      '         --homepage --license --region --language --label --currency --no-save',
      '',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const out = { positional: [], options: {}, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.options[name] = next;
        i++;
      } else {
        out.flags[name] = true;
      }
    } else if (arg === '-h') {
      out.flags.help = true;
    } else {
      out.positional.push(arg);
    }
  }
  if (out.flags.all) out.positional = [];
  return out;
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pad(text, width) {
  const s = String(text === undefined ? '' : text);
  return s.length >= width ? s.slice(0, width - 1) + ' ' : s + ' '.repeat(width - s.length);
}
