#!/bin/sh
# Applies the chunks from `node tools/build-d1.js` to a D1 database.
#
# Resumable, because a remote D1 import of this size will not survive its
# first run: people report 504s partway through, with the rows partly landed
# and the retry failing on constraints. Each chunk that succeeds is recorded,
# and a re-run skips it.
#
# That record is not a nicety for books_fts, it is required. A contentless
# FTS5 table has no stored text to match an existing row against, so applying
# a chunk twice indexes every document in it a second time — no error, no
# constraint, just every bm25 score silently wrong afterwards.
#
# POSIX sh on purpose: CI here runs /bin/sh as dash, where the bashisms that
# work on macOS do not. This script has been bitten by that before.
#
# Usage: sh tools/d1/import.sh <database-name> [--local]
set -eu

DB_NAME="${1:-}"
[ -n "$DB_NAME" ] || { echo "usage: sh tools/d1/import.sh <database-name> [--local]" >&2; exit 2; }
shift
REMOTE="--remote"
for a in "$@"; do [ "$a" = "--local" ] && REMOTE="--local"; done

DIR="build/d1"
DONE="$DIR/.applied"
[ -f "$DIR/chunks.json" ] || { echo "No $DIR/chunks.json — run: node tools/build-d1.js" >&2; exit 1; }
: > "$DONE" 2>/dev/null || true
touch "$DONE"

run() {
  echo "  → $1"
  npx wrangler d1 execute "$DB_NAME" $REMOTE --yes --file="$1"
}

applied() {
  grep -Fxq "$1" "$DONE" 2>/dev/null
}

# Schema first. Dropping and recreating is deliberate: a half-finished import
# left behind by a timeout is not a base to add rows to, and the only way to
# clear a contentless FTS5 table reliably is to drop it.
if ! applied "schema"; then
  echo "Schema…"
  run tools/d1/schema.sql
  echo "schema" >> "$DONE"
fi

# Additive schema changes, every run. A database imported before a table
# existed would otherwise never get it: "schema" is recorded as applied and
# never revisited.
echo "Migrations…"
run tools/d1/migrate.sql

echo "Data…"
# Chunk filenames, in the order build-d1.js wrote them.
node -e '
  const m = require("./build/d1/chunks.json");
  for (const c of m.chunks) console.log(c.file);
' | while IFS= read -r f; do
  if applied "$f"; then
    echo "  · $f (already applied)"
    continue
  fi
  run "$DIR/$f"
  echo "$f" >> "$DONE"
done

# Indexes last: building them first would make every INSERT above maintain
# them, across an import that is already many round trips. Run every time and
# not recorded — they are CREATE INDEX IF NOT EXISTS, so repeating is free and
# a later addition is not missed because an earlier run claimed "indexes".
echo "Indexes…"
run tools/d1/indexes.sql

# Statistics, every run and not recorded: the file is 16 INSERTs into
# sqlite_stat1, so repeating it is 16 writes and keeping it current is the
# whole point.
#
# These are shipped rather than computed here. Running ANALYZE on D1 measured
# 7,807,450 rows read in one statement against a free-plan allowance of
# 5,000,000 a day, so a fresh import could not finish inside one day's quota.
# build-d1.js runs the same ANALYZE on the built database, where it takes 0.66
# seconds and costs nothing, and writes the result out; see emitStats() there
# for the measurements, including why PRAGMA analysis_limit was rejected.
#
# After the data and the indexes, because a stat row names an index that has
# to exist first.
if [ -f "$DIR/stats.sql" ]; then
  echo "Statistics…"
  if ! run "$DIR/stats.sql"; then
    echo "  ! Applying statistics failed. The import is fine, but the planner" >&2
    echo "    has none, and multi-filter queries will read far more rows than" >&2
    echo "    they need to — one measured 2,793,926 for a single page view." >&2
    echo "    Re-run this script; it skips the chunks already applied." >&2
  fi
else
  echo "  ! No $DIR/stats.sql — this build predates shipped statistics." >&2
  echo "    Re-run \`node tools/build-d1.js\` to generate it. Falling back to" >&2
  echo "    tools/d1/analyze.sql means 7.8M row reads, over a day's free quota." >&2
fi

echo
echo "Verifying…"
npx wrangler d1 execute "$DB_NAME" $REMOTE --yes --command \
  "SELECT (SELECT COUNT(*) FROM books) AS books, (SELECT COUNT(*) FROM books_fts) AS fts;"
echo
echo "Both counts should equal $(node -e 'console.log(require("./build/d1/chunks.json").rows)')."
echo "If fts is larger, a chunk was applied twice — drop books_fts and re-import it."
