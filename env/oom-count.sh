#!/usr/bin/env bash
# Count kernel OOM kills since boot, including cgroup (container) OOM
# kills. Reads the kernel journal, falls back to dmesg.
# Usage: env/oom-count.sh
# Output: one integer, e.g. "0".
set -Eeuo pipefail
IFS=$'\n\t'

readonly PATTERN='(Out of memory|Memory cgroup out of memory): Killed process'

main() {
  local log
  if ! log="$(journalctl --dmesg --boot --no-pager --quiet 2>/dev/null)"; then
    log="$(dmesg 2>/dev/null || true)"
  fi
  printf '%s\n' "${log}" \
    | awk -v re="${PATTERN}" '$0 ~ re { n++ } END { print n + 0 }'
}

main "$@"
