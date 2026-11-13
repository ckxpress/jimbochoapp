#!/bin/sh
# Applies the delta from `node tools/d1/sync.js` to a D1 database.
#
# The incremental path. A full re-import is 4,748,153 writes against a free
# plan that allows 100,000 a day; a rebuild that changed nothing plans zero,
# and a month's worth of new records measured 94,690 — one day's allowance.
#
# Resumable, and every chunk is written so that re-running it is harmless:
# INSERT OR REPLACE on books, and each FTS insert preceded by a delete of the
# same rowid. A chunk that half-applies is the normal failure over this many
# round trips, and the answer is to run it again.
#
# Requires books_fts to have been rebuilt with contentless_delete=1 first —
# see tools/d1/fts-migrate.sh. Without it every FTS delete here fails with
# "cannot DELETE from contentless fts5 table".
#
# POSIX sh: CI runs /bin/sh as dash.
#
# Usage: sh tools/d1/sync.sh <database-name>
set -eu

DB_NAME="${1:-}"
[ -n "$DB_NAME" ] || { echo "usage: sh tools/d1/sync.sh <database-name>" >&2; exit 2; }

DIR="build/d1/sync"
DONE="$DIR/.applied"
[ -f "$DIR/plan.json" ] || {
  echo "No $DIR/plan.json — run: node tools/d1/sync.js $DB_NAME" >&2
  exit 1
}

# The index must be able to delete by rowid, or every update and removal below
# fails. Checked once, here, rather than discovered a hundred chunks in.
echo "Checking the search index can delete by rowid…"
if ! npx wrangler d1 execute "$DB_NAME" --remote --yes --json --command \
  "SELECT sql FROM sqlite_master WHERE name = 'books_fts';" | grep -q contentless_delete
then
  echo "✗ books_fts was not built with contentless_delete=1." >&2
  echo "  Run tools/d1/fts-migrate.sh first; see the note at the top of" >&2
  echo "  tools/d1/fts-migrate.js for why deleting without it is unsafe." >&2
  exit 1
fi
echo "  ✓"

touch "$DONE"

applied() { grep -Fxq "$1" "$DONE" 2>/dev/null; }

# Per chunk, not cumulative: the loop below runs inside a pipeline, so a
# running total would be added up in a subshell and print zero at the end.
run() {
  f=$1
  if applied "$f"; then
    echo "  · $f (already applied)"
    return 0
  fi
  printf '  → %-22s' "$f"
  out=$(npx wrangler d1 execute "$DB_NAME" --remote --yes --json --file="$DIR/$f")
  printf '%s' "$out" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        let read = 0, written = 0;
        for (const r of (Array.isArray(j) ? j : [j])) {
          const m = r.meta || {};
          read += m.rows_read || 0;
          written += m.rows_written || 0;
        }
        console.log("read " + read + "  written " + written);
      } catch (e) { console.log("(could not read meta)"); }
    });
  '
  echo "$f" >> "$DONE"
}

echo
node -e '
  const p = require("./build/d1/sync/plan.json");
  console.log("Plan from " + p.builtAt);
  console.log("  books: +" + p.books.inserted + " ~" + p.books.updated + " -" + p.books.deleted +
              ", facet counts: " + p.facets.changed + " changed, " + p.facets.removed + " removed");
  console.log("  estimated " + p.estimatedWrites.toLocaleString("en-US") + " writes");
'
echo

node -e '
  const p = require("./build/d1/sync/plan.json");
  for (const c of p.chunks) console.log(c.file);
' | while IFS= read -r f; do
  [ -n "$f" ] && run "$f"
done

echo
echo "Verifying…"
npx wrangler d1 execute "$DB_NAME" --remote --yes --command \
  "SELECT (SELECT COUNT(*) FROM books) AS books, (SELECT COUNT(*) FROM books_fts) AS fts;"
echo
echo "Both counts should be equal, and should match the build:"
node -e 'console.log("  " + require("./build/d1/sync/plan.json").chunks.length + " chunks; build has " + require("child_process").execFileSync("sqlite3", ["site/data/books.db", "SELECT COUNT(*) FROM books;"]).toString().trim() + " books.")'
echo
echo "Statistics are a snapshot of the data, so they are refreshed too:"
echo "  npx wrangler d1 execute $DB_NAME --remote --yes --file=build/d1/stats.sql"
