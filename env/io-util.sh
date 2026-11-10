#!/usr/bin/env bash
# Disk utilization of the data disk, sampled every second from
# /proc/diskstats (io_ticks).
# Usage: env/io-util.sh <seconds> [--json]
# Output: max sustained util percent = max 10 s rolling mean, e.g. "37.5".
#   With --json: {"io_util_pct":..,"max_1s_pct":..,"mean_pct":..,
#                 "seconds_over_90":..,"device":"sda","samples":[..]}
set -Eeuo pipefail
IFS=$'\n\t'

readonly WINDOW=10

io_ticks() {
  awk -v d="$1" '$3 == d { print $13 }' /proc/diskstats
}

main() {
  local seconds="${1:-}"
  local mode="${2:-}"
  if [[ ! "${seconds}" =~ ^[0-9]+$ ]] || ((seconds < 1)); then
    echo "usage: io-util.sh <seconds> [--json]" >&2
    exit 2
  fi
  local src dev
  src="$(findmnt --noheadings --output SOURCE --target /data 2>/dev/null \
    || findmnt --noheadings --output SOURCE --target /)"
  dev="$(lsblk --noheadings --output PKNAME "${src}" | head -1)"
  if [[ -z "${dev}" ]]; then
    dev="$(basename "${src}")"
  fi
  local samples=() prev cur i
  prev="$(io_ticks "${dev}")"
  for ((i = 0; i < seconds; i++)); do
    sleep 1
    cur="$(io_ticks "${dev}")"
    samples+=("$(((cur - prev) / 10))")
    prev="${cur}"
  done
  local csv
  csv="$(IFS=,; echo "${samples[*]}")"
  awk -v csv="${csv}" -v w="${WINDOW}" -v mode="${mode}" -v dev="${dev}" '
    BEGIN {
      n = split(csv, s, ",")
      for (i = 1; i <= n; i++) {
        if (s[i] > 100) s[i] = 100
        sum += s[i]
        if (s[i] > max1) max1 = s[i]
        if (s[i] > 90) over++
      }
      ww = (n < w) ? n : w
      for (i = ww; i <= n; i++) {
        t = 0
        for (j = i - ww + 1; j <= i; j++) t += s[j]
        if (t / ww > maxw) maxw = t / ww
      }
      if (mode != "--json") { printf "%.1f\n", maxw; exit }
      printf "{\"io_util_pct\":%.1f,\"max_1s_pct\":%d,", maxw, max1
      printf "\"mean_pct\":%.1f,\"seconds_over_90\":%d,", sum / n, over
      printf "\"device\":\"%s\",\"samples\":[%s]}\n", dev, csv
    }'
}

main "$@"
