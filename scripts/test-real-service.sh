#!/bin/sh
# Opt-in (#186): runs the compiled marg binary under a PTY against a disposable real
# `opencode serve` (isolated XDG roots, random loopback port). Needs `opencode` on PATH.
# Never touches an existing OpenCode service. Usage: scripts/test-real-service.sh [dist/marg]
set -eu
bin=$(realpath "${1:-dist/marg}")
root=$(mktemp -d)
trap 'kill $pid 2>/dev/null || true; rm -rf "$root"' EXIT INT TERM
mkdir -p "$root/ws"
port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
cd "$root/ws"
XDG_DATA_HOME=$root/data XDG_CONFIG_HOME=$root/config XDG_CACHE_HOME=$root/cache XDG_STATE_HOME=$root/state \
  opencode serve --hostname 127.0.0.1 --port "$port" --print-logs >"$root/out.log" 2>&1 &
pid=$!
i=0
pw=
while [ $i -lt 60 ]; do
  pw=$(sed -n 's/.*[Pp]assword[^A-Za-z0-9]*\([A-Za-z0-9_-]\{8,\}\).*/\1/p' "$root/out.log" | head -1)
  [ -n "$pw" ] && break
  i=$((i+1)); sleep 0.5
done
[ -n "$pw" ] || { echo "no password announced"; cat "$root/out.log"; exit 1; }
cd - >/dev/null
export MARGARITA_SERVER_PASSWORD=$pw
for s in ctrl-c keys resize; do
  python3 test/smoke/pty-smoke.py "$bin" "http://127.0.0.1:$port" $s
done
echo "real-service smoke passed"
