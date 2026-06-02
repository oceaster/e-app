#!/usr/bin/env bash
set -euo pipefail

BRANCH="$(git branch --show-current)"

if [ "$BRANCH" != "main" ]; then
    echo "ERROR: Must be on 'main' branch to create a new feature branch. Currently on '$BRANCH'." >&2
    exit 1
fi

if [ $# -lt 1 ]; then
    echo "Usage: $0 <branch-name>" >&2
    exit 1
fi

NEW_BRANCH="$1"

echo "Creating and switching to new branch: $NEW_BRANCH"
git checkout -b "$NEW_BRANCH"
echo "Done. Now on branch '$NEW_BRANCH'."
