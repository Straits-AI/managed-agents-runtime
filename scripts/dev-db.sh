#!/usr/bin/env bash
# Start (or reset) a native PostgreSQL 16 instance for dev/tests, for
# environments without a Docker daemon. Runs the server as the `postgres`
# system user when invoked as root.
#
# Usage: scripts/dev-db.sh [start|stop|reset|status]
set -euo pipefail

PG_BIN=/usr/lib/postgresql/16/bin
DATA_DIR="${MA_PGDATA:-/var/lib/postgresql/managed-agents-pg}"
PORT="${MA_PGPORT:-5433}"
DB_NAME=managed_agents
LOG_FILE="$DATA_DIR/server.log"

as_pg() {
  if [ "$(id -u)" = "0" ]; then
    setpriv --reuid=postgres --regid=postgres --clear-groups -- "$@"
  else
    "$@"
  fi
}

cmd="${1:-start}"

case "$cmd" in
  start)
    if [ ! -d "$DATA_DIR" ]; then
      mkdir -p "$DATA_DIR"
      [ "$(id -u)" = "0" ] && chown postgres:postgres "$DATA_DIR"
      as_pg "$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres >/dev/null
    fi
    if ! as_pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" status >/dev/null 2>&1; then
      as_pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
        -o "-p $PORT -c listen_addresses=127.0.0.1 -c fsync=off -c unix_socket_directories=/tmp" \
        start >/dev/null
    fi
    as_pg "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 ||
      as_pg "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U postgres "$DB_NAME"
    echo "postgres ready: postgres://postgres@127.0.0.1:$PORT/$DB_NAME"
    ;;
  stop)
    as_pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" stop -m fast >/dev/null 2>&1 || true
    echo "stopped"
    ;;
  reset)
    "$0" stop
    rm -rf "$DATA_DIR"
    "$0" start
    ;;
  status)
    as_pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" status
    ;;
  *)
    echo "usage: $0 [start|stop|reset|status]" >&2
    exit 2
    ;;
esac
