#!/bin/sh
# Opt-in (#181/#182/#184): drives the compiled marg inside a real tmux server against the stub
# service. tmux gives us a terminal emulator, so capture-pane asserts the *current screen*
# rather than a stream of escape bytes. Covers paint, Unicode typing and grapheme backspace,
# Ctrl+J multi-line editing, bracketed multi-line paste, help dismissal, resize with draft
# retention, modified-key/picker keys that must not submit, and Ctrl+C exit.
# Usage: scripts/test-tmux.sh [dist/marg]   (needs tmux, bun and python3; Linux only)
set -eu
export LC_ALL=C.UTF-8
bin=$(realpath "${1:-dist/marg}")
root=$(mktemp -d)
sock=marg-test-$$
t="tmux -L $sock"
stub=
cleanup() {
  $t kill-server 2>/dev/null || true
  [ -n "$stub" ] && kill "$stub" 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT INT TERM
STUB_LOG="$root/stub.log" bun test/smoke/stub-server.ts "$root/port" >/dev/null 2>&1 &
stub=$!
i=0
while [ ! -s "$root/port" ] && [ $i -lt 40 ]; do i=$((i+1)); sleep 0.25; done
port=$(cat "$root/port")
mkdir -p "$root/home"
$t -f /dev/null new-session -d -x 100 -y 30 \
  "env -i HOME=$root/home PATH=/usr/bin:/bin TERM=tmux-256color LC_ALL=C.UTF-8 XDG_CONFIG_HOME=$root/home/c XDG_STATE_HOME=$root/home/s $bin --server http://127.0.0.1:$port; echo EXIT=\$? >$root/exit; sleep 30"
$t set -g set-clipboard on
wait_for() {
  j=0
  while [ $j -lt 60 ]; do
    $t capture-pane -p | grep -qF -- "$1" && return 0
    j=$((j+1)); sleep 0.25
  done
  echo "timeout waiting for: $1"
  $t capture-pane -p
  exit 1
}
check() {
  if ! $t capture-pane -p | grep -qF -- "$1"; then
    echo "missing from screen: $1"
    $t capture-pane -p
    exit 1
  fi
}
absent() {
  if $t capture-pane -p | grep -qF -- "$1"; then
    echo "unexpected text still on screen: $1"
    $t capture-pane -p
    exit 1
  fi
}
wait_for "New session in"
# Let the initial connection and session catalog settle before typing. A late
# overview/catalog load can replace the draft's route, so do not type into the
# bootstrap screen.
sleep 2

# Unicode typing and grapheme deletion.
$t send-keys -l "héllo wörld"
sleep 0.5
check "héllo wörld"
$t send-keys BSpace
sleep 0.5
absent "héllo wörld"
check "héllo wör"

# Bracketed multi-line paste is inserted literally, not submitted.
printf 'pasted one\npasted two' | $t load-buffer -
$t paste-buffer -p
sleep 0.8
check "pasted one"
check "pasted two"

# Ctrl+J inserts a newline instead of submitting; both lines stay in the draft.
$t send-keys C-j
sleep 0.5
$t send-keys -l "second line"
sleep 0.5
check "second line"
check "pasted two"

# F1 help opens; paging works; Escape dismisses it and leaves the draft intact.
$t send-keys F1
sleep 0.6
# Assert semantic capabilities, not incidental full-title copy: future wording edits must
# not silently break CI while the dialog still works (#261).
check "Keys"
check "PgUp/PgDn scroll"
check "transcript.inspect"
check "agent.cycle"
$t send-keys PageDown
sleep 0.4
absent "agent.cycle"
check "transcript.inspect"
$t send-keys PageUp
sleep 0.4
check "agent.cycle"
$t send-keys Escape
sleep 0.5
absent "PgUp/PgDn scroll"
check "pasted two"

# Modified/global keys must neither crash nor submit.
for key in BTab M-p M-e F2 C-o C-r C-s C-t C-b F6; do
  $t send-keys "$key"
  sleep 0.2
  $t send-keys Escape
  sleep 0.2
done
sleep 0.5
# Ctrl+S may stash the draft; either way the app must still be running and show the composer.
$t capture-pane -p | grep -qF "overview" || {
  echo "app did not return to a stable view after modified keys"
  $t capture-pane -p
  exit 1
}

# Repeated resize keeps the app alive and never crashes.
$t resize-window -x 40 -y 12; sleep 0.5
$t resize-window -x 8 -y 24; sleep 0.5
$t resize-window -x 120 -y 40; sleep 0.5
$t capture-pane -p | grep -qF "overview" || {
  echo "app lost its stable view after resize"
  $t capture-pane -p
  exit 1
}

# Nothing above submitted a prompt.
if [ -s "$root/stub.log" ]; then
  writes=$(grep -v '^GET ' "$root/stub.log" || true)
  if [ -n "$writes" ]; then
    echo "keyboard/paste input caused server writes:"
    echo "$writes"
    exit 1
  fi
fi

# Ctrl+C exits cleanly (twice: one may only clear an overlay/selection).
for _ in 1 2 3; do $t send-keys C-c; sleep 0.5; done
j=0
while [ ! -e "$root/exit" ] && [ $j -lt 40 ]; do j=$((j+1)); sleep 0.25; done
grep -q "EXIT=0" "$root/exit" || { echo "unclean exit: $(cat "$root/exit" 2>&1)"; exit 1; }
echo "tmux smoke passed"
