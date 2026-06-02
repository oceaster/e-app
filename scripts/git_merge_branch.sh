#!/usr/bin/env bash
set -euo pipefail

FEAT_BRANCH="$(git branch --show-current)"
REMOTE="$(git remote get-url origin 2>/dev/null || echo 'unknown')"

if [ "$FEAT_BRANCH" = "main" ]; then
    echo "[FATAL] branch=main guard=deny reason='merge_feat must run from a feature branch'" >&2
    exit 1
fi

FEAT_COMMIT="$(git rev-parse --short HEAD)"

echo "[merge_feat] feat=$FEAT_BRANCH feat_commit=$FEAT_COMMIT target=main action=merge"

# Step 1: Fetch main
echo "[merge_feat:1/4] step=fetch target=origin/main"
git fetch origin main 2>&1 || echo "[merge_feat:1/4] step=fetch note='no origin/main or fetch failed, continuing'"

# Step 2: Switch to main
echo "[merge_feat:2/4] step=checkout target=main"
git checkout main 2>&1
MAIN_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo 'empty')"
git pull origin main --ff-only 2>/dev/null || {
    echo "[merge_feat:2/4] step=checkout note='fast-forward pull failed (local ahead or no tracking), continuing'"
}
echo "[merge_feat:2/4] step=checkout main_commit=$MAIN_COMMIT status=on_main"

# Step 3: Merge
echo "[merge_feat:3/4] step=merge feat=$FEAT_BRANCH into=main"
if git merge "$FEAT_BRANCH" --no-edit 2>&1; then
    MERGE_COMMIT="$(git rev-parse --short HEAD)"
    echo "[merge_feat:3/4] step=merge status=success merge_commit=$MERGE_COMMIT"

    # Step 4: Delete feature branch
    echo "[merge_feat:4/4] step=cleanup feat=$FEAT_BRANCH action=delete"
    git branch -d "$FEAT_BRANCH"
    git push origin --delete "$FEAT_BRANCH" 2>/dev/null || echo "[merge_feat:4/4] step=cleanup note='no remote branch to delete'"

    echo "[merge_feat] status=done feat=$FEAT_BRANCH feat_commit=$FEAT_COMMIT merge_commit=$MERGE_COMMIT branch=main remote=$REMOTE"
else
    echo "[merge_feat:3/4] step=merge status=failed action=abort"
    git merge --abort 2>&1
    echo "[merge_feat] status=aborted feat=$FEAT_BRANCH feat_commit=$FEAT_COMMIT reason='merge conflict or failure' branch=main state=clean"
    exit 1
fi
