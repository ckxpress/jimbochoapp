#!/bin/sh
# One-time index migration for a D1 that was imported before the browse
# indexes carried the ORDER BY's leading `cover = ''` expression.
#
# Why it is its own script, and run a step at a time:
#
# D1 bills rows written as well as rows read, and the free plan allows
# 100,000 writes a day against 5,000,000 reads. Cloudflare's pricing page
# says DDL "may contribute to a mix of read rows and write rows" and does not
# say how much, so whether building one index over 446,090 rows costs 446,090
# writes or something far smaller is not documented — it is measurable. Each
# step below prints what it actually cost, so the next one is a decision
# rather than a gamble. If a step reports a number near the daily allowance,
# stop and continue tomorrow; the script is resumable.
#
# Usage: sh tools/d1/reindex.sh <database-name>
set -eu

DB_NAME="${1:-}"
[ -n "$DB_NAME" ] || { echo "usage: sh tools/d1/reindex.sh <database-name>" >&2; exit 2; }

DONE="build/d1/.reindexed"
mkdir -p build/d1
touch "$DONE"

step() {
  name=$1
  sql=$2
  if grep -Fxq "$name" "$DONE" 2>/dev/null; then
    echo "· $name (already done)"
    return 0
  fi
  echo "→ $name"
  out=$(npx wrangler d1 execute "$DB_NAME" --remote --yes --json --command "$sql")
  # meta.rows_read / meta.rows_written is what the bill is made of.
  printf '%s' "$out" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        const m = (Array.isArray(j) ? j[0] : j).meta || {};
        console.log("   read " + (m.rows_read ?? "?") + "  written " + (m.rows_written ?? "?") +
                    "  " + Math.round(m.duration ?? 0) + " ms");
      } catch (e) { console.log("   (could not read meta)"); }
    });
  '
  echo "$name" >> "$DONE"
}

# Statistics first, because this is the step that stops the bleeding and it
# is the cheapest one: no index is built, and SQLite only walks what is
# already there. Without statistics the planner assumes every indexed lookup
# yields about ten rows and uses whichever usable index it meets first, which
# is how one view of a two-filter page came to read 2.79 million rows. With
# them it picks the selective column and reads four.
echo "Statistics, before anything else — this is the step that stops the burn."
echo
step analyze_now "ANALYZE;"

echo
echo "Now the replacement indexes. Each carries the cover expression the"
echo "browse ORDER BY starts with, so a filtered page stops reading at 18 rows"
echo "instead of sorting every match. Stop after any step that reports a"
echo "number near the daily allowance — re-running resumes where you left off."
echo
step browse_publisher "CREATE INDEX IF NOT EXISTS idx_browse_publisher ON books(publisher, cover = '', zh_first, title_display);"
step browse_year      "CREATE INDEX IF NOT EXISTS idx_browse_year ON books(year, cover = '', zh_first, title_display);"
step browse_lang      "CREATE INDEX IF NOT EXISTS idx_browse_lang ON books(language, cover = '', zh_first, title_display);"
step browse_class     "CREATE INDEX IF NOT EXISTS idx_browse_class ON books(classification, cover = '', zh_first, title_display);"
step browse_dataset   "CREATE INDEX IF NOT EXISTS idx_browse_dataset ON books(dataset, cover = '', zh_first, title_display);"
step facet_value      "CREATE INDEX IF NOT EXISTS idx_facet_value ON facet_counts(scope, facet, value);"

echo
echo "Dropping the four they supersede (about 90 MB back)."
step drop_publisher   "DROP INDEX IF EXISTS idx_publisher;"
step drop_class       "DROP INDEX IF EXISTS idx_classification;"
step drop_year        "DROP INDEX IF EXISTS idx_year;"
step drop_lang        "DROP INDEX IF EXISTS idx_language;"

echo
echo "Statistics again: the first run described the old indexes, and the"
echo "planner cannot choose the new ones well on figures for indexes that no"
echo "longer exist."
step analyze_again    "ANALYZE;"

echo
echo "Done. Check a plan is what you expect:"
echo "  npx wrangler d1 execute $DB_NAME --remote --yes --command \\"
echo "    \"EXPLAIN QUERY PLAN SELECT id FROM books WHERE language = 'zh' AND year = 2024 ORDER BY cover = '', zh_first, title_display LIMIT 18;\""
echo "It should SEARCH USING INDEX idx_browse_year with no TEMP B-TREE."
