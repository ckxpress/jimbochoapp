-- Run after the data is in: building these up front would make every INSERT
-- maintain them, over an import that already takes many round trips.
--
-- Far fewer than the file-over-HTTP build needs. There the ORDER BY had to be
-- satisfied by an index or SQLite built a temp b-tree and dragged the whole
-- table across the network a page at a time; here the query runs beside the
-- data, so only the selective lookups are worth indexing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_id ON books(id);
CREATE INDEX IF NOT EXISTS idx_isbn ON books(isbn);
CREATE INDEX IF NOT EXISTS idx_publisher ON books(publisher, zh_first, title_display);
CREATE INDEX IF NOT EXISTS idx_classification ON books(classification, zh_first, title_display);
CREATE INDEX IF NOT EXISTS idx_year ON books(year, zh_first, title_display);
CREATE INDEX IF NOT EXISTS idx_language ON books(language, zh_first, title_display);
CREATE INDEX IF NOT EXISTS idx_dataset ON books(dataset, src);
CREATE INDEX IF NOT EXISTS idx_browse ON books(cover = '', zh_first, title_display);
CREATE INDEX IF NOT EXISTS idx_facet ON facet_counts(scope, facet, n DESC);
