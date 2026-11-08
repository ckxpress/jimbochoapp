-- Applied on every import run, before the data chunks, and safe to repeat.
--
-- schema.sql drops and recreates everything, which is right for a fresh
-- database and useless for one that already holds 446,090 rows. When a later
-- change adds a table, this is where it goes: additive, idempotent, and run
-- whether or not the original schema step was recorded as applied.
CREATE TABLE IF NOT EXISTS facet_counts (scope TEXT, facet TEXT, value TEXT, n INTEGER);
