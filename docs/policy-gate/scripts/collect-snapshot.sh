#!/usr/bin/env bash
# Collect Σ from one node. Run once per node (primary and each standby).
# Usage: scripts/collect-snapshot.sh "<libpq conninfo>" <node-label> [outdir]
# Example: scripts/collect-snapshot.sh "host=10.0.0.2 dbname=bench user=postgres" standby1 out/
set -euo pipefail

CONN="${1:?conninfo required}"
LABEL="${2:?node label required}"
OUT="${3:-out}"
SQL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../sql" && pwd)"
mkdir -p "$OUT"

PSQL=(psql "$CONN" -X -q -A -t -v ON_ERROR_STOP=1)

"${PSQL[@]}" -f "$SQL_DIR/snapshot.sql" > "$OUT/$LABEL.snapshot.json"

if "${PSQL[@]}" -c "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'" | grep -q 1; then
  "${PSQL[@]}" -f "$SQL_DIR/snapshot_pgss.sql" > "$OUT/$LABEL.pgss.json"
else
  echo "[]" > "$OUT/$LABEL.pgss.json"
  echo "NOTE: pg_stat_statements not installed on $LABEL; U-1 will be weak." >&2
fi

if command -v python3 >/dev/null 2>&1; then
  python3 -m json.tool "$OUT/$LABEL.snapshot.json" > /dev/null
  python3 -m json.tool "$OUT/$LABEL.pgss.json" > /dev/null
fi
echo "wrote $OUT/$LABEL.snapshot.json and $OUT/$LABEL.pgss.json"
