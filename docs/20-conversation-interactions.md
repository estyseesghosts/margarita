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

Typing `/model` opens UI picker, not a chat message. Typing `/goal` opens goal editor, without model token usage. `/plan propose` may explicitly ask model and then shows proposal. `!git status` is a user-run shell operation (requires validated shell API), not a model execution permission. `@file` completion inserts a typed attachment/reference where server API supports it. Clipboard paste of image inserts chip with stable local ID until prompt admitted.

## Background status and notifications

Overview rows update status while user is reading another session. Notifications should not be toast spam; one line for significant transitions only: `Goldenrod render analysis needs permission` or `Lotus session finished`. Never move focus automatically on background completion. Do not make session activity a full UI pane. `Ctrl+T` opens a checklist, not the overview (separate commands).

## Approval prompt interaction

During an active conversation a server permission request appears above input. Focus moves to it only if current session is active and user is not editing a draft; otherwise display small `needs input` notice and let user decide when to answer. Important: if a destructive action is pending, the choice text must state exact action/scope. After approval, restore composer draft, cursor, selection and pasted attachments.

## Model and agent UI

`Shift+Tab` changes agent and momentarily shows `Agent → plan`, then leaves `plan` in footer. The transcript has a small durable marker if actual subsequent messages use a different agent. `Alt+P` opens model picker as overlay; search immediately focused; picking model closes overlay only after switch acknowledged. F2 cycles recent model tuple. `--effort high` and `/effort high` operate on **model variants** exposed by server and do not themselves toggle reasoning visibility. [OpenCode models](https://opencode.ai/docs/models/), [agents](https://opencode.ai/docs/agents/).

## Detail mode and copying

`Ctrl+O` expands all visible tool activity and reasoning parts where available. To keep it useful at scale, expansion should be lazy in viewport (not materialize a million rows). Focus a tool output with keyboard, copy exact sanitized/plain underlying text, or inspect full content on request. Press `Ctrl+O` again returns compact mode with same transcript anchor. A tool output truncated for display should clearly show truncated bytes and a path to raw server data if retrievable.

## Rewind and recovery

`Esc Esc` or `/rewind` opens a history-focused selection rather than immediately mutating working files. OpenCode v2 has staged reversion and commit operations, but exact changes to code versus conversation require validation. The UI should show scope and affected files before commit, and prevent rewind while a conflicting execution is busy. [OpenCode revert API](https://opencode.ai/docs/api). Until fully supported, leave `/rewind` disabled with honest capability note rather than simulating Claude's checkpoint behavior.

## Small-terminal view

At 40×12, an expanded tool detail can use a full-height scroll overlay temporarily; that's a focused dialog, not a second pane. Project list shows active group, selected row and composer; footer truncates model first, preserves tokens+USD. All actions must remain reachable with keys; no tiny clickable areas required.

## Onboarding without noise

First launch should immediately show overview or positional prompt, with one dim hint at bottom (`← overview · Shift+Tab agent · Ctrl+O details`) optionally shown once. No splash animation, banner, ASCII art, full hotkey list, permanently displayed help or status cards. `?` opens full shortcuts when requested. A missing service or model is an actionable focused error, not a multi-step onboarding wizard.
