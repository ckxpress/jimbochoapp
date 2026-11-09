-- Without this SQLite has no statistics, assumes every indexed lookup yields
-- about ten rows, and so picks whichever usable index it meets first. For
--   WHERE language IN ('zh') AND publisher IN ('一步工作室','三本設計製造')
-- it picked language: 348,946 index entries read to return 4 rows, and the
-- same again for the page query. With statistics it picks publisher and reads
-- 4. This one statement is the difference between a request costing ~700,000
-- row reads and costing ~20 — on a free tier that allows 5,000,000 a day.
ANALYZE;
