#!/usr/bin/env bash
set -euo pipefail

BRANCH="$(git branch --show-current)"

if [ "$BRANCH" = "main" ]; then
    echo "[FATAL] branch=main guard=deny reason='commit_all blocked on main'" >&2
    exit 1
fi

MSG="${1:-wip}"

echo "[commit_all] branch=$BRANCH action=commit message=\"$MSG\""

HASH=$(git commit -m "$MSG" | head -1)
# git commit output is like "[branch HASH] message"
SHORT_HASH=$(git rev-parse --short HEAD)
FILES_CHANGED=$(git diff --stat HEAD~1 2>/dev/null | tail -1 || echo "N/A (root commit)")

echo "[commit_all] branch=$BRANCH status=done commit=$SHORT_HASH files=\"$FILES_CHANGED\""
