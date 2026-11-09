-- Run after the data is in: building these up front would make every INSERT
-- maintain them, over an import that already takes many round trips.
--
-- Every browse index is (filter column, cover = '', zh_first, title_display),
-- which is not decoration. The browse ORDER BY is
--   ORDER BY b.cover = '', b.zh_first, b.title_display
-- and an index that stops at (filter, zh_first, title_display) cannot satisfy
-- it, so SQLite builds a temp b-tree — which means reading every matching row
-- before it can return the first eighteen. 語言=中文 + 出版年份=2024 measured
-- 185,000 rows read for one page that way, and 18 with the expression in the
-- index. It costs about a byte a row.
--
-- CREATE IF NOT EXISTS only, and no DROP: this file runs on every import, and
-- a DROP here would rebuild 446,090 index entries each time — see reindex.sh
-- for the one-time migration off the older index set.
CREATE UNIQUE INDEX IF NOT EXISTS idx_id ON books(id);
CREATE INDEX IF NOT EXISTS idx_isbn ON books(isbn);
CREATE INDEX IF NOT EXISTS idx_browse ON books(cover = '', zh_first, title_display);
CREATE INDEX IF NOT EXISTS idx_browse_publisher ON books(publisher, cover = '', zh_first, title_display);
CREATE INDEX IF NOT EXISTS idx_browse_class ON books(classification, cover = '', zh_first, title_display);
CREATE INDEX IF NOT EXISTS idx_browse_year ON books(year, cover = '', zh_first, title_display);
CREATE INDEX IF NOT EXISTS idx_browse_lang ON books(language, cover = '', zh_first, title_display);
CREATE INDEX IF NOT EXISTS idx_browse_dataset ON books(dataset, cover = '', zh_first, title_display);
CREATE INDEX IF NOT EXISTS idx_dataset ON books(dataset, src);
CREATE INDEX IF NOT EXISTS idx_facet ON facet_counts(scope, facet, n DESC);
-- count() looks facet_counts up by exact value, not by rank.
CREATE INDEX IF NOT EXISTS idx_facet_value ON facet_counts(scope, facet, value);
