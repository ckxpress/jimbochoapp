#!/bin/sh
# Applies the rebuilt search index from `node tools/d1/fts-migrate.js`.
#
# One-time, and the only expensive step in the incremental scheme: 446,090
# inserts, about four and a half days of the free write allowance, against the
# 4,748,153 writes a full re-import costs. Resumable, so it can be spread
# across days — and until the final chunk swaps the tables, search keeps
# answering from the old index and readers see nothing.
#
# Why it has to happen at all is at the top of tools/d1/fts-migrate.js: a
# contentless FTS5 table cannot delete a row without the exact text it indexed,
# and getting that text wrong is accepted silently, passes integrity-check,
# and leaves search returning rows that no longer contain the term.
#
# Usage: sh tools/d1/fts-migrate.sh <database-name>
set -eu

DB_NAME="${1:-}"
[ -n "$DB_NAME" ] || { echo "usage: sh tools/d1/fts-migrate.sh <database-name>" >&2; exit 2; }

DIR="build/d1/fts"
DONE="$DIR/.applied"
[ -f "$DIR/chunks.json" ] || {
  echo "No $DIR/chunks.json — run: node tools/d1/fts-migrate.js $DB_NAME" >&2
  exit 1
}
touch "$DONE"

applied() { grep -Fxq "$1" "$DONE" 2>/dev/null; }

run() {
  f=$1
  if applied "$f"; then return 0; fi
  npx wrangler d1 execute "$DB_NAME" --remote --yes --file="$DIR/$f" >/dev/null
  echo "$f" >> "$DONE"
}

TOTAL=$(node -e 'console.log(require("./build/d1/fts/chunks.json").chunks.length)')
echo "Rebuilding the search index: $TOTAL chunks."
echo "Stop whenever you like — re-running resumes, and the tables are not"
echo "swapped until the last chunk, so search is unaffected until then."
echo

n=0
node -e '
  for (const c of require("./build/d1/fts/chunks.json").chunks) console.log(c.file);
' | while IFS= read -r f; do
  [ -z "$f" ] && continue
  n=$((n + 1))
  if applied "$f"; then
    printf '  %s/%s %s (done)\r' "$n" "$TOTAL" "$f"
  else
    printf '  %s/%s %s\r' "$n" "$TOTAL" "$f"
    run "$f"
  fi
done
echo
echo
echo "Verifying…"
npx wrangler d1 execute "$DB_NAME" --remote --yes --command \
  "SELECT (SELECT COUNT(*) FROM books) AS books, (SELECT COUNT(*) FROM books_fts) AS fts,
          (SELECT sql LIKE '%contentless_delete%' FROM sqlite_master WHERE name = 'books_fts') AS deletable;"
echo
echo "books and fts should be equal, and deletable should be 1."
