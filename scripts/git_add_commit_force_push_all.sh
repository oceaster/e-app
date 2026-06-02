#!/usr/bin/env bash
set -euo pipefail

BRANCH="$(git branch --show-current)"

if [ "$BRANCH" = "main" ]; then
    echo "[FATAL] branch=main guard=deny reason='add_commit_force_push blocked on main'" >&2
    exit 1
fi

MSG="${1:-wip}"
REMOTE="$(git remote get-url origin 2>/dev/null || echo 'unknown')"

echo "[acfp] branch=$BRANCH action=add_commit_force_push remote=$REMOTE"

# Step 1: Add
echo "[acfp:1/3] branch=$BRANCH step=add"
git add -A
STAGED=$(git diff --cached --name-only | wc -l)
echo "[acfp:1/3] branch=$BRANCH step=add staged=$STAGED"

# Step 2: Commit
echo "[acfp:2/3] branch=$BRANCH step=commit message=\"$MSG\""
git commit -m "$MSG"
COMMIT=$(git rev-parse --short HEAD)
FILES_CHANGED=$(git diff --stat HEAD~1 2>/dev/null | tail -1 || echo "root-commit")
echo "[acfp:2/3] branch=$BRANCH step=commit commit=$COMMIT files=\"$FILES_CHANGED\""

# Step 3: Push
echo "[acfp:3/3] branch=$BRANCH step=push target=origin/$BRANCH"
git push -u origin "$BRANCH" --force 2>&1
echo "[acfp:3/3] branch=$BRANCH step=push status=done"

echo "[acfp] branch=$BRANCH status=done commit=$COMMIT remote=$REMOTE"
