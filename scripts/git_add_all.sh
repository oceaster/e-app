#!/usr/bin/env bash
set -euo pipefail

BRANCH="$(git branch --show-current)"

if [ "$BRANCH" = "main" ]; then
    echo "[FATAL] branch=main guard=deny reason='add_all blocked on main'" >&2
    exit 1
fi

echo "[add_all] branch=$BRANCH action=staging"

BEFORE=$(git diff --name-only --diff-filter=D 2>/dev/null | wc -l || true)
git add -A

ADDED=$(git diff --cached --name-only | wc -l)
STAGED_FILES=$(git diff --cached --name-only | head -20)
if [ "$ADDED" -gt 20 ]; then
    STAGED_FILES="$STAGED_FILES
    ... and $((ADDED - 20)) more"
fi

echo "[add_all] branch=$BRANCH status=done staged=$ADDED"
echo "$STAGED_FILES"
