#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_MD="$ROOT_DIR/docs/AGENTS.md"
TODO_MD="$ROOT_DIR/docs/AGENTS_TODO.md"
ERRORS=0

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }

fail() { red "  FAIL: $1"; ERRORS=$((ERRORS + 1)); }
pass() { green "  PASS: $1"; }

check_file_exists() {
    if [ -f "$1" ]; then
        pass "$1 exists"
    else
        fail "$1 does not exist"
        return 1
    fi
}

check_has_h1() {
    local label="$1"
    local file="$2"
    if grep -q '^# ' "$file"; then
        pass "$label has H1 heading"
    else
        fail "$label missing H1 heading"
    fi
}

# ──────────────────────────────────────────────
echo "=== Verifying docs/AGENTS.md ==="
echo ""

if check_file_exists "$AGENTS_MD"; then

    check_has_h1 "AGENTS.md" "$AGENTS_MD"

    # Must have Work Log section
    if grep -q '^## Work Log' "$AGENTS_MD"; then
        pass "Has '## Work Log' section"
    else
        fail "Missing '## Work Log' section"
    fi

    # Must have Project Conventions section
    if grep -q '^## Project Conventions' "$AGENTS_MD"; then
        pass "Has '## Project Conventions' section"
    else
        fail "Missing '## Project Conventions' section"
    fi

    # Work log entries should be dated (### YYYY-MM-DD)
    if grep -qP '^### \d{4}-\d{2}-\d{2}' "$AGENTS_MD"; then
        pass "Work log has dated entries (### YYYY-MM-DD format)"
    else
        fail "Work log missing dated entries (### YYYY-MM-DD format)"
    fi

    # Each dated section should have at least one bullet
    DATED_SECTIONS=$(grep -cP '^### \d{4}-\d{2}-\d{2}' "$AGENTS_MD" || true)
    BULLET_COUNT=$(grep -cP '^- ' "$AGENTS_MD" || true)
    if [ "$BULLET_COUNT" -ge "$DATED_SECTIONS" ]; then
        pass "Each dated section has bullet entries ($BULLET_COUNT bullets, $DATED_SECTIONS sections)"
    else
        fail "Some dated sections may be missing bullet entries ($BULLET_COUNT bullets, $DATED_SECTIONS sections)"
    fi

fi

echo ""
echo "=== Verifying docs/AGENTS_TODO.md ==="
echo ""

if check_file_exists "$TODO_MD"; then

    check_has_h1 "AGENTS_TODO.md" "$TODO_MD"

    # Must have a Legend section
    if grep -q '^## Legend' "$TODO_MD"; then
        pass "Has '## Legend' section"
    else
        fail "Missing '## Legend' section"
    fi

    # Required task-status tokens in legend
    for tok in '\[ \]' '\[~\]' '\[x\]' '\[-\]'; do
        if grep -q "$tok" "$TODO_MD"; then
            pass "Legend includes token: $tok"
        else
            fail "Legend missing token: $tok"
        fi
    done

    # Required board columns
    for col in Backlog "In Progress" Done; do
        if grep -q "^## $col$" "$TODO_MD"; then
            pass "Has '## $col' column"
        else
            fail "Missing '## $col' column"
        fi
    done

    # All task lines (under a ## column) must start with one of the valid tokens
    COLUMNS=('Backlog' 'In Progress' 'Done')
    for col in "${COLUMNS[@]}"; do
        INVALID=$(awk -v col="$col" '
            BEGIN { in_col = 0 }
            $0 == "## " col { in_col = 1; next }
            /^## / { in_col = 0 }
            in_col && /^[ \t]*$/ { next }
            in_col && /^---/  { next }
            in_col && /^\*Last updated:/ { next }
            in_col && /^$/     { next }
            in_col && $0 !~ /^- \[[- x~]\] / { print NR ": " $0 }
        ' "$TODO_MD")
        if [ -z "$INVALID" ]; then
            pass "All items in '$col' use valid format - [ ] / - [~] / - [x] / - [-]"
        else
            while IFS= read -r line; do
                fail "Invalid task line in '$col': $line"
            done <<< "$INVALID"
        fi
    done

    # Must have "Last updated" footer
    if grep -qP '\*Last updated: \d{4}-\d{2}-\d{2}\*' "$TODO_MD"; then
        pass "Has 'Last updated: YYYY-MM-DD' footer"
    else
        fail "Missing or malformed '*Last updated: YYYY-MM-DD*' footer"
    fi

fi

echo ""
echo "============================================"
if [ "$ERRORS" -eq 0 ]; then
    green "All checks passed (0 errors)"
    exit 0
else
    red "Found $ERRORS error(s)"
    exit 1
fi
