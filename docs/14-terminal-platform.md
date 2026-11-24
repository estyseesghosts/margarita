# 14 — Terminal engineering, platform support and accessibility

## Terminals to target

Windows 11 PowerShell inside **Windows Terminal**, Ghostty on macOS/Linux, WezTerm across platforms, tmux on Unix, and conservative fallback on SSH/plain VT. Do not assume all receive `Ctrl+Enter`, `Shift+Enter`, `Alt+P`, meta keys, focus events, Kitty keyboard protocol, terminal images, OSC clipboard or true-color. Detect capabilities or offer `/keys` diagnostics and predictable fallbacks.

OpenCode itself uses `@opentui/core` and `@opentui/solid` in [its current TUI](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/tui/src/app.tsx); reuse those primitives but **not** the full-screen tab/layout paradigm. OpenCode's prompt source includes paste and editor handling patterns: [prompt index](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/tui/src/component/prompt/index.tsx).

## Keyboard normalization

Input decoder converts byte sequences into semantic key events. Handle legacy VT, CSI-u, Kitty extended protocol when offered, Windows translation, AltGr, Option-as-Meta, Ctrl+Shift combinations. A failure in capability negotiation must not swallow typed characters. `Ctrl+Enter` steering is **optional** because ordinary VT cannot always distinguish it; provide `/steer` and configurable alternate.

### Left-arrow invariant

Only empty **session** composer triggers overview. Alt+Left is word navigation if defined; Ctrl+Left might be word navigation, not overview. In overview list, Left collapses group where appropriate, and Right enters selected session. This contextual binding is not one global `Left` handler. Modal focus always takes precedence.

### Paste races

Use bracketed paste. Buffer an entire paste as one ordered text transaction; preserve the FIFO of key events typed during paste processing. Large paste summarizes visually after insertion but sends unabridged text. Limit max draft bytes via explicit setting; don't silently truncate. Test Unicode replacement, tabs, CRLF, emoji and combining graphemes.

### Clipboard images/files

One client-local clipboard service owns every copy and paste path (`src/app/clipboard.ts`). It prefers the native desktop clipboard through OpenTUI's bundled backend — Windows, macOS, Wayland and X11 are handled by the native library, with no shell command per operation — and keeps the terminal's OSC 52 channel as the fallback where the terminal owns the clipboard (SSH/mosh, tmux, conservative VT sessions). Reads exist only through the native backend; there is no portable terminal clipboard read, and the UI says so when a read cannot be served.

- Never split an oversized payload across several OSC 52 writes: receivers replace rather than append, so the result would be the last fragment. The native path has an 8 MB ceiling and no 4 KB limit; an OSC 52 attempt is one write and is reported as *unconfirmed* because terminals do not acknowledge it.
- A missing native backend and a terminal without OSC 52 produce an unavailable outcome with a reason. Only an explicit copy may fall back to an owner-only local file whose path is shown; an automatic selection copy never writes private text to disk.
- Windows' native text clipboard stores CRLF. A native paste normalizes `\r\n` back to `\n` before insertion; copying to the system clipboard keeps the platform's convention.
- SSH/mosh sessions never touch the remote machine's desktop clipboard: the terminal's OSC 52 is the only truthful route.
- Wayland clipboard ownership and helper-process lifetimes belong to the native backend; Margarita never spawns a clipboard helper per mouse movement or per frame.
- The service serializes writes, so two overlapping copies complete in arrival order and the newest request wins.
- Clipboard images and PDFs arrive with their MIME type; binary data is never decoded into the prompt, and unsupported binaries are refused. If clipboard images are unsupported, the explicit file-path attach workflow remains. Do not build an unsafe arbitrary shell clipboard command from user text.

## Renderer design

Choose OpenTUI+Solid once it passes a spikes suite: fast transcript scrolling, hidden header by default, flicker-free compact footer, correct terminal restoration on crash, alt-screen handling, and input processing under load. Native scrollback mode is **later**, not MVP. Fullscreen implementation must still *feel* conversation-first and must not try to manage terminal panes.

Small test grid:

| Width×height | Required behavior |
| --- | --- |
| 160×50 | Full footer, long conversation, no redundant panels |
| 100×30 | Comfortable default transcript |
| 80×24 | Critical usability bar; project list and composer visible |
| 60×18 | Footer compresses; modals can scroll |
| 40×12 | Minimal mode, scrollable list and one-line composer |

Avoid expensive layout recompute for every token or spinner frame. Coalesce rendering at sane frame rate, virtualize transcript and list, cap long line width, and use background worker only if Bun/OpenTUI architecture actually supports it safely. A 10,000-message transcript should not cause keystroke lag.

## Terminal restoration

Wrap initialization and teardown. Restore cursor visibility, mouse mode, bracketed paste and alternate screen on normal exit, panic and interruption. Never terminate the OpenCode service on frontend exit. On Unix Ctrl+Z optional; on Windows disable suspend gracefully. A crash must not leave unusable terminal; provide `reset` tip after fatal render error.

## Text rendering

Use grapheme width and Unicode-aware wrapping, not JS `.length`. Sanitize control codes and bi-di formatting from untrusted model/tool output. Render Markdown tables with stacked fallback on narrow widths; code blocks horizontal scrolling only on user request; preserve exact bytes for copy action. Link opening must require explicit interaction. No hover-only controls.

## Accessibility

`NO_COLOR` honors plain rendering, reduced-motion default, color contrast tests, keyboard complete navigation, screen reader flat export option (`--plain` later), and textual status words. Do not use only green/red to distinguish success/failure. Every modal has clear focus, Esc/Cancel option and action descriptions in help. Make status notices polite and nonintrusive; never emit a beep for every tool call.

## Performance budgets (project targets, not measurements)

- Keystroke-to-render median under 25ms, p95 under 60ms on the reference Windows machine under active event stream.
- Overview navigation should not wait for network round trips.
- 10k items with transcript virtualization, memory stable under large tool logs.
- Detached sessions stream into compact summaries, not complete rendered off-screen trees.
- Startup time should be measured with an already-running service separately from service-start cost.

## Test environment

Capture terminal type, OS, Bun version and feature flags in opt-in diagnostic report. Run automation under PTY/ConPTY test harness and manually on real Windows Terminal, Ghostty and tmux. Snapshot testing alone is insufficient: must confirm actual key escape sequences and resize behavior on hardware.
