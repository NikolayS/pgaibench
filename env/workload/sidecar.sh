#!/usr/bin/env bash
# Scenario sidecar: one application query next to W_prod, for scenarios
# with lab_profile.sidecar only (C18). pgbench in prepared mode as the
# scenario's application role, in sessions of <session_s> seconds (a pool
# that replaces connections), until <seconds> have passed. One container
# (label pgaibench-wl, so the episode cleanup removes it) runs the whole loop.
# Usage: env/workload/sidecar.sh <seconds> <shape> <port> <clients> <session_s> <role>
# Output (stdout, one JSON line): {"version":"sidecar-v1","shape","start_epoch",
#   "seconds","tps_counts_1s":[...],"mean_ms","attempts"}
# Exit 1 when no transaction ran at all (no summary: the check is incomplete).
set -Eeuo pipefail
IFS=$'\n\t'
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

readonly SC_DIR="${ENV_DIR}/workload/sidecar"

usage() {
  err "usage: sidecar.sh <seconds> <shape> <port> <clients> <session_s> <role>"
  exit 2
}

main() {
  [[ "$#" == 6 ]] || usage
  local seconds="$1" shape="$2" port="$3" clients="$4" session_s="$5" role="$6"
  [[ "${seconds}" =~ ^[0-9]+$ ]] && ((seconds >= 1)) || usage
  [[ "${shape}" =~ ^[a-z0-9_]+$ && -f "${SC_DIR}/${shape}.sql" ]] || usage
  [[ "${port}" =~ ^[0-9]+$ ]] || usage
  [[ "${clients}" =~ ^[0-9]+$ ]] && ((clients >= 1 && clients <= 32)) || usage
  [[ "${session_s}" =~ ^[0-9]+$ ]] && ((session_s >= 1)) || usage
  [[ "${role}" =~ ^[a-z_][a-z0-9_]*$ ]] || usage
  load_tags
  local tmp jobs=$((clients < 4 ? clients : 4))
  tmp="$(mktemp -d "${PGAIBENCH_SIDECAR_TMP:-/tmp}/sc.XXXXXX")"
  chmod 777 "${tmp}"
  local start
  start="$(date +%s)"
  echo "${start}" > "${tmp}/start_epoch"
  local inner="i=0; end=\$((${start} + ${seconds}))
while (( \$(date +%s) < end )); do
  t=\$(( end - \$(date +%s) )); (( t > ${session_s} )) && t=${session_s}
  pgbench -n -M prepared -c ${clients} -j ${jobs} -T \$t -f /sc/${shape}.sql --log --aggregate-interval=1 --log-prefix=/out/a\$i -h 127.0.0.1 -p ${port} -U ${role} app > /out/a\$i.out 2>&1 || sleep 0.5
  i=\$((i + 1))
done
echo \$i > /out/attempts"
  timeout $((seconds + 60)) docker run --rm \
    --label "pgaibench-wl=sidecar-$$" \
    --network host \
    --env PGPASSWORD=pgaibench \
    --env "PGAPPNAME=${role}" \
    --volume "${SC_DIR}:/sc:ro" \
    --volume "${tmp}:/out" \
    --entrypoint bash \
    "pgaibench-pg:${PRIMARY_TAG}" \
    -c "${inner}" >/dev/null 2>&1 || true
  local attempts=0
  [[ -f "${tmp}/attempts" ]] && read -r attempts < "${tmp}/attempts"
  # Aggregate log line: interval_start num_transactions sum_latency_us ...
  find "${tmp}" -type f -name 'a*' ! -name '*.out' -print0 | xargs -0 cat 2>/dev/null \
    | awk -v s="${start}" -v n="${seconds}" -v shape="${shape}" -v att="${attempts}" '
      NF >= 3 { c[$1 - s] += $2; tot += $2; lat += $3 }
      END {
        if (tot == 0) exit 1
        printf "{\"version\":\"sidecar-v1\",\"shape\":\"%s\",\"start_epoch\":%d,\"seconds\":%d,\"tps_counts_1s\":[", shape, s, n
        for (i = 0; i < n; i++) printf "%s%d", (i ? "," : ""), c[i] + 0
        printf "],\"mean_ms\":%.6f,\"attempts\":%d}\n", lat / tot / 1000, att
      }'
}

main "$@"
