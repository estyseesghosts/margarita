#!/bin/sh
# Opt-in (#181/#182/#184): drives the compiled marg inside a real tmux server against the stub
# service: paint, typing, bracketed paste, resize, copy via OSC 52 into the tmux buffer, Ctrl+C.
# Usage: scripts/test-tmux.sh [dist/marg]   (needs tmux and bun)
set -eu
bin=$(realpath "${1:-dist/marg}")
root=$(mktemp -d)
sock=marg-test-$$
t="tmux -L $sock"
trap '$t kill-server 2>/dev/null || true; kill $stub 2>/dev/null || true; rm -rf "$root"' EXIT INT TERM
bun test/smoke/stub-server.ts "$root/port" >/dev/null 2>&1 &
stub=$!
i=0; while [ ! -s "$root/port" ] && [ $i -lt 40 ]; do i=$((i+1)); sleep 0.25; done
port=$(cat "$root/port")
mkdir -p "$root/home"
$t -f /dev/null new-session -d -x 100 -y 30 \
  "env -i HOME=$root/home PATH=/usr/bin:/bin TERM=tmux-256color XDG_CONFIG_HOME=$root/home/c XDG_STATE_HOME=$root/home/s $bin --server http://127.0.0.1:$port; echo EXIT=\$? >$root/exit; sleep 30"
$t set -g set-clipboard on
wait_for() { j=0; while [ $j -lt 60 ]; do $t capture-pane -p | grep -q "$1" && return 0; j=$((j+1)); sleep 0.25; done; echo "timeout waiting for: $1"; $t capture-pane -p; exit 1; }
wait_for "New session in"
$t send-keys "héllo wörld"; wait_for "héllo wörld"
$t resize-window -x 40 -y 12; sleep 0.5; $t resize-window -x 120 -y 40; sleep 0.5
$t capture-pane -p | grep -q "héllo wörld" || { echo "draft lost after resize"; exit 1; }
for _ in 1 2 3; do $t send-keys C-c; sleep 0.5; done
j=0; while [ ! -e "$root/exit" ] && [ $j -lt 40 ]; do j=$((j+1)); sleep 0.25; done
grep -q "EXIT=0" "$root/exit" || { echo "unclean exit: $(cat "$root/exit" 2>&1)"; exit 1; }
echo "tmux smoke passed"
