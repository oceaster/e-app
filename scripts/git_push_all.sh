#!/usr/bin/env bash
set -euo pipefail

BRANCH="$(git branch --show-current)"

if [ "$BRANCH" = "main" ]; then
    echo "[FATAL] branch=main guard=deny reason='push_all blocked on main'" >&2
    exit 1
fi

REMOTE="$(git remote get-url origin 2>/dev/null || echo 'unknown')"
COMMIT="$(git rev-parse --short HEAD)"

echo "[push_all] branch=$BRANCH action=push remote=$REMOTE commit=$COMMIT"

git push -u origin "$BRANCH" 2>&1

echo "[push_all] branch=$BRANCH status=done remote=$REMOTE commit=$COMMIT"
