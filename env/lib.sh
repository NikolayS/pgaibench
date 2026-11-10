#!/usr/bin/env bash
# Shared helpers for the env/ scripts. Sourced, not executed.
# All scripts run on the VM as root, from /opt/pgaibench/env.
# shellcheck disable=SC2034 # Constants are used by the sourcing scripts.

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly ENV_DIR
readonly DATA=/data
readonly SNAP="${DATA}/snap"
readonly BASE_TAG=18.4
readonly NEW_TAG=18.6
readonly TAGS_FILE="${DATA}/pg/tags.env"
export PGPASSWORD=pgaibench

err() {
  echo "ERROR: $*" >&2
}

log() {
  echo "[$(date -u +%H:%M:%S)] $*" >&2
}

# Map a port to the container that serves it.
container_for_port() {
  local port="$1"
  case "${port}" in
    5432) echo pgaibench-primary ;;
    5433) echo pgaibench-standby ;;
    5599) echo pgaibench-verify ;;
    *) echo "pgaibench-clone-$((port - 5500))" ;;
  esac
}

# psql against a port. Extra args are passed to psql. Does not read
# stdin (safe inside scripts piped over ssh); use pg_sql_stdin for that.
# Usage: pg_sql <port> --command="select 1"
pg_sql() {
  _pg_sql "" "$@"
}

# Same as pg_sql, but feeds stdin to psql (e.g. --file=-).
pg_sql_stdin() {
  _pg_sql --interactive "$@"
}

_pg_sql() {
  local stdin_flag="$1"
  local port="$2"
  shift 2
  docker exec ${stdin_flag:+"${stdin_flag}"} \
    "$(container_for_port "${port}")" \
    env PAGER=cat psql \
    --no-psqlrc \
    --host=127.0.0.1 \
    --port="${port}" \
    --username=postgres \
    --dbname=app \
    --set=ON_ERROR_STOP=1 \
    --quiet \
    "$@"
}

# Single value from a query.
pg_val() {
  local port="$1"
  local query="$2"
  pg_sql "${port}" --tuples-only --no-align --command="${query}"
}

# Settings saved with the base backup can exceed the primary's current values
# when WAL contains an earlier parameter-change record.
backup_recovery_settings() {
  local backup_dir="$1" tag="$2" line
  local auto_conf="${backup_dir}/postgresql.auto.conf"
  if [[ -f "${auto_conf}" ]]; then
    awk -F= '/^[[:space:]]*(max_locks_per_transaction|max_connections|max_prepared_transactions|max_worker_processes|max_wal_senders)[[:space:]]*=/ {
      name=$1; value=$2; gsub(/[[:space:]]/, "", name); sub(/[[:space:]]*#.*/, "", value);
      gsub(/[[:space:]\047]/, "", value);
      if (value ~ /^[0-9]+$/) print name "=" value
    }' "${auto_conf}"
  fi
  if line="$(docker run --rm --entrypoint pg_controldata \
    --volume "${backup_dir}:/backup:ro" "pgaibench-pg:${tag}" /backup 2>/dev/null)"; then
    awk -F: '/^max_connections setting:|^max_prepared_xacts setting:|^max_locks_per_xact setting:|^max_wal_senders setting:|^max_worker_processes setting:/ {
      name=$1; value=$2; gsub(/[[:space:]]/, "", value);
      if (value !~ /^[0-9]+$/) next;
      if (name == "max_prepared_xacts setting") name="max_prepared_transactions";
      else if (name == "max_locks_per_xact setting") name="max_locks_per_transaction";
      else sub(/ setting$/, "", name);
      print name "=" value
    }' <<< "${line}"
  else
    err "backup pg_controldata unavailable; using auto.conf and primary settings"
  fi
}

