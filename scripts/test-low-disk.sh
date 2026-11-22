#!/bin/sh
# Opt-in low-disk verification for #185. Needs passwordless sudo for a tiny tmpfs.
# Usage: scripts/test-low-disk.sh   (from the repository root, in a Linux environment)
set -eu
d=$(mktemp -d /tmp/margarita-tiny-XXXXXX)
cleanup() {
  sudo umount "$d" 2>/dev/null || true
  rmdir "$d" 2>/dev/null || true
}
trap cleanup EXIT
sudo mount -t tmpfs -o size=128k tmpfs "$d"
MARGARITA_TINY_DIR="$d" bun test test/linux/persistence.test.ts -t "low disk"
