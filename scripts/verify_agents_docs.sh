#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_MD="$ROOT_DIR/docs/AGENTS.md"
TODO_MD="$ROOT_DIR/docs/AGENTS_TODO.md"
TOTAL=0
PASSED=0
FAILED=0

green() { printf '\033[32m  PASS: %s\033[0m\n' "$1"; }
red()   { printf '\033[31m  FAIL: %s\033[0m\n' "$1"; }

pass() { green "$1"; PASSED=$((PASSED + 1)); TOTAL=$((TOTAL + 1)); }
fail() { red "$1";   FAILED=$((FAILED + 1)); TOTAL=$((TOTAL + 1)); }

check_file_exists() {
    if [ -f "$1" ]; then
        pass "file=$1 exists=true"
    else
        fail "file=$1 exists=false"
        return 1
    fi
}

check_has_h1() {
    local label="$1"
    local file="$2"
    if grep -q '^# ' "$file"; then
        pass "file=$label check=h1 status=ok"
    else
        fail "file=$label check=h1 status=missing"
    fi
}

echo "[verify_docs] action=start targets=AGENTS.md,AGENTS_TODO.md"
echo ""

# ── AGENTS.md ──
echo "--- AGENTS.md ---"
if check_file_exists "$AGENTS_MD"; then
    check_has_h1 "AGENTS.md" "$AGENTS_MD"

    grep -q '^## Work Log' "$AGENTS_MD" \
        && pass "file=AGENTS.md check=section_Work_Log status=ok" \
        || fail "file=AGENTS.md check=section_Work_Log status=missing"

    grep -q '^## Project Conventions' "$AGENTS_MD" \
        && pass "file=AGENTS.md check=section_Project_Conventions status=ok" \
        || fail "file=AGENTS.md check=section_Project_Conventions status=missing"

    if grep -qP '^### \d{4}-\d{2}-\d{2}' "$AGENTS_MD"; then
        pass "file=AGENTS.md check=dated_entries format=YYYY-MM-DD status=ok"
    else
        fail "file=AGENTS.md check=dated_entries format=YYYY-MM-DD status=missing"
    fi

    DATED=$(grep -cP '^### \d{4}-\d{2}-\d{2}' "$AGENTS_MD" || true)
    BULLETS=$(grep -cP '^- ' "$AGENTS_MD" || true)
    if [ "$BULLETS" -ge "$DATED" ]; then
        pass "file=AGENTS.md check=bullet_coverage sections=$DATED bullets=$BULLETS status=ok"
    else
        fail "file=AGENTS.md check=bullet_coverage sections=$DATED bullets=$BULLETS status=under"
    fi
fi

echo ""
echo "--- AGENTS_TODO.md ---"
if check_file_exists "$TODO_MD"; then
    check_has_h1 "AGENTS_TODO.md" "$TODO_MD"

    grep -q '^## Legend' "$TODO_MD" \
        && pass "file=AGENTS_TODO.md check=section_Legend status=ok" \
        || fail "file=AGENTS_TODO.md check=section_Legend status=missing"

    for tok in '\[ \]' '\[~\]' '\[x\]' '\[-\]'; do
        grep -q "$tok" "$TODO_MD" \
            && pass "file=AGENTS_TODO.md check=legend_token token=$tok status=ok" \
            || fail "file=AGENTS_TODO.md check=legend_token token=$tok status=missing"
    done

    for col in Backlog "In Progress" Done; do
        grep -q "^## $col$" "$TODO_MD" \
            && pass "file=AGENTS_TODO.md check=column column=$col status=ok" \
            || fail "file=AGENTS_TODO.md check=column column=$col status=missing"
    done

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
            pass "file=AGENTS_TODO.md check=task_format column=$col status=ok"
        else
            while IFS= read -r line; do
                fail "file=AGENTS_TODO.md check=task_format column=$col status=invalid line=\"$line\""
            done <<< "$INVALID"
        fi
    done

    if grep -qP '\*Last updated: \d{4}-\d{2}-\d{2}\*' "$TODO_MD"; then
        pass "file=AGENTS_TODO.md check=footer format=Last_updated_YYYY-MM-DD status=ok"
    else
        fail "file=AGENTS_TODO.md check=footer format=Last_updated_YYYY-MM-DD status=missing"
    fi
fi

echo ""
echo "============================================"
if [ "$FAILED" -eq 0 ]; then
    echo "[verify_docs] status=pass total=$TOTAL passed=$PASSED failed=$FAILED"
    exit 0
else
    echo "[verify_docs] status=fail total=$TOTAL passed=$PASSED failed=$FAILED"
    exit 1
fi
