#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$FAKE_CLAUDE_ARGS"
cat > "$FAKE_CLAUDE_STDIN"
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' '2.1.318 (Claude Code)'
else
  cat "$FAKE_CLAUDE_RESULT"
fi
