#!/bin/sh
# Opt-in Linux Secret Service round-trip against a PRIVATE session bus and keyring. It never
# touches the developer's login keyring: dbus-run-session creates a throwaway bus, and the
# keyring files live in a throwaway XDG_DATA_HOME (gnome-keyring otherwise reuses
# ~/.local/share/keyrings and would try to unlock the real login keyring).
# Needs: dbus-run-session, gnome-keyring-daemon, secret-tool (libsecret), bun.
set -eu
data="$(mktemp -d)"
trap 'rm -rf "$data"' EXIT
XDG_DATA_HOME="$data" dbus-run-session -- sh -c '
  echo "margarita-test-keyring" | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1
  MARGARITA_LIVE_KEYRING=1 MARGARITA_PRIVATE_KEYRING=1 bun test test/linux/secret-service-live.test.ts 2>&1
' </dev/null
