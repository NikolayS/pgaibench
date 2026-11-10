#!/usr/bin/env bash
# Seed the lab dataset from scratch on this VM (destroys /data):
# pgbench -i -s 100, extra tables from seed.sql, standby, base backup,
# then env/snapshot.sh create. Deterministic across VMs.
# Usage: env/seed.sh
# Output: timings on stderr; last line on stdout "seed ok <seconds>".
set -Eeuo pipefail
IFS=$'\n\t'
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

main() {
  take_lock
  local t0
  t0="$(now_s)"
  build_image "${BASE_TAG}"
  build_image "${NEW_TAG}"

  log "wiping /data"
  compose down --timeout 60 >/dev/null 2>&1 || true
  docker ps --all --quiet --filter name=pgaibench-clone- \
    | xargs --no-run-if-empty docker rm --force >/dev/null
  rm -rf "${DATA:?}/pg" "${DATA}/archive" "${DATA}/backup" "${SNAP}" \
    "${DATA}/clone"
  mkdir -p "${DATA}/pg/primary" "${DATA}/pg/standby" "${DATA}/archive" \
    "${DATA}/backup" "${DATA}/clone"
  # uid 999 is postgres in the official image.
  chown 999:999 "${DATA}/archive" "${DATA}/backup"
  export PRIMARY_TAG="${BASE_TAG}"
  export STANDBY_TAG="${BASE_TAG}"
  save_tags

  log "starting primary"
  compose up --detach primary >/dev/null
  wait_ready 5432 600

  log "pgbench -i -s 100"
  docker exec pgaibench-primary pgbench \
    --initialize \
    --scale=100 \
    --quiet \
    --host=127.0.0.1 \
    --port=5432 \
    --username=postgres \
    app >/dev/null 2>&1

  log "seed.sql"
  pg_sql_stdin 5432 --file=- < "${ENV_DIR}/seed.sql" >/dev/null
  pg_sql 5432 --command="checkpoint" >/dev/null

  log "starting standby (pg_basebackup)"
  compose up --detach standby >/dev/null
  wait_streaming 900

  log "base backup to /backup/base"
  docker exec --user postgres pgaibench-primary pg_basebackup \
    --host=127.0.0.1 \
    --port=5432 \
    --username=postgres \
    --pgdata=/backup/base \
    --wal-method=stream \
    --checkpoint=fast
  local first_wal
  first_wal="$(docker exec pgaibench-primary sed -n \
    's/^START WAL LOCATION: .* (file \(.*\))$/\1/p' \
    /backup/base/backup_label)"
  # Segments older than the backup are not needed for verification.
  docker exec --user postgres pgaibench-primary \
    pg_archivecleanup /archive "${first_wal}"

  pg_sql 5432 --command="select pg_stat_statements_reset()" >/dev/null
  "${ENV_DIR}/snapshot.sh" create >&2
  echo "seed ok $(elapsed "${t0}" "$(now_s)")"
}

main "$@"
