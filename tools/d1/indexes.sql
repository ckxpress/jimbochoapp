-- Run after the data is in: building these up front would make every INSERT
-- maintain them, over an import that already takes many round trips.
--
-- Every index here is (filter column, cover = '', zh_first, title_display),
-- which is not decoration. The browse ORDER BY is
--   ORDER BY b.cover = '', b.zh_first, b.title_display
-- and an index that stops at (filter, zh_first, title_display) cannot satisfy
-- it, so SQLite builds a temp b-tree — which means reading every matching row
-- before returning the first eighteen. On 語言=中文 that is 348,946 rows for
-- one page of results. Carrying the cover expression costs about a byte a row
-- and removes the sort.
DROP INDEX IF EXISTS idx_publisher;
DROP INDEX IF EXISTS idx_classification;
DROP INDEX IF EXISTS idx_year;
DROP INDEX IF EXISTS idx_language;

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
CREATE INDEX IF NOT EXISTS idx_facet_value ON facet_counts(scope, facet, value);