# Fill an argument array with the largest available primary and backup values.
recovery_settings_args() {
  local backup_dir="${1:-${DATA}/backup/base}" tag="${2:-${PRIMARY_TAG:-${BASE_TAG}}}"
  local rows name value previous
  local max_locks_per_transaction="" max_connections=""
  local max_prepared_transactions="" max_worker_processes="" max_wal_senders=""
  RECOVERY_ARGS=()
  if ! rows="$(pg_val 5432 "select name || '=' || setting from pg_settings
    where name in ('max_locks_per_transaction', 'max_connections',
      'max_prepared_transactions', 'max_worker_processes',
      'max_wal_senders')" 2>/dev/null)"; then
    err "primary settings unavailable; using pgaibench.conf without recovery -c overrides"
    return 0
  fi
  while IFS='=' read -r name value; do
    case "${name}" in
      max_locks_per_transaction|max_connections|max_prepared_transactions|max_worker_processes|max_wal_senders)
        if [[ "${value}" =~ ^[0-9]+$ ]]; then
          previous="${!name}"
          if [[ -z "${previous}" ]] || ((10#${value} > 10#${previous})); then
            printf -v "${name}" '%s' "${value}"
          fi
        else
          err "primary ${name} has invalid value: ${value:-<empty>}"
        fi ;;
    esac
  done <<< "${rows}"
  rows="$(backup_recovery_settings "${backup_dir}" "${tag}")"
  while IFS='=' read -r name value; do
    case "${name}" in
      max_locks_per_transaction|max_connections|max_prepared_transactions|max_worker_processes|max_wal_senders)
        if [[ "${value}" =~ ^[0-9]+$ ]]; then
          previous="${!name}"
          if [[ -z "${previous}" ]] || ((10#${value} > 10#${previous})); then
            printf -v "${name}" '%s' "${value}"
          fi
        fi ;;
    esac
  done <<< "${rows}"
  for name in max_locks_per_transaction max_connections max_prepared_transactions max_worker_processes max_wal_senders; do
    if [[ -n "${!name}" ]]; then
      RECOVERY_ARGS+=(-c "${name}=${!name}")
    else
      err "${name} unavailable from primary and backup; using pgaibench.conf"
    fi
  done
}

# A single retry may need values above both the backup and current primary.
double_recovery_settings_args() {
  local i setting name value
  for ((i=1; i<${#RECOVERY_ARGS[@]}; i+=2)); do
    setting="${RECOVERY_ARGS[i]}" name="${setting%%=*}" value="${setting#*=}"
    RECOVERY_ARGS[i]="${name}=$((10#${value} * 2))"
  done
}

# Wait until the server on <port> accepts queries. Prints nothing.
# Fails at once when the container has exited (a startup failure; the
# compose restart policy is "no", so it does not come back by itself).
wait_ready() {
  local port="$1"
  local timeout="${2:-300}"
  local c status
  c="$(container_for_port "${port}")"
  local deadline=$((SECONDS + timeout))
  until docker exec "${c}" pg_isready --host=127.0.0.1 --port="${port}" \
    --quiet 2>/dev/null \
    && pg_val "${port}" "select 1" >/dev/null 2>&1; do
    status="$(docker inspect --format '{{.State.Status}}' "${c}" 2>/dev/null \
      || true)"
    if [[ "${status}" == exited || "${status}" == dead ]]; then
      err "container ${c} is ${status}; server on port ${port} did not start"
      return 1
    fi
    if ((SECONDS > deadline)); then
      err "server on port ${port} not ready after ${timeout}s"
      return 1
    fi
    sleep 0.2
  done
}

# Wait until the standby streams from the primary.
wait_streaming() {
  local timeout="${1:-300}"
  local deadline=$((SECONDS + timeout))
  until [[ "$(pg_val 5432 "select count(*) from pg_stat_replication
    where state = 'streaming'" 2>/dev/null)" == "1" ]]; do
    if ((SECONDS > deadline)); then
      err "standby is not streaming after ${timeout}s"
      return 1
    fi
    sleep 0.5
  done
}

# Require the standby to replay through a primary LSN captured after restart.
wait_standby_replay() {
  local timeout="${1:-60}"
  local target_lsn deadline replayed paused
  deadline=$((SECONDS + timeout))
  while true; do
    if [[ -z "${target_lsn:-}" ]]; then
      target_lsn="$(pg_val 5432 'select pg_current_wal_lsn()' 2>/dev/null || true)"
    fi
    local streaming
    streaming="$(pg_val 5432 "select count(*) from pg_stat_replication
      where state = 'streaming'" 2>/dev/null || true)"
    replayed=""
    if [[ -n "${target_lsn}" && "${streaming}" == 1 ]]; then
      replayed="$(pg_val 5433 "select pg_wal_lsn_diff(pg_last_wal_replay_lsn(), '${target_lsn}') >= 0" 2>/dev/null || true)"
    fi
    paused="$(pg_val 5433 'select pg_is_wal_replay_paused()' 2>/dev/null || true)"
    if [[ "${streaming}" == 1 && "${replayed}" == t && "${paused}" == f ]]; then
      return 0
    fi
    if ((SECONDS >= deadline)); then
      err "standby did not replay through primary LSN ${target_lsn:-unavailable} within ${timeout}s (streaming/caught_up=${streaming:-unavailable}/${replayed:-unavailable}, replay_paused=${paused:-unavailable}, primary LSN ${target_lsn:-unavailable})"
      return 1
    fi
    sleep 0.5
  done
}

# Load PRIMARY_TAG and STANDBY_TAG (defaults: BASE_TAG).
load_tags() {
  PRIMARY_TAG="${BASE_TAG}"
  STANDBY_TAG="${BASE_TAG}"
  if [[ -f "${TAGS_FILE}" ]]; then
    # shellcheck disable=SC1090 # Generated file with two assignments.
    source "${TAGS_FILE}"
  fi
  export PRIMARY_TAG STANDBY_TAG
}

save_tags() {
  printf 'PRIMARY_TAG=%s\nSTANDBY_TAG=%s\n' "${PRIMARY_TAG}" \
    "${STANDBY_TAG}" > "${TAGS_FILE}"
}

compose() {
  load_tags
  docker compose --project-name pgaibench \
    --file "${ENV_DIR}/docker-compose.yml" "$@"
}

# Build pgaibench-pg:<tag> (official postgres:<tag> plus pg_cron).
build_image() {
  local tag="$1"
  if docker image inspect "pgaibench-pg:${tag}" >/dev/null 2>&1; then
    return 0
  fi
  log "building pgaibench-pg:${tag}"
  docker build --quiet --build-arg "PG_TAG=${tag}" \
    --tag "pgaibench-pg:${tag}" "${ENV_DIR}/image" >/dev/null
}

now_s() {
  date +%s.%N
}

elapsed() {
  awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", b - a }'
}

# Start container pgaibench-clone-<n> on port 5500+n over /data/clone/<n>.
# archive_mode stays on as in pgaibench.conf (a -c override of a postmaster
# setting leaves an error entry in pg_file_settings); the clone has no
# archive volume, so its archive command is a no-op.
run_clone_container() {
  local n="$1"
  local tag="$2"
  docker run --detach \
    --name "pgaibench-clone-${n}" \
    --network host \
    --shm-size 1g \
    --log-opt max-size=50m \
    --label "pgaibench.tag=${tag}" \
    --env PGDATA=/var/lib/postgresql/data \
    --volume "${DATA}/clone/${n}:/var/lib/postgresql/data" \
    --volume "${ENV_DIR}/pg/pgaibench.conf:/etc/pgaibench/pgaibench.conf:ro" \
    "pgaibench-pg:${tag}" \
    postgres -c "port=$((5500 + n))" -c archive_command=/bin/true >/dev/null
}

# Image tag a clone runs with.
clone_tag() {
  docker inspect --format '{{ index .Config.Labels "pgaibench.tag" }}' \
    "pgaibench-clone-$1"
}

# Serialize state-changing scripts (seed, reset, snapshot) on this VM.
# Waits up to 15 minutes for another holder. Re-entrant via PGAIBENCH_LOCKED.
take_lock() {
  if [[ -n "${PGAIBENCH_LOCKED:-}" ]]; then
    return 0
  fi
  exec 9> /run/pgaibench.lock
  if ! flock --wait 900 9; then
    err "another env script holds /run/pgaibench.lock"
    exit 1
  fi
  export PGAIBENCH_LOCKED=1
}
