# margarita

```
 /\_/\
( o.o )   
 > ^ <
```

![margarita](margarita.png)

**margarita** (`marg`) is a terminal frontend for the [OpenCode](https://opencode.ai) v2 server. it makes opencode feel more like claude or codex.

## Getting started

### What you need

- [Bun](https://bun.sh) **1.4.4** (see `.bun-version`)
- A running **OpenCode v2.3** service. margarita finds the one registered on your machine and connects to it **read-only**: it never starts, stops or reconfigures your service (unless you pass `--start-server` and none is registered).

### Option A: run from source

```sh
git clone https://github.com/estyseesghosts/margarita.git
cd margarita
bun install
bun run start            # same as `marg`
bun run start "fix the flaky test"
```

Want a real `marg` command? `bun link` registers it straight from source.

### Option B: build one self-contained executable

```sh
bun install
bun run build                  # → dist/marg.exe  (dist/marg on macOS and Linux)
bun run build bun-linux-x64    # cross-compile for another target
```

The result bundles the Bun runtime and OpenTUI's native library, so you can copy it anywhere on your `PATH`
(for example `%USERPROFILE%\.local\bin` on Windows or `~/.local/bin` elsewhere). More in [ADR-0006](adr/0006-packaging.md).

## Using `marg`

```sh
marg                                  # new session in this directory
marg "fix the flaky test"             # ...starting with a prompt
marg --continue                       # pick up the latest session here
marg --resume                         # open the session overview
marg --resume ses_123                 # jump to an exact session
marg -p -m opencode/longcat-2.5-free "summarize README.md"   # print mode (no TUI)
marg --help
```

Print mode is always explicit: giving a prompt never silently turns it on.

### Keys

| Key | Does |
| --- | --- |
| `Left` (empty prompt) | Open the overview |
| `Shift+Tab` | Cycle agents (`build` ↔ `plan`) |
| `Alt+P` / `F2` | Pick a model / use the recent one |
| `Ctrl+O` | Toggle detailed transcript |
| `Ctrl+R` | Search prompt history |
| `Ctrl+S` | Stash the current draft |
| `Ctrl+G` | Edit the prompt in `$EDITOR` |
| Paste an image or image path | Attach it (PNG, JPEG, GIF, WebP, AVIF, PDF) |
| `Backspace` (empty prompt) | Remove the newest attachment |
| `Ctrl+J` / `Ctrl+Enter` (or `Alt+Enter`) | Newline / steer the running agent |
| `Ctrl+T` | Goal and task checklist |
| `Ctrl+B` | Move running tools to the background |
| `Ctrl+C` | Interrupt, clear, then exit |
| `F1` | Help |

Everything is a single key press. There are no chords. Rebind any of them in the config below.

### Attachments

Paste a screenshot from the clipboard, or paste the path of an image/PDF file (quoted paths with spaces work). It appears as a chip above the input, is sent as an inline OpenCode prompt file, and works the same against a local or remote (`--server`) service. `Backspace` on an empty input removes the newest chip. Text pastes, bracketed pastes and multiline code behave as before.

Terminals that cannot deliver clipboard images (for example Windows Terminal pasting a raw bitmap, or a WSL/SSH session) should paste the file path instead; a path that is not a supported file is still inserted as text. Binary data that is not a recognised image is refused rather than decoded into the prompt. Attachments are capped at 20 MB each.

### Slash commands

`/goal <objective>` · `/criteria a; b` · `/plan step one; step two` · `/plan propose` · `/plan adopt` ·
`/rename` · `/fork` · `/revert` · `/diff [turn]` · `/export [file]` · `/compact`

`/goal` talks to the native OpenCode `opencode.goal` plugin (the same one OpenCode's own TUI drives): `/goal <objective>`, `/goal` status, `/goal pause|resume|clear`. Plans and acceptance criteria stay local under margarita's state directory and are supplemental; they are never mirrored to the agent.

`/compact` asks OpenCode to compact the session's context through the same native v2 endpoint its own clients use. The request works while the session is idle or mid-turn; no prompt is sent to the agent, and the session's pending items are untouched. The request is only an acceptance — compaction progress and its result show up in the transcript ("Compacting conversation" → "Conversation compacted" or "Compaction failed").

### Remote servers

Pair an OpenCode v2 server on another machine from inside margarita:

```sh
# on the remote machine
opencode serve --service
opencode pair --remote          # prints a one-time link, valid for five minutes

# in margarita
/pair https://host.example/auth/connect/<code> --as buildbox
/servers                        # list local and paired servers
/servers rename buildbox devbox
/unpair devbox
```

Or point at a URL you already know (no one-time code):

```sh
/pair --url https://host.example --as buildbox
```

Manual pairing asks for the password through the secure credential flow, not the composer
history. `MARGARITA_SERVER_PASSWORD` still works for a direct `--server` connection.

Servers behind a path-prefixed reverse proxy are supported: point `/pair` at
`https://host.example/opencode/auth/connect/<code>` (or `/pair --url https://host.example/opencode --as buildbox`)
and every request — the pairing redemption, `/api/info`, the API client and the event
stream — stays beneath `/opencode`. Redirects of any kind are never followed, so a pairing
link or token is never sent anywhere the proxy forwards it. HTTPS policy is unchanged.

From Bash or PowerShell:

```sh
marg --remote buildbox                                  # unified overview, buildbox selected
marg --remote buildbox --cwd /home/me/app               # server-side directory
marg --remote buildbox --cwd /home/me/app "fix the build"
marg --remote buildbox --resume ses_123
marg --local --cwd ~/work/lotus
```

`--cwd` for a remote target is a path **on the remote host**. Relative paths are rejected
rather than resolved against your local machine. On Windows pointing at a Linux server:
`--cwd /home/me/app`. From Linux pointing at a Windows server: `--cwd 'C:\work\app'`.

Without `--cwd`, `--remote` opens the overview and does not guess a remote directory.

All paired profiles are restored at every startup, alongside the local service. If a paired
server is offline or missing its credential, startup does not abort: that host shows up in
the overview and `/servers` as unavailable (its rows keep whatever state was cached) while
local and healthy remote hosts load normally. `--server` / `--remote` select which host is
primary and where the working directory lives — they never narrow the overview. The
discovered local service is registered alongside the explicit host (when one is running and
reachable), and every other paired host is available too, so identical project directory
names always come with their owning host attached.

Profiles and goal/history data survive restarts; secrets live in Windows DPAPI, macOS
Keychain, or the Linux Secret Service. If secure storage is unavailable, margarita refuses
to persist a secret and asks you to re-pair or use the env var instead of writing plaintext.

Paired credentials are not the same as server-side token revocation: `/unpair` removes local
access only, and remote sessions keep running. Margarita never starts or stops remote
services, tunnels, or filesystem sync, and exiting never interrupts a session.

### Config

`%LOCALAPPDATA%\margarita\config.jsonc` on Windows, or your XDG config directory elsewhere:

```jsonc
{
  "agents": { "default": "build", "cycle": ["build", "plan"] },
  "input": { "enterWhileRunning": "queue" },       // or "steer"
  "keys": { "tasks.toggle": "alt+t" },              // single keys only; F1 lists action IDs
  "ui": { "theme": "dark", "animation": true, "ascii": false }  // dark | light | high-contrast
}
```

Environment knobs: `NO_COLOR`, `MARGARITA_NO_ANIMATION=1`, `MARGARITA_ASCII=1`, and `MARGARITA_SERVER_PASSWORD` (for `--server`). The password is only sent over HTTPS or to a loopback host; reach a remote server through TLS or an SSH tunnel (`ssh -L 4096:localhost:4096 host`, then `--server http://localhost:4096`). `MARGARITA_ALLOW_INSECURE_HTTP=1` overrides this for trusted networks. Credentials in the `--server` URL are rejected.

## Development

```sh
bun run verify     # format check + oxlint (type-aware) + typecheck + tests
```

- `MARGARITA_LIVE=1 bun test test/live-smoke.test.tsx` runs a read-only check against your running service.
- `bun run test:writable` runs the writable integration suite against a disposable OpenCode service it starts and deletes itself (private config and data, mock model); it never touches your service or sessions. See [docs/15](docs/15-testing-acceptance.md).
- Code layout: `src/domain` (pure logic) · `src/adapter` (OpenCode client and events) · `src/app` (controller, keys) · `src/ui` (OpenTUI + Solid) · `src/cli` (args, print mode).
- Code style lives in the TypeScript guide used across this project: Bun, strict TS, small modules.

### Design docs

The product spec and decisions live in [`docs/`](docs/) (start with [01-product-contract](docs/01-product-contract.md)),
[`adr/`](adr/) and [`checklists/`](checklists/). The upstream API notes are in
[02-upstream-source-map](docs/02-upstream-source-map.md); check them whenever OpenCode changes versions.

## Status

Early days: version **0.0.1**. It works against OpenCode v2.3.0, and some terminals (Windows Terminal, Ghostty, tmux)
still want a manual look-over; see [checklists/release-candidate.md](checklists/release-candidate.md).
