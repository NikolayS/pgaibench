#!/usr/bin/env bash
# Clone (or reuse) pgaibench, branch from v0.2, and install this pack under
# docs/policy-gate/. Usage:
#   scripts/bootstrap.sh [target-dir]
# Env overrides:
#   REPO_URL (default upstream; set to your fork), BASE (default v0.2),
#   BRANCH (default feat/precondition-gate)
set -euo pipefail

PACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_URL="${REPO_URL:-https://github.com/NikolayS/pgaibench.git}"
BASE="${BASE:-v0.2}"
BRANCH="${BRANCH:-feat/precondition-gate}"
TARGET="${1:-pgaibench}"

if [ ! -d "$TARGET/.git" ]; then
  git clone "$REPO_URL" "$TARGET"
fi
cd "$TARGET"
git fetch --all --tags

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
elif git show-ref --verify --quiet "refs/remotes/origin/$BASE"; then
  git checkout -b "$BRANCH" "origin/$BASE"
else
  git checkout -b "$BRANCH" "$BASE"   # e.g. BASE is a tag
fi

mkdir -p docs/policy-gate
cp -R "$PACK_DIR"/. docs/policy-gate/
rm -f docs/policy-gate/*.zip

if command -v bun >/dev/null 2>&1; then
  bun install
else
  echo "WARN: bun not found. Install from https://bun.sh before running tests." >&2
fi

cat << MSG

Pack installed at $(pwd)/docs/policy-gate on branch $BRANCH (from $BASE).
Next:
  1. cd $(pwd)
  2. claude
  3. Paste the Session 1 prompt from docs/policy-gate/KICKOFF.md
MSG
