#!/usr/bin/env bash
# Runs once at initdb on the primary: include lab settings and allow
# local streaming replication.
set -Eeuo pipefail
echo "include_if_exists = '/etc/pgaibench/pgaibench.conf'" >> "${PGDATA}/postgresql.conf"
echo "host replication all 127.0.0.1/32 scram-sha-256" >> "${PGDATA}/pg_hba.conf"
