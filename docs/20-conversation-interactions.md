# 20 — Fine interaction details: what users perceive

## Content hierarchy

The conversation should not look like a log viewer. User messages create visible conversational anchors; assistant answers use readable paragraphs and fenced code; routine operations appear as compact, grammatically plain lines. Tool status is secondary except when running or failing. No constant footer animation, verbose timestamp on each operation, or persistent session title header. This follows the *design paradigm* rather than a literal reproduction of Claude Code source. [Claude interactive reference](https://code.claude.com/docs/en/interactive-mode).

## Composer rules

At rest, one-line `> ` or another understated input marker. Multiline grows upward to a cap (e.g., 1/3 terminal height) and scrolls internally after. Submitting empties draft after server acknowledgement; existing message appears immediately but dim until confirmed. While streaming, composer stays active and keyboard responsive. Enter queues follow-up; the user can type more prompts. A submitted queued prompt appears as a compact pending item with cancel/restore action, not as a tool transcript row.

### Enter while working

- Compose a follow-up; press Enter.
- UI calls backend durable prompt admission with `delivery: queue` using the verified generated SDK type.
- Pending item appears with short text and `[queued]` status.
- It becomes delivered when server inbox/message events confirm; new answer appears in conversation without user action.
- To steer immediately, user invokes `/steer` or supported one-key shortcut. The UI must clearly distinguish steering from queueing.
- If backend rejects admission because model busy, preserve draft and show reason; don't clear or pretend queued.

Claude Code itself can deliver queued messages at tool boundaries; our guaranteed behavior is **OpenCode server semantics**, not a 1:1 imitation if its scheduling differs. [Claude queue behavior](https://code.claude.com/docs/en/interactive-mode), [OpenCode inbox](https://opencode.ai/docs/api).

## Commands vs message text

Typing `/model` opens UI picker, not a chat message. Typing `/goal` opens goal editor, without model token usage. `/plan propose` may explicitly ask model and then shows proposal. `!git status` is a user-run shell operation (requires validated shell API), not a model execution permission. `@file` completion inserts a typed attachment/reference where server API supports it. A one-based range suffix `@src/app.ts#20-45` is Margarita shorthand (not OpenCode syntax) and becomes a `file:` URI with `?start=20&end=45`; invalid ranges are reported and never sent. Bare `@name` references that match the current server's agent catalog are sent as agent attachments, while path-like mentions stay files. Clipboard paste of image inserts chip with stable local ID until prompt admitted.

## Background status and notifications

Overview rows update status while user is reading another session. Notifications should not be toast spam; one line for significant transitions only: `Goldenrod render analysis needs permission` or `Lotus session finished`. Never move focus automatically on background completion. Do not make session activity a full UI pane. `Ctrl+T` opens a checklist, not the overview (separate commands).

## Approval prompt interaction

During an active conversation a server permission request appears above input. Focus moves to it only if current session is active and user is not editing a draft; otherwise display small `needs input` notice and let user decide when to answer. Important: if a destructive action is pending, the choice text must state exact action/scope. After approval, restore composer draft, cursor, selection and pasted attachments.

## Model and agent UI

`Shift+Tab` changes agent and momentarily shows `Agent → plan`, then leaves `plan` in footer. The transcript has a small durable marker if actual subsequent messages use a different agent. `Alt+P` opens model picker as overlay; search immediately focused; picking model closes overlay only after switch acknowledged. F2 cycles recent model tuple. `--effort high` and `/effort high` operate on **model variants** exposed by server and do not themselves toggle reasoning visibility. [OpenCode models](https://opencode.ai/docs/models/), [agents](https://opencode.ai/docs/agents/).

## Detail mode and copying

`Ctrl+O` expands all visible tool activity and reasoning parts where available. To keep it useful at scale, expansion should be lazy in viewport (not materialize a million rows). Press `Ctrl+O` again returns compact mode with same transcript anchor.

Scrolling never follows streaming on its own. A focused tool/group is revealed when focus moves to it or when that same row's own disclosure or child page changes; an unrelated streamed tail update, marker change or render-window refresh must leave the reader's viewport where they put it (#296). `Ctrl+Up/Down` and an explicit expand still make the focused row discoverable once.

`Alt+C` or `/copy` opens the copy picker: a searchable list of exact payloads in the loaded session — tool output, diffs, errors, shell output, fenced Markdown code blocks and complete assistant responses. Type to filter, Up/Down to move, Enter or click to copy. The copied bytes are the underlying sanitized source text (newlines and code preserved), never styled/wrapped terminal rows or UI prefixes. Rows are labelled when a payload hit the frontend UI cap or was truncated by the server, so a shortened payload is never presented as complete. The full server-side text, when only a cursor RPC retained it, is not silently fetched — the label says where the boundary is.

`Alt+Shift+C` or `/copy last` copies the last **complete** response from canonical messages. A response is the assistant's public text across one execution — potentially several assistant messages, tool calls and steering prompts — with reasoning, tool payloads and execution markers excluded and Markdown, fences, indentation and paragraph breaks preserved. Only a segment that began at a loaded prompt (or user shell command) and ended with the server's succeeded `idle` counts as complete; the display markers' fallback completion rules are not treated as proof. While a run is still streaming, or after a failed/interrupted run, the previous complete response is copied and the notice says so. If no complete response is fully loaded, the notice says that instead of copying a partial turn.

There are two independent copy mechanisms sharing one clipboard service. **Visual selection** copies what the user drags over and is extracted from the renderer's own text selection; **semantic response copying** reads canonical content independently of rendering, wrapping, scrolling or collapsed sections. Drag selection works across assistant messages, prompts, code blocks, expanded tool output, diffs and the inspector. Releasing a drag copies once when `clipboard.autoCopy` is on (the default); `Ctrl+Shift+C` always copies explicitly, and right-click copies an active selection or pastes when there is none. The selection is cleared when the route or dialog changes so stale rows can never be copied later.

Copying prefers the native desktop clipboard on Windows, macOS, Wayland and X11, falls back to the terminal's OSC 52 channel (reported as *unconfirmed*, because terminals do not acknowledge it), and only an explicit copy may fall back to a timestamped owner-only local file. A missing system clipboard or a terminal without OSC 52 produces a truthful failure notice rather than a phantom success, and an automatic selection copy never writes private text to disk. Windows' native text clipboard stores CRLF; a native paste normalizes it back to LF before insertion.

## Rewind and recovery

`Esc Esc` or `/rewind` opens a history-focused selection rather than immediately mutating working files. It lists earlier user prompts from the loaded transcript (page up to load older history), with timestamps and a short prompt preview. Moving the selection reads a read-only `session.diff` preview of the files in scope; stale replies are discarded, and a failed preview is labelled rather than fabricated. Enter stages the chosen boundary with `session.revert.stage`, then opens the existing confirmation dialog: Enter commits, Esc restores the files. Rewind is refused while the session is running, and both the selector and the confirmation are bound to the owning server/session so switching hosts mid-dialog cannot cross-revert. OpenCode v2's revert changes **files only** — the conversation is not rewritten, and the server exposes no redo operation; the dialog says so explicitly instead of promising Claude-style checkpoints. Rewind boundaries older than the loaded transcript window require paging up first. [OpenCode revert API](https://opencode.ai/docs/api).

## Small-terminal view

At 40×12, an expanded tool detail can use a full-height scroll overlay temporarily; that's a focused dialog, not a second pane. Project list shows active group, selected row and composer; footer truncates model first, preserves tokens+USD. All actions must remain reachable with keys; no tiny clickable areas required.

## Onboarding without noise

First launch should immediately show overview or positional prompt, with one dim hint at bottom (`← overview · Shift+Tab agent · Ctrl+O details`) optionally shown once. No splash animation, banner, ASCII art, full hotkey list, permanently displayed help or status cards. `?` opens full shortcuts when requested. A missing service or model is an actionable focused error, not a multi-step onboarding wizard.
