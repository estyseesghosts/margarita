# 04 — Agent overview and navigation state machine

## Core contract

**Left from a session's empty composer → project-grouped overview.** This is the defining workflow, documented in Claude Code's agent view: [Claude Code sessions](https://code.claude.com/docs/en/sessions). It is a **view change only**; the OpenCode session remains running. Do not invoke `/session/background`, `/interrupt`, `/compact`, `/session/delete`, or spawn a child. [OpenCode API](https://opencode.ai/docs/api).

## Route state

```ts
type Route =
  | { type: 'overview'; selectedProject?: ProjectKey; selectedSession?: SessionKey }
  | { type: 'conversation'; session: SessionKey }

type Overlay =
  | { type: 'none' }
  | { type: 'modelPicker' | 'agentPicker' | 'help' | 'taskList' | 'permission' | 'diff' | 'transcript'; session?: SessionKey }
```

Route transitions: `START → overview` when no positional prompt/resume; `START → conversation(new)` when positional prompt; `START → conversation(existing)` when `--continue`/`--resume`; `conversation → overview` on guarded Left; `overview → conversation(s)` on Enter; `overview → conversation(new)` when composer submitted; `conversation → overview` on `/sessions` or `/bg` alias if added. Overview remains open as long as user chooses. Event stream continues to update rows.

## Guarded Left-arrow logic

```text
onKey(Left):
  if modal open: modal handles it
  else if suggestion popover open: popover handles it
  else if composer has selection: move caret / shrink selection
  else if composer text non-empty: caret moves left, including at position 0
  else if composer has attachment chips: navigate chips, do not detach
  else if focus is not composer: focused control handles it
  else if IME composition active: do nothing special
  else: route = overview; focus overview composer
```

**Important:** Left at start of a nonempty prompt must **not** switch screens. Avoid the common `if cursorX===0 then overview` bug. Left while a permission dialog is pending belongs to the dialog. If a prompt is empty but a shell-mode marker is active, first Escape resets mode; Left must not erase the user's mode unexpectedly. Provide `/sessions` as an accessible fallback for terminals that swallow Left.

## Overview information architecture

At the top show a restrained title such as `Agents` or `Sessions` only in overview; **not** a header bar in conversation. Group sessions by real project **directory**; project root label (basename) in stronger text and absolute path in dim text where helpful. Project/working-directory selection is explicit; do not assume one project. Within groups sort **latest meaningful session activity descending**, not alphabetical. Optional parent/child sessions: default hide non-user-facing children in collapsed parent, allow expand. Preserve selection and scroll position during event updates.

Each row is at most two visible lines at typical 80×24 terminal width:

```text
kohjoh  C:\repo\kohjoh
  > Renderer stalled near Goldenrod     working · 1m
    Whirl Islands transition           needs approval · 18m

lotus  C:\repo\lotus
    Check GPUI focus                    idle · 39m

New session in: kohjoh
> _
```

No session tab strip; no badges that shout on every row; no animated per-row spinners. A single status icon/word suffices. A pending permission or failed session should be conspicuous by **text/status**, not an entire color-filled row. Separate stable `lastActivity` from transient tokens/events to avoid list jitter every streamed token.

## Grouping algorithm

- Normalize project directory with OS-aware path canonicalization; on Windows drive letters case-insensitive, normalize separators, use `realpath` when available (but avoid requiring a still-existing folder); on Unix preserve case and meaningful symlinks as configured.
- Read `Session.Info.location`, `projectID`, `subpath`; prefer a stable project ID + canonical root path as key. Same basename from separate roots must remain separate groups.
- `session.list` has `directory`, `project`, `subpath`, `archived`, `cursor` and ordering filters; page until user-visible results are complete or explicit load-more control is needed; do not assume first page is all projects. [API](https://opencode.ai/docs/api).
- If a server only returns current-project sessions due to permissions or location scoping, show the limitation rather than silently pretending cross-project discovery is complete.
- Exclude archived by default; `/sessions --all` or an overview toggle reveals archived. Never delete sessions merely because no filesystem folder exists.
- Child-agent sessions: show a parent count/activity indicator, but don't confuse autonomous child agent sessions with the top-level sessions that overview primarily manages.

## Overview composer

Always present below the groups, one line initially; supports multiline and history as in session composer. Its target project is the selected group, initially the CLI cwd or most-recent active project. `Alt+Up/Down` or a project picker can select project without accidentally changing session. The placeholder should communicate `New session in <folder>`. Press Enter creates a **new** session in that folder, selects `build` if discoverable, uses selected/default model, sends prompt, and navigates to it. Prompt without selection must not accidentally resume the highlighted session.

**Distinct actions:** Enter with session row focused **resumes**. Enter with overview composer focused **creates**. Use visible focus indication; avoid mode ambiguity. Typing any printable key (including `n`) while the list has focus moves focus to the composer and inserts that character; paste does the same. Allow an empty new session via `/new` or a dedicated key rather than plain Enter on blank text.

## Backgrounding and notifications

Leaving session A **does not** call backend `session.background`—that API backgrounds blocking tools, a different capability. The frontend keeps lightweight global status subscriptions; session A can become `working`, `waiting for permission`, `idle`, or `failed`. Mark rows `needs input` for approvals/forms, and optionally show a minimal unobtrusive notification in current view. Do not automatically steal focus. Reattach directly at latest relevant position, preserving user scroll anchor when revisiting a session they were reading.

## Multi-client behavior

Multiple TUI processes may attach to the same session. On route change, no exclusive lock is taken. Permission replies are optimistic only until accepted by server; a second client might answer first. Refresh on 404/409. Two attached editors may submit prompts concurrently: use the backend inbox order and stable idempotency where available; don't locally invent a priority. Each frontend's draft is independent (per instance), server's pending inbox is shared.

## Resume and project selection

`--resume <id>` opens exact session; `--continue` chooses latest top-level session for detected project; `--resume` with no ID opens overview with a default list focus. `--cwd PATH` controls initial project for **new sessions**, not relocation of resumed existing session. If resumed session's path differs from current cwd, show source project subtly in overview/help and do not mutate the session location without explicit move request.

## Edge cases and acceptance

Test 80×24 and 40×12, Windows drive-letter collisions, renamed repos, missing folders, archived sessions, 1000+ sessions with pagination, long titles, sessions moved between projects, child sessions, multiple simultaneous sessions, event-driven status changes, and a pending prompt in overview. Test Left with Unicode IME, multiline draft, clipboard attachment, completion open, permission pending, text selected, cursor at start of nonempty string. **Only the truly empty, unblocked composer case navigates.**
