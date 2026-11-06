#!/usr/bin/env bash
# Version and publish the package. Runs in the Release workflow after a push to
# main. `DRY_RUN=true` shows the version bump without committing or pushing.
#
# The script is deliberately idempotent: a release commit that failed to publish
# is retried on the next run, and an already published version never publishes
# twice.

set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN="${DRY_RUN:-false}"
name=$(node -p "require('./package.json').name")
current=$(node -p "require('./package.json').version")

# 0: published, 1: the registry says it is not, 2: the check itself failed.
# Callers must not treat a network or auth failure as "not published".
published() {
  local spec="$name@$1" output status
  if output=$(npm view "$spec" version 2>&1 >/dev/null); then
    return 0
  else
    status=$?
  fi
  case "$output" in
    *E404*|*"404 Not Found"*|*"is not in this registry"*) return 1 ;;
    *)
      printf 'npm view %s failed: %s\n' "$spec" "$output" >&2
      return 2
      ;;
  esac
}

publish() {
  local version="$1" status=0
  published "$version" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "$name@$version is already on npm; skipping publish."
    return
  fi
  if [ "$status" -ne 1 ]; then
    echo "Could not determine whether $name@$version is published." >&2
    exit 1
  fi
  if [ "$DRY_RUN" = "true" ]; then
    echo "DRY RUN: npm publish --access public ($name@$version)"
    return
  fi
  npm publish --access public
}

# Mirror changesets' own ignored files so a stray README/AGENTS/CLAUDE/GEMINI
# does not look like a release intent.
has_changeset=false
for file in .changeset/*.md; do
  [ -e "$file" ] || continue
  case "$(basename "$file" | tr '[:upper:]' '[:lower:]')" in
    readme.md | agents.md | claude.md | gemini.md) continue ;;
  esac
  has_changeset=true
  break
done

# A release commit means a previous run bumped the version but did not finish
# publishing. Retry that exact version instead of bumping again.
if git log -1 --pretty=%s | grep -q '^chore(release): '; then
  echo "Release commit found; checking $name@$current."
  publish "$current"
  exit 0
fi

if published "$current"; then
  current_published=true
else
  status=$?
  if [ "$status" -ne 1 ]; then
    echo "Could not determine whether $name@$current is published." >&2
    exit 1
  fi
  current_published=false
fi

# The package version has not reached npm yet. This is the first release, or a
# retry after a failed publish; publish it without inventing a new version.
if [ "$has_changeset" = "false" ] && [ "$current_published" = "false" ]; then
  echo "Publishing the unpublished version $current."
  publish "$current"
  exit 0
fi

if [ "$has_changeset" = "false" ]; then
  echo "No changeset found; creating a patch changeset."
  cat >.changeset/auto-release.md <<EOF
---
"$name": patch
---

Automated patch release.
EOF
fi

bunx changeset version
version=$(node -p "require('./package.json').version")

if [ "$version" = "$current" ]; then
  echo "The changesets did not bump the version; nothing to publish."
  exit 0
fi

if [ "$DRY_RUN" = "true" ]; then
  echo "DRY RUN: would commit chore(release): v$version and publish $name@$version."
  git diff --stat -- package.json CHANGELOG.md .changeset
  echo "The working tree now has the version bump. Discard it with: git reset --hard"
  publish "$version"
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add package.json
git add -u .changeset
if [ -f CHANGELOG.md ]; then
  git add CHANGELOG.md
fi
git commit -m "chore(release): v$version"
git push origin HEAD:main

publish "$version"
