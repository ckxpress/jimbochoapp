-- The first index set stopped at (column, zh_first, title_display) and so
-- could not satisfy the browse ORDER BY, which begins with `cover = ''`.
-- The idx_browse_* indexes in indexes.sql supersede these four; dropping them
-- returns roughly 90 MB, which matters against a 500 MB database limit.
--
-- Run once, after the replacements exist. Dropping first would leave every
-- filtered query without an index at all in between.
DROP INDEX IF EXISTS idx_publisher;
DROP INDEX IF EXISTS idx_classification;
DROP INDEX IF EXISTS idx_year;
DROP INDEX IF EXISTS idx_language;
