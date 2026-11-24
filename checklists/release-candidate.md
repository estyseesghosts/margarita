# Release-candidate checklist

Run on the exact build being released (`bun run build`, then the binary from `dist/`). Live steps use a running OpenCode v2.3 service and a free model (for example `opencode/longcat-2.5-free`). Never start, stop or reconfigure the service under test.

## Automated gate

- [ ] `bun run verify` is green (format, type-aware lint, typecheck, unit and frame tests).
- [ ] `MARGARITA_LIVE=1 bun test test/live-smoke.test.tsx` passes (read-only).
- [ ] `bun run test:writable` passes (disposable service, mock model).
- [ ] `test/perf.test.tsx` within budget: fold of 10k messages < 250 ms, 5 MB stdout sanitize < 1.5 s, reconnect merge < 100 ms, steady frame on a 10k-message session < 200 ms.

## Smoke (manual, Windows Terminal and Ghostty; tmux on Linux)

- [ ] `marg` opens a new session in the current directory; nothing is created on the server until the first prompt.
- [ ] `marg "prompt"` sends once; `--continue`, `--resume`, `--resume <id>` open the right session; `-p` prints and exits.
- [ ] Left on an empty prompt opens the overview; first row selected; typing fills the prompt; `[Show more]`/`[Show less]` work.
- [ ] Session A running → Left → start B → return to A: A kept running and shows the live state.
- [ ] Shift+Tab cycles agents; Alt+P model picker; F2 recent model.
- [ ] Tool groups collapsed by default; failures visible; Ctrl+O shows exact output and timing.
- [ ] PageUp at the top loads older pages without jumping.
- [ ] Permission card: answer once; answering in a second client clears it here with "Already answered elsewhere."
- [ ] Agent question form: choice, text, required validation, Ctrl+X decline.
- [ ] `/diff` and `/diff turn` list files and show colored patches.
- [ ] Ctrl+B during a long tool call moves it to the background and the turn continues.
- [ ] `/goal`, `/plan a; b`, Ctrl+T: Space cycles state, `e` links evidence; state survives restart.
- [ ] `/plan propose` → `/plan adopt` → reject leaves the plan unchanged; accept replaces it.
- [ ] `/sync on` against a server without instruction entries shows "Not synced to agent" and keeps the local plan.
- [ ] `/rename`, `/fork` (plan copied, not shared), `/revert` (Esc restores, Enter commits).
- [ ] `/export` writes `marg-<session>.json` with every message, not only the visible window.
- [ ] `ui.theme` `light` and `high-contrast` are readable; `NO_COLOR=1` gives plain output; `ui.ascii` and `ui.animation: false` work.
- [ ] Drag over an assistant reply: selection is visible and copies once on release; `Ctrl+Shift+C` copies a selection with autocopy off; `Alt+Shift+C` copies the last complete reply.
- [ ] `Ctrl+V` pastes multiline text without submitting; right-click copies a selection and pastes when there is none.
- [ ] `/copy` lists responses alongside tool output; `/copy last` works without the shortcut.
- [ ] Copy a large reply and a Unicode code block on Windows Terminal first, then a Wayland/X11 terminal, macOS and an SSH/tmux session; the notice distinguishes native, unconfirmed OSC 52 and unavailable, and the paste round-trips without corrupted characters.
- [ ] Ctrl+C interrupts, then clears, then asks before exit; the terminal is restored after exit and after a crash.

## Performance review

- [ ] Transcript renders only the window (`transcriptWindowStep`) with viewport culling; older history is paged, not loaded at attach.
- [ ] No per-keystroke work proportional to transcript length (fold is memoized on transcript changes).
- [ ] Event bursts are batched; reconcile timers are cleared on dispose.

## Security review

- [ ] All server and tool text passes `sanitizeTerminalText` before rendering (no raw escape sequences, OSC, or bells reach the terminal).
- [ ] Margarita writes only to its own app-data directories (config, state, `goals/`) and to an explicit `/export` target; nothing inside the user's repository unless asked.
- [ ] Sidecar and state files are written atomically with mode 0600; goal saves use compare-and-swap with a lock file.
- [ ] No credentials are persisted or exported: `/export` contains server URL, session metadata and messages only; `MARGARITA_SERVER_PASSWORD` is read from the environment and never logged.
- [ ] The compiled binary ignores `bunfig.toml` and `.env` in the working directory.
- [ ] Unknown form field types and newer goal-plan schemas fail closed (rejected, not guessed).
- [ ] Instruction sync is opt-in per session and removable (`/sync off` deletes the entry).
