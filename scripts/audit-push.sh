#!/usr/bin/env bash
set -euo pipefail

BEFORE="$1"
AFTER="$2"
ZERO="0000000000000000000000000000000000000000"

if [ "$BEFORE" = "$ZERO" ] || ! git merge-base --is-ancestor "$BEFORE" "$AFTER" 2>/dev/null; then
  ROOT="$(git rev-list --max-parents=0 "$AFTER")"
  echo "Initial or force push detected: auditing root ${ROOT}"
  node "$(dirname "$0")/audit-commits.js" --single "$ROOT"
  node "$(dirname "$0")/audit-commits.js" --base "$ROOT" --head "$AFTER"
else
  echo "Auditing range ${BEFORE}..${AFTER}"
  node "$(dirname "$0")/audit-commits.js" --base "$BEFORE" --head "$AFTER"
fi
