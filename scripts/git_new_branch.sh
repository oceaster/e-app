#!/usr/bin/env bash
set -euo pipefail

CURRENT="$(git branch --show-current)"
REMOTE="$(git remote get-url origin 2>/dev/null || echo 'unknown')"

if [ "$CURRENT" != "main" ]; then
    echo "[FATAL] current=$CURRENT guard=deny reason='new_branch must run from main'" >&2
    exit 1
fi

if [ $# -lt 1 ]; then
    echo "[FATAL] reason='missing branch name' usage=\"$0 <branch-name>\"" >&2
    exit 1
fi

NEW_BRANCH="$1"
BASE_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo 'empty-repo')"

echo "[new_branch] from=main to=$NEW_BRANCH base=$BASE_COMMIT action=create"

git fetch origin main 2>/dev/null || true
git checkout -b "$NEW_BRANCH"

NEW_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo 'empty-repo')"

echo "[new_branch] from=main to=$NEW_BRANCH base=$BASE_COMMIT head=$NEW_COMMIT status=done remote=$REMOTE"
