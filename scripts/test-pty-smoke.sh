#!/bin/sh
# Runs every POSIX PTY scenario (#181/#182) against a disposable stub service.
# Usage: scripts/test-pty-smoke.sh [dist/marg]   (Linux; needs python3 and bun)
set -eu
bin=$(realpath "${1:-dist/marg}")
root=$(mktemp -d)
stub=
cleanup() {
  [ -n "$stub" ] && kill "$stub" 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT INT TERM
STUB_LOG="$root/stub.log" bun test/smoke/stub-server.ts "$root/port" >/dev/null 2>&1 &
stub=$!
i=0
while [ ! -s "$root/port" ] && [ "$i" -lt 40 ]; do
  i=$((i + 1))
  sleep 0.25
done
port=$(cat "$root/port")
url="http://127.0.0.1:$port"
for scenario in ctrl-c keys mouse editor editor-fail sigterm resize crash; do
  STUB_LOG="$root/stub.log" python3 test/smoke/pty-smoke.py "$bin" "$url" "$scenario"
done
echo "PTY scenario suite passed"
