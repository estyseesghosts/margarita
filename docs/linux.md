# Margarita on Linux

This page separates what is **CI-verified**, **manually verified** and **untested**. Do not read anything outside the first two columns as a promise.

## Support matrix

| Area | Status | Evidence |
| --- | --- | --- |
| Source gate (`bun run verify`) on x86_64 glibc | CI-verified (Ubuntu) and manually verified (Fedora 44 under WSL2) | `.github/workflows/verify.yml` |
| `bun run build bun-linux-x64` produces a standalone binary | CI-verified (Ubuntu, `verify.yml` and the tagged `release.yml`) and manually verified (Fedora 44) | ADR-0006 |
| Binary starts outside the checkout without Bun or `node_modules` | Manually verified (Fedora 44) | `--version`, `--help`, PTY smoke |
| Interactive renderer paints and exits 0 under a PTY, terminal restored | CI-verified (Ubuntu) and manually verified (Fedora 44) | `scripts/test-pty-smoke.sh`, `test/smoke/pty-smoke.py` |
| PTY scenarios: Unicode typing, bracketed paste, mouse SGR, Ctrl+G editor round trip/failure, SIGTERM, repeated resize, SIGKILL harness | CI-verified (Ubuntu) and manually verified (Fedora 44 under WSL2) | `scripts/test-pty-smoke.sh` |
| tmux 3.x semantic smoke: Unicode typing and grapheme backspace, Ctrl+J, bracketed paste, F1 help, modified keys, resize, Ctrl+C | CI-verified (Ubuntu) and manually verified (Fedora 44 under WSL2) | `scripts/test-tmux.sh` |
| Secret Service credentials (`secret-tool`) round trip | Manually verified against a private gnome-keyring (Fedora 44) | `scripts/test-keyring.sh` |
| Real terminal emulators (Ghostty, kitty, GNOME Terminal), SSH | **Untested**; record observations in `docs/smoke-matrix.md` | #181, #182, #184 |
| Failed save on a full filesystem keeps previous state | CI-verified on a 128 KiB tmpfs (Ubuntu) and manually verified (Fedora 44) | `scripts/test-low-disk.sh` |
| XDG paths, `0700` state dir, `0600` files, concurrent/killed lock recovery | CI-verified (Ubuntu) and manually verified natively (Fedora 44: 9 pass, 1 skip) | `test/linux/persistence.test.ts` |
| ARM64 and musl builds | **Unsupported**: build refuses them (native packages not installed); evaluation recorded in ADR-0006 | #188 |
| Ubuntu/Debian native run | **Untested** | – |
| Local OpenCode v2.3.0 sessions end to end on Linux | Manually verified (Fedora 44 under WSL2): `bun run test:writable` passes 15/15 against a disposable `opencode serve` 2.3.0 (prompt flow, permissions, forms, fork/revert, events, directories) | #186 |
| Compiled `marg` against a real disposable `opencode serve` 2.3.0 (PTY: paint, keys, resize, Ctrl+C exit 0, terminal restored) | Manually verified (Fedora 44 under WSL2) | `scripts/test-real-service.sh` |
| Remote OpenCode servers over a real network; Linux client → Windows server (drive/UNC `--cwd`) | **Untested**: contract fixtures only; manual scenario below | #186 |

## Requirements

- x86_64 Linux with glibc. The compiled binary imports glibc symbols up to `GLIBC_2.17` (measured on the Fedora 44 build); a binary is only as portable as the glibc it was built against, so build on the oldest distribution you intend to run on.
- Bun is needed only to build from source (the version in `.bun-version`, currently 1.4.4). The compiled binary embeds Bun and OpenTUI's native library.
- An existing OpenCode v2 service. Margarita never starts or reconfigures it. Discovery finds a local service; otherwise pass `--server <url>` or pair a remote with `/pair`.
- Optional, for authenticated paired servers: `secret-tool` (Fedora: `libsecret`; Debian/Ubuntu: `libsecret-tools`) and a Secret Service provider running in your login session (gnome-keyring, KeePassXC). Without it, anonymous servers keep working and authenticated profiles fail closed; there is never a plaintext fallback. Headless and SSH sessions normally have no provider; use `MARGARITA_SERVER_PASSWORD` for a direct connection there.

## Build and run

```sh
git clone https://github.com/estyseesghosts/margarita.git
cd margarita
bun install --frozen-lockfile
bun run verify                  # optional but recommended
bun run build bun-linux-x64     # writes dist/marg
install -m 0755 dist/marg ~/.local/bin/marg
marg --version
```

`bun run build` fixes OpenTUI's libc at compile time (`process.env.OPENTUI_LIBC`, `glibc` for the default Linux targets), so no runtime environment variable is needed.

## Where state lives

Config and state follow the XDG base directories: `$XDG_CONFIG_HOME` (default `~/.config`) and `$XDG_STATE_HOME` (default `~/.local/state`). Margarita does not read or write OpenCode's own directories. The state directory is created `0700`; state files are created `0600`.

