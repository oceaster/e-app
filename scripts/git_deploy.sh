#!/usr/bin/env bash
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"

MSG="${1:-wip}"
COMMITTED=false
PUSHED=false
MERGED=false
ROLLBACK_NEEDED=false

cleanup() {
    if [ "$ROLLBACK_NEEDED" = true ]; then
        echo ""
        echo "[deploy:rollback] action=recovering target=pre_deploy_state"
        CURRENT="$(git branch --show-current 2>/dev/null || echo "")"

        if [ "$MERGED" = true ]; then
            echo "[deploy:rollback] step=skip reason='merge already completed — manual intervention needed'"
        elif [ "$PUSHED" = true ]; then
            echo "[deploy:rollback] step=warn note='changes already pushed to remote — cannot unpush safely'"
            echo "[deploy:rollback] action=revert_commit local=true"
            git revert HEAD --no-edit 2>/dev/null || {
                echo "[deploy:rollback] step=revert_failed note='manual intervention needed'"
            }
        elif [ "$COMMITTED" = true ]; then
            echo "[deploy:rollback] step=reset_soft action='undo commit, keep changes staged'"
            git reset --soft HEAD~1
            echo "[deploy:rollback] step=reset_soft status=done changes_preserved=staged"
        fi

        # If we switched to main for a failed merge, switch back
        if [ "$CURRENT" != "$FEAT_BRANCH" ] && [ -n "$FEAT_BRANCH" ]; then
            git checkout "$FEAT_BRANCH" 2>/dev/null || true
        fi
    fi
}

trap cleanup EXIT

# ──────────────────────────────────────────────
# Step 0: Guard — must be on a feature branch
# ──────────────────────────────────────────────
FEAT_BRANCH="$(git branch --show-current)"
REMOTE="$(git remote get-url origin 2>/dev/null || echo 'unknown')"

if [ "$FEAT_BRANCH" = "main" ]; then
    echo "[deploy] status=fatal reason='deploy must run from a feature branch, not main'"
    exit 1
fi

echo "[deploy] branch=$FEAT_BRANCH remote=$REMOTE action=start"
echo ""

# ──────────────────────────────────────────────
# Step 1: git_init — health check
# ──────────────────────────────────────────────
echo "[deploy:1/5] step=health_check script=git_init.sh"
INIT_OUTPUT=$("$SCRIPTS_DIR/git_init.sh" 2>&1) || true
INIT_STATUS=$(echo "$INIT_OUTPUT" | grep -oP 'status=\K\S+' | tail -1 || echo "unknown")
INIT_UNRESOLVED=$(echo "$INIT_OUTPUT" | grep -oP 'unresolved=\K\d+' | tail -1 || echo "0")
# Allow dirty worktree (we're about to commit)
DIRTY_WARN=$(echo "$INIT_OUTPUT" | grep -c 'git_worktree=dirty' || true)
EFFECTIVE_UNRESOLVED=$((INIT_UNRESOLVED - DIRTY_WARN))
if [ "$EFFECTIVE_UNRESOLVED" -lt 0 ]; then EFFECTIVE_UNRESOLVED=0; fi

if [ "$INIT_STATUS" = "healthy" ] || ([ "$INIT_STATUS" = "warning" ] && [ "$EFFECTIVE_UNRESOLVED" -eq 0 ]); then
    echo "[deploy:1/5] step=health_check status=pass init_status=$INIT_STATUS dirty_worktree_ignored=$DIRTY_WARN"
elif [ "$INIT_STATUS" = "warning" ]; then
    UNRESOLVED=$(echo "$INIT_OUTPUT" | grep -oP 'unresolved=\K\d+' | tail -1 || echo "?")
    echo "[deploy:1/5] step=health_check status=abort init_status=$INIT_STATUS unresolved=$UNRESOLVED"
    echo "[deploy] status=aborted reason='git_init has unresolved warnings' unresolved=$UNRESOLVED"
    exit 1
else
    echo "[deploy:1/5] step=health_check status=abort init_status=$INIT_STATUS"
    echo "[deploy] status=aborted reason='git_init failed'"
    exit 1
fi

# ──────────────────────────────────────────────
# Step 2: verify_agents_docs
# ──────────────────────────────────────────────
echo ""
echo "[deploy:2/5] step=docs_verify script=verify_agents_docs.sh"
DOCS_OUTPUT=$("$SCRIPTS_DIR/verify_agents_docs.sh" 2>&1) || true
DOCS_STATUS=$(echo "$DOCS_OUTPUT" | grep -oP 'status=\K\S+' | tail -1 || echo "unknown")

if [ "$DOCS_STATUS" = "pass" ]; then
    echo "[deploy:2/5] step=docs_verify status=pass"
else
    FAILED_COUNT=$(echo "$DOCS_OUTPUT" | grep -oP 'failed=\K\d+' | tail -1 || echo "?")
    echo "[deploy:2/5] step=docs_verify status=abort failed=$FAILED_COUNT"
    echo "[deploy] status=aborted reason='docs verification failed' failed=$FAILED_COUNT"
    exit 1
fi

# ──────────────────────────────────────────────
# Step 3: Add + Commit
# ──────────────────────────────────────────────
echo ""
echo "[deploy:3/5] step=add_commit branch=$FEAT_BRANCH"

if git diff --quiet && git diff --cached --quiet; then
    echo "[deploy:3/5] step=add_commit status=skip reason='nothing to commit'"
else
    "$SCRIPTS_DIR/git_add_all.sh" 2>&1
    "$SCRIPTS_DIR/git_commit_all.sh" "$MSG" 2>&1 || {
        echo "[deploy:3/5] step=commit status=failed"
        echo "[deploy] status=aborted reason='commit failed'"
        exit 1
    }
    COMMITTED=true
    COMMIT_HASH=$(git rev-parse --short HEAD)
    echo "[deploy:3/5] step=add_commit status=done commit=$COMMIT_HASH"
fi

# ──────────────────────────────────────────────
# Step 4: Push
# ──────────────────────────────────────────────
echo ""
echo "[deploy:4/5] step=push branch=$FEAT_BRANCH"
"$SCRIPTS_DIR/git_push_all.sh" 2>&1 || {
    echo "[deploy:4/5] step=push status=failed"
    ROLLBACK_NEEDED=true
    echo "[deploy] status=aborted reason='push failed'"
    exit 1
}
PUSHED=true
echo "[deploy:4/5] step=push status=done"

# ──────────────────────────────────────────────
# Step 5: Merge into main
# ──────────────────────────────────────────────
echo ""
echo "[deploy:5/5] step=merge_feat into=main"
"$SCRIPTS_DIR/git_merge_branch.sh" 2>&1 || {
    echo "[deploy:5/5] step=merge status=failed"
    echo "[deploy] status=aborted reason='merge failed — main is clean, feature branch preserved'"
    exit 1
}
MERGED=true

# ──────────────────────────────────────────────
# Done
# ──────────────────────────────────────────────
echo ""
echo "[deploy] status=done branch=main commit=${COMMIT_HASH:-N/A} remote=$REMOTE"
