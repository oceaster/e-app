#!/usr/bin/env bash
set -euo pipefail

BRANCH="$(git branch --show-current)"

if [ "$BRANCH" = "main" ]; then
    echo "ERROR: Refusing to run on 'main' branch. Switch to a feature branch first." >&2
    exit 1
fi

MSG="${1:-wip}"

echo "=== Add + Commit + Force Push on branch '$BRANCH' ==="

echo "[1/3] Adding all changes..."
git add -A

echo "[2/3] Committing with message: $MSG"
git commit -m "$MSG"

echo "[3/3] Force pushing to origin/$BRANCH..."
git push -u origin "$BRANCH" --force

echo "Done."