## Troubleshooting

- **`GLIBC_x.y not found`**: the binary was built on a newer glibc than this machine has. Rebuild on the older machine.
- **Native library or loader errors at startup**: confirm the file is the Linux x64 build (`file marg`), is executable, and that your temporary directory is writable and not mounted `noexec` (embedded native libraries may be extracted there; not yet confirmed for this build).
- **Keys such as Ctrl+Enter do nothing**: your terminal does not speak the kitty keyboard protocol. Use F6 to steer. Report the terminal, `TERM` and version.
- **Copy does nothing**: OSC 52 is an emitted sequence, not an acknowledged copy. tmux needs `set -g set-clipboard on`; some terminals disable OSC 52 by default. Over-limit text is written to a local file whose path is shown.
- **Credential errors**: the message distinguishes a locked keyring, an unreachable session bus and a missing `secret-tool`. Unlock the keyring, start a provider, or install the package above.
- **Terminal left in a strange state after a crash**: run `reset` (or `stty sane; tput rmcup`).

## Windows host with WSL2

WSL2 is a good place to build and run the source gate, but it does not replace native Linux terminals: the Windows terminal sits between your keyboard and the Linux PTY, so key and clipboard behaviour measured there says little about Ghostty, kitty or GNOME Terminal on a Linux desktop.

## Tests specific to Linux

- `scripts/test-pty-smoke.sh` and `test/smoke/pty-smoke.py`: every PTY scenario against a disposable stub (paint, keys/paste, mouse, editor round trip and failure, SIGTERM, resize, SIGKILL harness). CI-verified on Ubuntu.
- `scripts/test-tmux.sh`: semantic screen assertions inside tmux (typing, grapheme backspace, Ctrl+J, bracketed paste, F1, modified keys, resize, Ctrl+C). CI-verified on Ubuntu.
- `scripts/test-low-disk.sh`: mounts a 128 KiB tmpfs and exercises the failed-save path. CI-verified on Ubuntu.
- `scripts/test-keyring.sh`: opt-in Secret Service round trip against a throwaway session bus and keyring (needs `dbus-run-session`, `gnome-keyring-daemon`, `secret-tool`).

## Clipboard (OSC 52) and attachments

| Path | Behaviour | Status |
| --- | --- | --- |
| TTY, `TERM` not `dumb`, payload ≤ 4096 base64 bytes | one OSC 52 set sequence; the notice says "emitted (no terminal acknowledgement)" | unit-tested (`src/app/clipboard.test.ts`) |
| no TTY, `TERM=dumb`, over the limit | exact text written to an owner-only (`0600`, created that way) file under the state directory; the notice shows the path | unit-tested |
| Ghostty, kitty, GNOME Terminal, tmux (`set -g set-clipboard on`), SSH | whether the terminal honours or filters OSC 52 | **untested** |
| Clipboard image paste, `file://` and quoted-path attachments | existing paste tests cover PNG/JPEG/WebP/PDF classification and rejected binaries; terminal delivery of raw clipboard images varies | emulator behaviour **untested** |

## Keyboard and paste

The PTY `keys` scenario drives the compiled binary under a real POSIX PTY with `TERM=xterm-256color`: Unicode typing, grapheme-wise backspace, Ctrl+J multi-line editing, a bracketed multi-line paste, Escape/Alt+P dismissal, Ctrl+O/R/S/T/B and F6 must paint correctly and must not cause any server write. The tmux smoke additionally asserts the *current screen* for Unicode typing and backspace, bracketed paste, F1 help, modified keys, resize with the draft kept, and Ctrl+C exit 0. Kitty-versus-legacy negotiation is exercised only through tmux's own key translation; Ghostty, kitty, GNOME Terminal and SSH behaviour remain **untested** and must be recorded (TERM, protocol, version, deviations) in `docs/smoke-matrix.md` before adding any terminal-specific branch.

## Terminal lifecycle

`scripts/test-pty-smoke.sh` covers: clean Ctrl+C exit, SIGTERM, repeated SIGWINCH down to 8 columns and back with the draft intact, Ctrl+G with an `EDITOR` path containing spaces and `$` (draft round-trips, temp directory removed), an editor that exits non-zero (notice shown, draft kept), and a SIGKILL harness case where terminal modes cannot be restored by definition. Every non-crash scenario checks that the cursor is re-shown and mouse reporting is disabled. Not covered: interactive `vi`/`nano`, tmux/SSH lifecycle, and real emulator behaviour.

## Manual scenario: remote servers (#186)

With two machines you control: start `opencode serve` on the remote with its own throwaway XDG roots, then from Linux run `marg --server http://host:port --cwd <absolute path on the remote>` (Windows remote: `C:\proj`; Linux remote: check `/srv/App` and `/srv/app` stay separate sessions). Verify first prompt, `--continue`, `--resume`, model change, queue/steer, interrupt, a permission prompt, reconnect after briefly stopping the server, and clean exit. Record results in `docs/smoke-matrix.md`.
