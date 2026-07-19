#!/bin/sh
set -eu

command_name="${1:-api}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command_name" in
  api|worker|relay|migrate|preflight)
    exec node "/app/dist/bin/${command_name}.js" "$@"
    ;;
  admin)
    exec node /app/dist/bin/admin.js "$@"
    ;;
  *)
    echo "unknown runtime command: $command_name" >&2
    echo "expected one of: api, worker, relay, migrate, preflight, admin" >&2
    exit 64
    ;;
esac
