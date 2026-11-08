-- Does D1 do what this migration assumes? Three questions, one file.
--
--  1. Is FTS5 available? Cloudflare's docs say yes; a third-party post says
--     no. CREATE VIRTUAL TABLE settles it.
--  2. Does bm25() rank? Measured locally, an FTS5 index built without its
--     %_docsize shadow table still runs bm25 but returns 2 distinct scores
--     across 9,708 matches instead of 58 — ORDER BY bm25 then degenerates to
--     insertion order and search becomes useless. If D1's build differs from
--     a stock one, this is where it shows.
--  3. Do pre-computed bigrams work as plain tokens? The site has no custom
--     tokenizer: 香港文學 is stored as the tokens 香港 港文 文學, so stock
--     unicode61 is all that is needed — if that holds here too.
--
-- Rows 1 and 2 both match. Row 2 repeats 文學, so with working length
-- normalisation it must score differently from row 1. Row 3 must not match.

DROP TABLE IF EXISTS probe;
CREATE VIRTUAL TABLE probe USING fts5(search, content='', tokenize="unicode61 remove_diacritics 2");

INSERT INTO probe(rowid, search) VALUES (1, '香港 港文 文學');
INSERT INTO probe(rowid, search) VALUES (2, '香港 港文 文學 文學 文學 研究 究所');
INSERT INTO probe(rowid, search) VALUES (3, '台灣 灣文 文學');

SELECT rowid, bm25(probe) AS score
FROM probe
WHERE probe MATCH '"香港" AND "文學"'
ORDER BY bm25(probe);

DROP TABLE probe;
