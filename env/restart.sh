#!/usr/bin/env bash
# Clean restart of the primary, the standby or a clone (needed for
# settings with context postmaster, e.g. shared_buffers).
# Usage: env/restart.sh primary|standby|clone <n>
# Output: "restart <target> up downtime_s=<seconds> start_s=<epoch> end_s=<epoch>"
# once the server accepts queries, then "restart <target> ok downtime_s=<seconds> start_s=<epoch>
# end_s=<epoch>" on stdout (VM clock, the clock of the w_prod epochs).
# downtime_s = until the restarted server accepts queries (end_s); the script
# then also waits up to 60 s for the standby to stream and replay.
set -Eeuo pipefail
IFS=$'\n\t'
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  err "usage: restart.sh primary|standby|clone <n>"
  exit 2
}

main() {
  local target="${1:-}"
  local port container
  case "${target}" in
    primary) [[ "$#" == 1 ]] || usage; port=5432 ;;
    standby) [[ "$#" == 1 ]] || usage; port=5433 ;;
    clone)
      [[ "$#" == 2 ]] || usage
      [[ "${2:-}" =~ ^[0-9]+$ ]] || usage
      ((10#$2 >= 1 && 10#$2 <= 98)) || usage
      port=$((5500 + 10#$2))
      ;;
    *) usage ;;
  esac
  container="$(container_for_port "${port}")"
  if [[ "${target}" != standby ]]; then
    pg_sql "${port}" --command="checkpoint" >/dev/null
  fi
  local t0
  t0="$(now_s)"
  docker restart --time 120 "${container}" >/dev/null
  wait_ready "${port}"
  local downtime t1
  t1="$(now_s)"
  downtime="$(elapsed "${t0}" "${t1}")"
  if [[ "${target}" != clone ]]; then
    # The interval first: a replay wait that fails below still leaves it.
    echo "restart ${target} up downtime_s=${downtime} start_s=${t0} end_s=${t1}"
    wait_standby_replay 60
  fi
  echo "restart ${target} ok downtime_s=${downtime} start_s=${t0} end_s=${t1}"
}

main "$@"
