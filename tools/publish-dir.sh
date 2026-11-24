#!/bin/sh
# Assembles the publishable site into a directory: everything tracked under
# site/ except the full JSON shards, with a manifest that no longer advertises
# them.
#
#   sh tools/publish-dir.sh _site
#
# Used by the GitHub Actions deploy, which uploads a directory rather than
# pushing a branch. `tools/deploy.sh` makes the same selection with git
# plumbing for a local branch deploy. Why the shards are withheld:
# tools/publish-manifest.js.
#
# The file list comes from git, not from the filesystem, for one specific
# reason: site/data/books.db is 729 MB and gitignored. A plain copy of site/
# picks it up and produces an 836 MB "site" — the database is meant to be in
# R2, not published beside the page. Taking the list from the index means this
# publishes exactly what a branch deploy would.
set -eu

cd "$(dirname "$0")/.."
DEST=${1:?usage: publish-dir.sh DEST}

rm -rf "$DEST"
mkdir -p "$DEST"

# Plain newline-delimited, not `git ls-files -z` with `read -r -d ''`: /bin/sh
# is bash in POSIX mode on macOS, where `read -d` works, and dash on Ubuntu,
# where it does not. The CI run failed with "read: Illegal option -d" after
# this had passed on a laptop.
#
# Without -z, git quotes any path needing it, so refuse rather than silently
# mishandle one. No path under site/ has ever needed quoting.
if git ls-files site/ | grep -q '^"'; then
  echo "✗ a tracked path under site/ needs quoting; this script cannot handle it:" >&2
  git ls-files site/ | grep '^"' | sed 's/^/    /' >&2
  exit 1
fi

git ls-files site/ \
  | grep -v '\.full\.[0-9]*\.json$' \
  | while IFS= read -r f; do
      rel=${f#site/}
      mkdir -p "$DEST/$(dirname "$rel")"
      cp -p "$f" "$DEST/$rel"
    done

# The scope pages, generated rather than tracked: ~550 files of HTML derived
# from site/data/page/*.json and the manifest, rewritten on every rebuild.
# Committing them would put several megabytes into history every week for
# content that is already in git in its source form — the reason
# site/data/books.db is ignored. Written after the copy because it also
# writes sitemap.xml, which must be the generated one listing every scope
# rather than a tracked file naming a single URL.
node tools/build-pages.js "$DEST"

# If the copy produced nothing the next line fails with "Directory nonexistent",
# which says nothing useful about why.
[ -d "$DEST/data" ] || {
  echo "✗ nothing was copied into $DEST — is this a git checkout of the project?" >&2
  exit 1
}

node tools/publish-manifest.js > "$DEST/data/manifest.json"

# Jekyll would otherwise ignore files beginning with an underscore.
touch "$DEST/.nojekyll"

# Refuse to publish a site whose database is not actually being served.
#
# The manifest advertises that object's exact byte length, and the startup
# probe only reads one row near the head of the file — so a site published
# ahead of its database does not fail loudly, it fails at the facet tables in
# the tail, weeks later. Ordering the build steps is not enough: a CI rebuild
# committed a manifest and then failed to upload, leaving main one deploy away
# from advertising an object that returned 404.
. "$(dirname "$0")/lib/object-check.sh"

DB_URL=$(node -e 'const m = require("./site/data/manifest.json").db; process.stdout.write(m && m.url ? m.url : "");')
DB_BYTES=$(node -e 'const m = require("./site/data/manifest.json").db; process.stdout.write(m && m.url ? String(m.bytes) : "");')

if [ -n "$DB_URL" ]; then
  verdict=$(check_object "$DB_URL" "$DB_BYTES")
  if [ "$verdict" = "ok" ]; then
    echo "database ✓ $DB_URL serves $DB_BYTES bytes"
  else
    echo "✗ not publishing: $DB_URL is $verdict" >&2
    explain_object "$verdict" "$DB_URL"
    exit 1
  fi
fi

# Name the service worker's cache after the site it is caching.
#
# The worker is network-first with a four-second timeout, so on a slow
# connection it answers from cache — which is correct for an aeroplane and
# wrong after a deploy, because the visitor then runs the previous app.js
# against the current manifest, or the previous manifest against a database
# that has been pruned away.
#
# A cache name that changes whenever any published byte changes makes that
# impossible: the old cache is dropped on activate. Bumping it by hand failed
# the first time it mattered, and stamping it from the database hash alone
# failed the first time only the code changed.
#
# sw.js is excluded from its own hash, for obvious reasons.
# `find | xargs cat` was wrong and silently so: xargs splits on whitespace, so
# the first published path containing a space became two paths that do not
# exist, cat wrote an error to stderr, and the pipeline still reported the
# status of `cut` — zero. The stamp was then computed over a subset of the
# site, which is exactly the failure this stamp exists to prevent: a deploy
# whose changed files do not change the cache name leaves every returning
# visitor running the previous app. Nothing had a space in it until the scope
# pages arrived, so this had never fired.
#
# -exec … + passes paths as arguments rather than through a shell split, and
# hashing `shasum`'s own output folds each path into the stamp as well, so a
# file that is only renamed still changes it.
STAMP=$(find "$DEST" -type f ! -name sw.js -exec shasum {} + | sort | shasum | cut -c1-8)
case "$STAMP" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "✗ could not compute a cache stamp for $DEST (got '$STAMP')" >&2; exit 1 ;;
esac
if [ -f "$DEST/sw.js" ]; then
  TMP="$DEST/sw.js.stamping"
  sed "s/var CACHE = '[^']*';/var CACHE = 'jimbocho-$STAMP';/" "$DEST/sw.js" > "$TMP"
  if cmp -s "$DEST/sw.js" "$TMP"; then
    rm -f "$TMP"
    echo "✗ could not stamp the cache name in sw.js — has the CACHE line moved?" >&2
    exit 1
  fi
  mv "$TMP" "$DEST/sw.js"
  echo "service worker cache → jimbocho-$STAMP"
fi

n=$(find "$DEST" -type f | wc -l | tr -d ' ')
mb=$(du -sm "$DEST" | cut -f1)
echo "assembled $DEST — $n files, ${mb} MB"

# The published-site limit is 1 GB, and a deployment times out after 10
# minutes. Fail here rather than after a ten-minute wait, which is how the
# 6 Nov 2026 deploy failed.
if [ "$mb" -gt 700 ]; then
  echo "✗ ${mb} MB is too close to the 1 GB published-site limit to deploy safely." >&2
  exit 1
fi
