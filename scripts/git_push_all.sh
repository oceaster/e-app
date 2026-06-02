#!/usr/bin/env bash
set -euo pipefail

BRANCH="$(git branch --show-current)"

if [ "$BRANCH" = "main" ]; then
    echo "ERROR: Refusing to run on 'main' branch. Switch to a feature branch first." >&2
    exit 1
fi

echo "Pushing branch '$BRANCH' to origin..."
git push -u origin "$BRANCH"
echo "Done."
