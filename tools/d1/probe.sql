-- Sets up the go/no-go probe. The SELECT is NOT here: `wrangler d1 execute
-- --file` runs through D1's import path, which reports how many queries ran
-- and how many rows they touched but throws the rows away. Ask the question
-- with --command instead, which prints a table. See docs/d1-migration.md.
--
--  1. Is FTS5 available at all? CREATE VIRTUAL TABLE settles it.
--  2. Does bm25() still normalise by document length? Measured here, an index
--     built without its %_docsize shadow table runs bm25 but returns 2
--     distinct scores across 9,708 matches where a normal index returns 58,
--     and ORDER BY bm25 collapses to insertion order.
--  3. Do the site's pre-computed bigrams work as plain unicode61 tokens?
--
-- Rows 1 and 2 both match; row 2 repeats 文學 and carries more tokens, so
-- with working normalisation it must score differently from row 1. Row 3
-- must not match at all.
DROP TABLE IF EXISTS probe;
CREATE VIRTUAL TABLE probe USING fts5(search, content='', tokenize="unicode61 remove_diacritics 2");
INSERT INTO probe(rowid, search) VALUES (1, '香港 港文 文學');
INSERT INTO probe(rowid, search) VALUES (2, '香港 港文 文學 文學 文學 研究 究所');
INSERT INTO probe(rowid, search) VALUES (3, '台灣 灣文 文學');
