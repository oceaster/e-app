#!/usr/bin/env bash
set -euo pipefail

BRANCH="$(git branch --show-current)"

if [ "$BRANCH" = "main" ]; then
    echo "ERROR: Refusing to run on 'main' branch. Switch to a feature branch first." >&2
    exit 1
fi

MSG="${1:-wip}"

echo "Committing all staged changes on branch '$BRANCH' with message: $MSG"
git commit -m "$MSG"
echo "Done."
