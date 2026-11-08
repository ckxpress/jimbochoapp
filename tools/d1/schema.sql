-- 神保町 search database, for Cloudflare D1.
--
-- Only what answering a query needs: the browse columns and the search index.
-- The `docs` blob — 124 MB of deflated full records — stays in R2 and is still
-- read by the book page over range requests, which costs 8 requests and about
-- a second. Leaving it out keeps this under D1's 500 MB free-tier ceiling with
-- room for the catalogue to grow.
--
-- The schema mirrors tools/build-sqlite.js so the same SQL answers both, and
-- so the client's mapSqlRow() needs no new shape.

DROP TABLE IF EXISTS books_fts;
DROP TABLE IF EXISTS books;

CREATE TABLE books (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  dataset TEXT,
  title TEXT,
  parallel_title TEXT,
  title_display TEXT,
  zh_first INTEGER,
  subtitle TEXT,
  authors TEXT,
  publisher TEXT,
  year INTEGER,
  isbn TEXT,
  classification TEXT,
  language TEXT,
  series TEXT,
  ref TEXT,
  src INTEGER,
  price REAL,
  currency TEXT,
  forsale INTEGER,
  cover TEXT
);

-- Contentless, holding pre-computed overlapping bigrams — see site/tokenize.js.
-- Chinese has no spaces, so a word tokenizer indexes a whole title as one token
-- and 香港 matches nothing; trigram needs three characters and fails the very
-- common two-character query. Because the bigrams are computed before they are
-- stored, this needs no custom tokenizer and is portable to D1 unchanged.
CREATE VIRTUAL TABLE books_fts USING fts5(
  search, content='', tokenize="unicode61 remove_diacritics 2"
);
