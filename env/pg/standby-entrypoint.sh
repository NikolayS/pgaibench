#!/usr/bin/env bash
# Standby entrypoint: clone the primary with pg_basebackup when the data
# dir is empty, then run postgres as a hot standby on port 5433.
set -Eeuo pipefail
readonly PGDATA=/var/lib/postgresql/data
mkdir -p "${PGDATA}"
chown postgres:postgres "${PGDATA}"
chmod 700 "${PGDATA}"
if [[ ! -s "${PGDATA}/PG_VERSION" ]]; then
  until pg_isready --host=127.0.0.1 --port=5432 --quiet; do
    sleep 1
  done
  gosu postgres pg_basebackup \
    --host=127.0.0.1 \
    --port=5432 \
    --username=postgres \
    --pgdata="${PGDATA}" \
    --wal-method=stream \
    --checkpoint=fast \
    --write-recovery-conf
fi
exec gosu postgres postgres -D "${PGDATA}" -c port=5433
