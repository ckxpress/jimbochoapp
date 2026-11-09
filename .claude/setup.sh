#!/usr/bin/env bash
# Prepares a cloud environment for 神保町 / jimbocho.app.
#
# There is nothing to install from npm. Every script in tools/ uses Node
# built-ins, there is no lockfile, and `npm install` here would be a sign that
# something has gone wrong — so this script deliberately does not run it.
#
# What the project does need is outside npm:
#
#   sqlite3 with FTS5   the build shells out to the CLI, and the search index
#                       is an FTS5 table. A sqlite3 built without FTS5 does
#                       not fail at `apt install`; it fails much later, in the
#                       middle of a build, so this checks for it by compiling
#                       a virtual table rather than by trusting the version.
#   rclone              only for `npm run upload:db`, which writes the built
#                       database to R2. Installed anyway: it is small, and
#                       discovering it is missing at the end of a 40-minute
#                       build is worse.
#
# Idempotent on purpose — a cloud environment re-runs this when it resumes,
# and the apt step is the slow part.
set -euo pipefail

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }

SUDO=''
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 && SUDO='sudo'
fi

say "Node"
if ! command -v node >/dev/null 2>&1; then
  echo "✗ No node on PATH. This project needs Node 12 or newer (CI uses 22)." >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 12 ]; then
  echo "✗ node $(node -v) is too old; package.json asks for >=12." >&2
  exit 1
fi
ok "node $(node -v)"

say "System packages"
MISSING=''
command -v sqlite3 >/dev/null 2>&1 || MISSING="$MISSING sqlite3"
command -v rclone  >/dev/null 2>&1 || MISSING="$MISSING rclone"

if [ -n "$MISSING" ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "✗ Need$MISSING, and this image has no apt-get. Install them another way." >&2
    exit 1
  fi
  echo "  installing$MISSING"
  $SUDO apt-get update -qq
  # shellcheck disable=SC2086
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq $MISSING
fi
ok "sqlite3 $(sqlite3 --version | cut -d' ' -f1)"
ok "rclone $(rclone version 2>/dev/null | head -1 | cut -d' ' -f2)"

say "FTS5"
# The check that matters. A build against a sqlite3 without FTS5 gets all the
# way to CREATE VIRTUAL TABLE before it fails.
#
# Single-quoted inside the heredoc, not double: SQLite reads "x" as an
# identifier, so a double-quoted probe fails on a sqlite3 that has FTS5
# perfectly well — which is how the first version of this check behaved.
if sqlite3 :memory: >/dev/null 2>&1 <<'SQL'
CREATE VIRTUAL TABLE t USING fts5(x);
INSERT INTO t VALUES ('hello world');
SELECT 1 FROM t WHERE t MATCH 'hello';
SQL
then
  ok "FTS5 present, and a MATCH returns rows"
else
  echo "✗ sqlite3 has no FTS5. The search index cannot be built with it." >&2
  exit 1
fi

say "Repository"
cd "$(dirname "$0")/.."
if [ ! -f site/data/manifest.json ]; then
  warn "site/data/manifest.json is missing — \`npm start\` will have no data."
else
  node -e '
    const m = require("./site/data/manifest.json");
    const db = (m.db && m.db.url) || "(none)";
    console.log("  ✓ manifest: " + m.totalBooks.toLocaleString() + " records, " +
                m.datasets.length + " datasets");
    console.log("  ✓ database: " + db);
    console.log("  " + (m.api ? "✓ search API: " + m.api
                              : "· search API: not configured, searches read the file"));
  '
fi

# A build writes a ~500 MB database and VACUUM needs room for a second copy,
# on top of the ~670 MB of JSON shards and source CSVs already in the tree.
AVAIL_KB=$(df -Pk . | awk 'NR==2 {print $4}')
AVAIL_GB=$((AVAIL_KB / 1024 / 1024))
if [ "$AVAIL_GB" -lt 4 ]; then
  warn "${AVAIL_GB} GB free. Enough to run the site; not enough to build the database."
else
  ok "${AVAIL_GB} GB free"
fi

say "Ready"
cat <<'EOF'
  npm start                      http://localhost:8080, against the published
                                 database in R2 — no credentials needed
  npm run import -- --list       what datasets are registered
  npm run build:db -- --db-url ""   build a local database and point at it

  Deploying, uploading to R2 and anything touching D1 need credentials this
  environment does not carry by default. See CONTRIBUTING.md.
EOF
