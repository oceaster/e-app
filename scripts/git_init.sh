#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ISSUES=0
FIXED=0

green() { printf '\033[32m  OK:   %s\033[0m\n' "$1"; }
warn()  { printf '\033[33m  WARN: %s\033[0m\n' "$1"; ISSUES=$((ISSUES + 1)); }
fail()  { printf '\033[31m  FAIL: %s\033[0m\n' "$1"; ISSUES=$((ISSUES + 1)); }
fix()   { printf '\033[36m  FIX:  %s\033[0m\n' "$1"; FIXED=$((FIXED + 1)); }

echo "[git_init] action=health_check repo=$ROOT_DIR"
echo ""

# ──────────────────────────────────────────────
# 1. Git binary
# ──────────────────────────────────────────────
echo "--- System ---"
if command -v git &>/dev/null; then
    VER=$(git --version)
    green "git_binary=$VER"
else
    fail "git_binary=missing action=install_required"
    echo "[git_init] status=fatal reason='git not installed'"
    exit 1
fi

# ──────────────────────────────────────────────
# 2. Git user config
# ──────────────────────────────────────────────
USER_NAME=$(git config --global user.name 2>/dev/null || echo "")
USER_EMAIL=$(git config --global user.email 2>/dev/null || echo "")

if [ -n "$USER_NAME" ]; then
    green "git_config=user.name value=\"$USER_NAME\""
else
    warn "git_config=user.name value=unset"
    read -rp "  Enter your name for git config: " INPUT_NAME
    if [ -n "$INPUT_NAME" ]; then
        git config --global user.name "$INPUT_NAME"
        fix "git_config=user.name set_value=\"$INPUT_NAME\""
        USER_NAME="$INPUT_NAME"
    fi
fi

if [ -n "$USER_EMAIL" ]; then
    green "git_config=user.email value=\"$USER_EMAIL\""
else
    warn "git_config=user.email value=unset"
    read -rp "  Enter your email for git config: " INPUT_EMAIL
    if [ -n "$INPUT_EMAIL" ]; then
        git config --global user.email "$INPUT_EMAIL"
        fix "git_config=user.email set_value=\"$INPUT_EMAIL\""
        USER_EMAIL="$INPUT_EMAIL"
    fi
fi

# ──────────────────────────────────────────────
# 3. SSH / GitHub connectivity
# ──────────────────────────────────────────────
SSH_OUTPUT=$(ssh -T -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 git@github.com 2>&1) || true
if echo "$SSH_OUTPUT" | grep -q "successfully authenticated"; then
    green "ssh_github=authenticated"
elif echo "$SSH_OUTPUT" | grep -q "Permission denied"; then
    warn "ssh_github=permission_denied note='SSH key may not be added to GitHub — push/pull may fail'"
else
    warn "ssh_github=unknown_response note='$SSH_OUTPUT'"
fi

# ──────────────────────────────────────────────
# 4. Is this a git repo?
# ──────────────────────────────────────────────
echo ""
echo "--- Repo ---"
if git rev-parse --git-dir &>/dev/null; then
    green "git_repo=exists"
else
    fix "git_repo=missing action=git_init"
    git init
    fix "git_repo=initialized"
fi

# ──────────────────────────────────────────────
# 5. Remote origin
# ──────────────────────────────────────────────
REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
if [ -n "$REMOTE" ]; then
    green "git_remote=origin url=$REMOTE"
else
    warn "git_remote=origin value=unset"
    read -rp "  Enter remote origin URL (or leave blank to skip): " INPUT_URL
    if [ -n "$INPUT_URL" ]; then
        git remote add origin "$INPUT_URL"
        fix "git_remote=origin set_url=$INPUT_URL"
        REMOTE="$INPUT_URL"
    fi
fi

# ──────────────────────────────────────────────
# 6. No detached HEAD
# ──────────────────────────────────────────────
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
if [ -n "$CURRENT_BRANCH" ]; then
    green "git_state=attached branch=$CURRENT_BRANCH"
else
    warn "git_state=detached_HEAD note='No branch checked out'"
fi

# ──────────────────────────────────────────────
# 7. No in-progress rebase/merge/cherry-pick
# ──────────────────────────────────────────────
for op in rebase merge cherry-pick revert; do
    if [ -d "$(git rev-parse --git-dir 2>/dev/null)/${op}-apply" ] || \
       [ -f "$(git rev-parse --git-dir 2>/dev/null)/${op}-apply" ] || \
       [ -f "$(git rev-parse --git-dir 2>/dev/null)/${op}-merge" ] || \
       [ -f "$(git rev-parse --git-dir 2>/dev/null)/CHERRY_PICK_HEAD" ]; then
        case "$op" in
            rebase)
                if [ -d "$(git rev-parse --git-dir)/rebase-apply" ] || [ -d "$(git rev-parse --git-dir)/rebase-merge" ]; then
                    warn "git_state=${op}_in_progress action=aborting"
                    git rebase --abort 2>/dev/null || true
                    fix "git_state=rebase aborted=true"
                fi
                ;;
            merge)
                if [ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ]; then
                    warn "git_state=${op}_in_progress action=aborting"
                    git merge --abort 2>/dev/null || true
                    fix "git_state=merge aborted=true"
                fi
                ;;
            cherry-pick|revert)
                if [ -f "$(git rev-parse --git-dir)/CHERRY_PICK_HEAD" ] || [ -f "$(git rev-parse --git-dir)/REVERT_HEAD" ]; then
                    warn "git_state=${op}_in_progress action=aborting"
                    git cherry-pick --abort 2>/dev/null || git revert --abort 2>/dev/null || true
                    fix "git_state=$op aborted=true"
                fi
                ;;
        esac
    fi
done
# Final check — if we cleaned up, confirm
if [ -z "$(git branch --show-current 2>/dev/null)" ] && [ -n "$CURRENT_BRANCH" ]; then
    git checkout "$CURRENT_BRANCH" 2>/dev/null || true
fi
green "git_state=clean no_rebase no_merge no_cherry_pick"

# ──────────────────────────────────────────────
# 8. .gitignore
# ──────────────────────────────────────────────
if [ -f "$ROOT_DIR/.gitignore" ]; then
    green "gitignore=exists"
else
    warn "gitignore=missing action=creating_default"
    cat > "$ROOT_DIR/.gitignore" <<'IGNORE'
# OS
.DS_Store
Thumbs.db

# Editor
*.swp
*.swo
*~
.vscode/
.idea/

# Env
.env
.env.*
!.env.example

# Logs
*.log

# Dependencies
node_modules/
vendor/
__pycache__/
*.pyc

# Build
dist/
build/
*.tsbuildinfo
IGNORE
    fix "gitignore=created_default"
fi

# ──────────────────────────────────────────────
# 9. Working tree clean?
# ──────────────────────────────────────────────
if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
    green "git_worktree=clean"
else
    CHANGED=$(git diff --name-only | wc -l)
    STAGED=$(git diff --cached --name-only | wc -l)
    warn "git_worktree=dirty unstaged=$CHANGED staged=$STAGED"
fi

# ──────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────
echo ""
UNRESOLVED=$((ISSUES - FIXED))
echo "============================================"
if [ "$UNRESOLVED" -le 0 ]; then
    echo "[git_init] status=healthy issues=$ISSUES fixed=$FIXED unresolved=$UNRESOLVED branch=$CURRENT_BRANCH remote=$REMOTE"
else
    echo "[git_init] status=warning issues=$ISSUES fixed=$FIXED unresolved=$UNRESOLVED branch=$CURRENT_BRANCH remote=$REMOTE"
fi
