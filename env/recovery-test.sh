#!/usr/bin/env bash
# Crash-restart test: SIGKILL the postgres container, start it again,
# measure seconds until it accepts queries (crash recovery time).
# Usage: env/recovery-test.sh [primary|clone <n>] [limit_s]
#   default target: primary; limit_s default 60 (pass if recovery_s <= limit)
# Output (stdout, one JSON line): {"target":"primary","recovery_s":3.1,
#   "limit_s":60,"recovery_test":"pass"}
# Note: crash recovery resets cumulative statistics (pg_stat_*) on that
# server. Prefer running it on a clone.
set -Eeuo pipefail
IFS=$'\n\t'
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

main() {
  local target="${1:-primary}"
  local container port limit
  if [[ "${target}" == clone ]]; then
    local n="${2:-}"
    if [[ ! "${n}" =~ ^[0-9]+$ ]]; then
      err "usage: recovery-test.sh [primary|clone <n>] [limit_s]"
      exit 2
    fi
    port=$((5500 + n))
    container="pgaibench-clone-${n}"
    limit="${3:-60}"
  elif [[ "${target}" == primary ]]; then
    port=5432
    container=pgaibench-primary
    limit="${2:-60}"
  else
    err "usage: recovery-test.sh [primary|clone <n>] [limit_s]"
    exit 2
  fi
  local t0 t1
  t0="$(now_s)"
  docker kill --signal KILL "${container}" >/dev/null
  docker start "${container}" >/dev/null
  wait_ready "${port}" 600
  t1="$(now_s)"
  local secs result=pass
  secs="$(elapsed "${t0}" "${t1}")"
  if awk -v s="${secs}" -v l="${limit}" 'BEGIN { exit !(s > l) }'; then
    result=fail
  fi
  if [[ "${target}" == primary ]] \
    && [[ -n "$(docker ps --quiet --filter name='^pgaibench-standby$')" ]]; then
    wait_streaming 120 || result=fail
  fi
  printf '{"target":"%s","recovery_s":%s,' "${target}" "${secs}"
  printf '"limit_s":%s,"recovery_test":"%s"}\n' "${limit}" "${result}"
}

main "$@"
