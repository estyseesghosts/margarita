# 05 — Transcript, tool grouping, detailed reasoning

## Layout: minimal by default

No conversation header, permanent sidebar, tabs, right-hand panels, decorative frame, colorful badges, or multiplexer. Transcript occupies available rows above a resizable multiline composer and a single-line footer. A floating permission/form prompt may temporarily overlay conversation content. The design goal is Claude Code-like density and hierarchy, not a pixel-for-pixel copy of proprietary assets. Compare [Claude Code interactive transcript](https://code.claude.com/docs/en/interactive-mode) with [OpenCode v2 TUI source](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/tui/src/app.tsx).

## Rendering model

Render from a **canonical server-message projection**, never build permanent conversation history solely from transient event stream. Model `Session.Message` includes `user`, `assistant`, `system`, `shell`, `compaction`, `idle`, `agent-switched`, `model-switched`, etc. An assistant message includes content parts: `text`, `reasoning`, `tool`; a tool part has an ID, name and progress/status. Use source-backed IDs for keyed rendering. [API schema](https://opencode.ai/docs/api); [OpenCode projector](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/message-updater.ts).

Represent semantic nodes:

```ts
type TranscriptNode =
  | { kind: 'user'; messageID: string; text: string; attachments: Attachment[] }
  | { kind: 'assistantText'; messageID: string; partID: string; text: string; streaming: boolean }
  | { kind: 'activityGroup'; groupID: string; children: ToolOrStep[]; expanded: boolean; state: GroupState }
  | { kind: 'reasoning'; messageID: string; partIndex: number; text?: string; available: boolean }
  | { kind: 'systemNotice' | 'compaction' | 'agentSwitch' | 'modelSwitch' | 'error'; id: string; ... }
```

These are **illustrative frontend types**, not OpenCode wire declarations.

## Grouping policy

### What groups

Default compact consecutive low-salience tools/steps within a single assistant turn or logically contiguous agent step. Examples:

- Three file reads → `Read 3 files` with file count (and optionally shortened paths in the expanded view).
- Four search calls → `Searched 4 times`.
- A series of inspections → `Explored 8 files` if tools are heterogeneous but clearly inspection-only.
- Repeated edits → `Edited 3 files` with count and optionally `+42/-18` if server diff supplies grounded stats.
- Shell execution → `Ran tests` if the command is recognized by transparent deterministic formatting; otherwise `Ran command: bun test`.
- Child agent tool calls → `Research agent · 5 operations` if backend metadata reliably attributes them.

### What never hides

- Any nonzero exit code, tool failure, permission denial, retry exhaustion, rate limit or unsupported operation.
- User's own message, final assistant answer, important question/form, actionable plan approval, interruption or compaction marker.
- Worktree changes, destructive actions, unexplained shell commands, or safety warnings.
- Whole error text truncated beyond recoverability. Show first useful lines and expansion affordance.

### Group boundaries

Never aggregate across separate user submissions, idle markers, session switches, compaction boundaries, agent/model changes or errors. If an assistant speaks explanatory text between tools, group within spans separated by text where appropriate; avoid reordering. Group by **stable message/part indices** and tool category, not mere time window. Active group summary updates as tools complete; prevent count flicker by appending and sorting deterministically by canonical message/part order.

### Summary algorithm sketch

1. Build ordered, immutable semantic parts from server projection.
2. Classify each tool (`read`, `search`, `edit`, `shell`, `browser`, `delegate`, `other`) using a table of known names; unknown tools stay `other` with sanitized name.
3. Segment by user-turn/assistant-message and by explicit critical events.
4. Fold contiguous safe tool parts into groups when count >= 2 or output is long; single short call may remain one concise status line.
5. Derive summary from data—not model-generated restatement—and compute `success/warn/fail/running` aggregate state.
6. Give all groups stable `groupID` from first/last child IDs and grouping version. Fold state keyed by canonical child IDs; avoid rewriting every key when a group grows.
7. Show detailed group children on click/Enter/Space/`Ctrl+O`. Group and individual tools are separate disclosures: opening a group lists concise tool rows, and clicking or keyboard-activating one row expands only that tool. Per-tool choices are qualified by host/session, persist when the group is collapsed and reopened, and never turn on global detailed mode (#281).

A code review should verify the algorithm does not suppress a failed call merely because it belongs to an otherwise successful batch. Reference upstream tool lifecycles in [message-updater.ts](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/message-updater.ts): `session.tool.input.started`, `tool.called`, `tool.success`, `tool.failed` project into tool parts.

## Detailed transcript (`Ctrl+O`)

A **mode toggle**, not a separate window manager or a tab. The same conversation remains visible, but expands activity groups and reveals: timestamp (where supplied), model/agent at each step, full command/tool name and arguments (respecting redaction), streamed/final tool output, retries, compaction summaries, lifecycle events and **reasoning text if the provider sent any**. Reference [Claude's Ctrl+O transcript](https://code.claude.com/docs/en/interactive-mode) and [OpenCode reasoning schema](https://opencode.ai/docs/api).

- `Ctrl+O` toggle remembers scroll anchor; while switching, keep the same user/assistant target line in view.
- Per-group `Enter` expands just that group without changing global mode.
- In detailed mode, add `Copy tool output` and `Copy message` contextual actions, but don't display a control bar by default.
- Do not dump unbounded 50MB stdout into in-memory layout. Show a capped preview with offset-based lazy slices where supported, and explicit truncation notice.
- Code Mode nested calls have their own aggregate **physical-row** paint budget, independent of per-child previews and character caps. Compact and detailed modes render a bounded window sized by rows, not by a fixed child count: each child's label plus its allocated error/output rows must fit the page budget, and failures are prioritized. The window shows a `showing N of M` summary. A focused execute call pages the remaining children with `[` / `]`; every child identity is reachable exactly once, later pages keep source order, and a separate `page N of M` line prevents the status summary from truncating the page state. Full child metadata stays in the transcript model; the cap is rendering-only (#260, #268).
- Timestamps must come from actual server messages/events. If not available show none, not fabricated.

## Reasoning availability and privacy

OpenCode v2 models can return `reasoning` content parts and events. Some models return no text, even with nonzero reasoning tokens. UI rules:

| Server data | Default transcript | Detailed transcript |
| --- | --- | --- |
| Reasoning text available | Optional tiny `Reasoned…` collapsed indicator | Render returned text, identified as model-provided reasoning |
| Reasoning events only, still streaming | Small `Thinking…` state, not giant text | Stream actual deltas only if present |
| Reasoning tokens > 0 but no text | No fabricated reasoning | `Reasoning text not available (N tokens reported)` |
| Reasoning redacted by provider | None | `Provider did not expose reasoning text` |
| Reasoning text absent, tokens unknown | None | No reasoning panel |

Never call this a complete hidden internal thought trace; don't infer omitted thinking from context or trace logs. Avoid persisting reasoning to a separate cache unless already part of server canonical history; respect provider policy. [Source](https://opencode.ai/docs/api).

## Scrolling and performance

Virtualize transcripts by message and expandable group. Target 10,000+ message/tool parts without long input delays. While scrolled to bottom, stream new text smoothly at 30–60 Hz batched redraws; while scrolled up, freeze anchor and show subtle `↓ N new` hint. Never auto-jump because a background event arrives. On resize, reflow keeping logical anchor `{messageID, offset}`; don't anchor to raw row number. The compositor must not rerender every past line per token. Run a worst-case test with one streaming 1MB tool output and a concurrently editable composer.

Folded nodes are derived incrementally (#283): each canonical message is folded once and cached by object identity, and a projection reuses its previous final node list up to the last execution marker in the unchanged prefix. Those markers close segments, so interruption consolidation and tool grouping can never cross them; a tail update therefore re-folds and regroups only its own turn instead of the entire loaded history. Unaffected nodes keep object identity, so their mounted rows retain their Markdown, diff and preview formatting (#286). Non-tail replacement, deletion, reorder, older-page prepend and marker phase changes all fall back to the same reference `foldTranscript` semantics; the projector tests assert equality against that reference across seeded update sequences.

`PageUp` at the top prepends older history without moving the message already at the viewport top: the next frame restores the same semantic node at the same row, and the anchor stays alive while the history request is in flight rather than expiring on a timer (#243). `Ctrl+Home` reveals every already-loaded node and scrolls to the earliest of them; when server history remains, the existing `earlier messages · PageUp` marker stays visible so the shortcut never implies the start of an unbounded history was fetched (#251). Keyboard group focus (`Ctrl+Up/Down`) expands the render window to include a loaded target and scrolls that row into view before Enter can act on it (#242). A focused row is only auto-scrolled when focus changes; streaming updates never steal the reader's position. The sticky prompt is derived from the full folded conversation when the owning user node has left the render window, so a long tool run inside one turn does not blank the header (#244). Pending questions are pinned above the composer like permissions, so a question remains discoverable while the reader is far up the transcript; `Alt+Q` opens it without touching a nonempty draft (#213).

## Markdown and terminal text

Support fenced code, inline code, links, lists, headings, diffs, tables with narrow-width fallback, line wrapping, wide Unicode, combining marks, bi-di control escaping. Color is semantic: dim for secondary, error for failed, muted spinner for active. User-supplied tool output is untrusted; strip/escape ANSI control sequences that would alter terminal state, send OS commands, fake prompts, or inject navigation.

## Accessibility and reduced motion

High-contrast palette, no reliance on colors alone, recognizable status words, no spinner-only progress, screen-reader/flat transcript export option, focus visible, mouse optional, keyboard complete. Preference `reducedMotion: true` default true; no blinking logo or activity confetti. Support `NO_COLOR` and terminal color detection. Document keyboard-only transcript traversal.

## Validation examples

- `read a.ts`, `read b.ts`, `grep foo` → one `Explored 3 files` or two deterministic adjacent safe groups, never 3 bodies by default.
- `read a.ts`, failed `bash bun test`, `read b.ts` → group before; **failure displayed in full**; group after.
- reasoning text supplied → hidden by default; Ctrl+O reveals it exactly.
- reasoning tokens recorded, no part → detailed transcript says unavailable.
- 500 queued tool events in background session → overview stays responsive, transcript correct when reattached.
