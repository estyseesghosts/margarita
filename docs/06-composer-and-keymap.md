# 06 — Composer and keybinding contract

## Principle

One logical action, one key or one modifier+key. No Emacs-style `Ctrl+X` followed by a second letter. A slash command is a typed command, not a keyboard chord. The default interaction language is **Claude-like editing**, with project-specific exceptions: **`Shift+Tab` cycles OpenCode agents** and **Left on empty input detaches to overview**. Sources: [Claude keyboard shortcuts](https://code.claude.com/docs/en/interactive-mode), [OpenCode v2 keybinds](https://opencode.ai/docs/cli/keybinds), [OpenCode prompt source](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/tui/src/component/prompt/index.tsx).

## Confirmed key conflicts

| Key | Claude Code baseline | OpenCode v2 default | Our binding | Reason |
| --- | --- | --- | --- | --- |
| `Shift+Tab` | permission-mode cycle | agent cycle | **agent cycle** | Explicit product decision |
| `Ctrl+O` | detailed transcript | open recent sessions/projects | **transcript toggle** | Keep Claude's control; overview gets Left |
| `Ctrl+G` | external editor | go to first message | **external editor** | Efficient long prompts |
| `Ctrl+R` | search history | rename session | **history search** | Prompt editing convention |
| `Ctrl+P` | previous history | command palette | **history** | Readline compatibility |
| `Ctrl+T` | task checklist | model variant cycle | **goals/tasks** | User's explicit plan workflow |
| `Ctrl+L` | redraw | terminal-specific/none | **redraw** | Recovery |
| `Ctrl+D` | confirm exit or delete char | delete/exit context-dependent | **Claude-like safe exit** | Avoid accidental exit |
| `Ctrl+C` | interrupt/clear/exit | clear/exit; Esc interrupts | **interrupt/clear/exit** | Expected muscle memory |
| `Ctrl+V` | image paste in supported terminals | clipboard paste | **clipboard context** | Terminal fallback required |
| `Esc Esc` | rewind/clear draft | no direct matching default | **rewind when idle** | Safety; optional confirmation |
| `Alt+P` | model picker | generally unbound | **model picker** | Single shortcut |
| `F2` | generally no core binding | recent model cycle | **cycle recent models** | Useful OpenCode benefit |
| `Ctrl+Tab` | not required for agent view | next tab | **unbound by default** | No tab UI |
| `Left` | session → agent view on empty prompt | cursor motion | **overview, guarded** | Required workflow |

The mapping is deliberately not an exact Claude clone. `Shift+Tab` must never flip security policy. Do not add `Ctrl+X A`, `Ctrl+X P` or any multi-step leader map.

## Default keys, exhaustive MVP actions

| Context | Key | Action |
| --- | --- | --- |
| Composer, empty | `Left` | Open overview |
| Composer | `Shift+Tab` | Next selectable OpenCode agent (`build` initially) |
| Composer | `Alt+P` | Model picker |
| Composer | `F2` | Next recent model |
| Composer | `Ctrl+O` | Toggle detailed transcript |
| Composer | `Ctrl+R` | Reverse search prompt history |
| Composer | `Ctrl+S` | Stash/restore composer draft |
| Composer | `Ctrl+G` | Open draft in `$VISUAL` / `$EDITOR`. The result is bound to the draft and server/session lifetime that opened it; a switch, newer draft or deleted session parks it in that original draft or a client-local recovery file instead of writing into another conversation |
| Composer | `Ctrl+T` | Open goal/task checklist |
| Composer | `Ctrl+L` | Redraw display |
| Conversation | `Alt+R` | Retry a partial permission/question refresh; cached requests stay visible |
| Composer | `Enter` | Submit prompt; if session running, **queue** (project choice) |
| Composer | `Ctrl+Enter` | Explicit **steer now** if terminal supports; fallback `/steer` command |
| Composer | `Shift+Enter` | Newline where distinguishable; else `Ctrl+J` |
| Composer | `Ctrl+J` | Insert newline, universal fallback |
| Composer | `Up` / `Down` | Move within multiline; boundary navigates history |
| Composer | `Ctrl+P` / `Ctrl+N` | Previous/next history unless completion owns keys |
| Composer | `Ctrl+C` | Interrupt executing session; else clear draft; then confirm exit |
| Composer | `Ctrl+D` | Delete char if nonempty; otherwise guarded exit |
| Composer | `Esc` | Close suggestion, dialog, shell mode, or cancel selection; while a run is active and no higher-priority control owns Esc, interrupts the session once, preserving the draft |
| Composer | `Esc Esc` | Enter rewind selection only when composer empty and session idle; else clear prompt with safe restore |
| Composer | `/` at start | Slash command completion |
| Composer | `@` | File/agent reference completion |
| Composer | `!` at start | User shell mode |
| Overview list | `Up`/`Down` | Move among rows |
| Overview list | `PageUp`/`PageDown` | Move the selection by about one viewport; no-op in the composer so the draft is untouched |
| Overview list | `Ctrl+Home`/`Ctrl+End` | Select the first/last available row |
| Overview list | `Enter`/`Right` | Attach selected session |
| Overview list | any printable key | Focus and fill the new-session composer (including `n`) |
| Overview list | `/` | Search list (not session prompt) |
| Overview list | `Esc` | Clear filter or focus overview composer |
| Overview composer | `Enter` | Create new session + send initial prompt |
| Transcript | `PageUp`/`PageDown` | Scroll; at the top, reveal or fetch earlier history without moving the current top message |
| Transcript | `Ctrl+Home`/`Ctrl+End` | Earliest **loaded** message / latest message; the `earlier messages` marker stays when server history remains |
| Transcript | `Ctrl+Up`/`Ctrl+Down` | Focus the previous/next tool group or row, revealing it and scrolling it into view |
| Transcript, focused group/tool | `Enter` / `Space` | Toggle that group or individual tool disclosure; an expanded group exposes each tool row as its own target, and the empty composer keeps the key from submitting |
| Transcript, focused execute | `[` / `]` | Page the nested Code Mode child window; with a nonempty draft the brackets remain ordinary text |
| Pending question | `Alt+Q` | Open the question without clearing a nonempty draft; `Enter` on an empty prompt also opens it |
| Form dialog | `Enter` / `Shift+Tab` | Validate and advance / go back; `Esc` leaves the question pending, `Ctrl+X` declines |
| Form text/custom choice | `Left`/`Right`, `Home`/`End`, `Backspace`/`Delete` | Grapheme-safe caret editing. A custom choice starts with the option list focused: `Up`/`Down`, `PageUp`/`PageDown`, `Home`/`End` navigate it; typing or `Ctrl+E` focuses custom text, and `Up`/`Down` (or `Ctrl+E`) returns to the list. Caret movement never changes which source Enter submits |
| Form multiselect | `Space`, `a`, `x` | Toggle listed value, add custom value, remove selected custom value |
| Help | `PageUp`/`PageDown` | Scroll the bounded key list; a printable key dismisses help |
| Queue/tasks | `PageUp`/`PageDown`, `Home`/`End` | Move the selection through a bounded list; selected row stays visible |
| Searchable overlay | paste | Text is inserted into the active query; binary paste is refused and never leaks to the composer |
| Overview list | mouse click | Click a tab, session row or Show more/less toggle; keyboard remains complete |
| Model/effort picker | mouse click | Activate that row through the same verified switch path as Enter |
| Model/agent/effort/copy/rewind picker | `Up`/`Down`, `PageUp`/`PageDown`, `Home`/`End` | A bounded window sized to the current terminal height; the highlighted row stays visible and an `n of N` line reports position |
| Dialog | `Tab` / `Shift+Tab` | Move focus within dialog, **not** cycle agents |
| Permission dialog | `Left` / `Right` | Navigate choices; never overview |
| Global | `?` | Keybinding help when not editing |

`Ctrl+Enter` is the default steer binding, but it may be indistinguishable from Enter in terminals without extended keyboard protocols: **never claim it worked** for a terminal you have not tested. Keep `Alt+Enter` or `/steer` as a tested one-keystroke alternative for terminals that misdecode it. Primary Enter always queues while busy. Backend delivery modes are `queue` and `steer`; test semantics with the real server rather than client-side buffering. [OpenCode API](https://opencode.ai/docs/api).

## Input state machine

Define handling precedence: `modal > IME > paste transaction > autocomplete > selection > composer movement/editing > global navigation`. Create a central action registry with `actionID`, `defaultBinding`, `allowedContexts`, `canRun(state)`, `handler`. Never map directly from raw escape sequences inside view components.

`KeyEvent` normalized fields: key identity, Unicode text, ctrl/alt/shift/meta, repeat, source protocol (legacy/kitty/CSI-u/Windows API), composing, timestamp. A key that decodes ambiguously should be treated as text/Enter fallback rather than triggering a destructive action. Offer a diagnostic `/keys` view that shows the last interpreted key without leaking typed prompt text.

## Draft and prompt editing

- Undo/redo for editing, `Home/End`, `Ctrl+A/E`, word navigation `Alt+B/F`, deletion `Ctrl+W/U/K`, and yank/restore `Ctrl+Y` where terminals permit; these are *editing* conventions, not application chords. Undo is `Ctrl+Z` with `Alt+Z` as the fallback for terminals that swallow Ctrl+Z; redo is `Ctrl+Shift+Z`. Undo history is bounded and scoped to each draft route; consecutive typing collapses into one step, pastes and editor replacements are atomic, and sending a prompt clears that route's history.
- Insert Unicode grapheme clusters atomically; never split surrogate pairs or combining sequences on Backspace.
- The caret is an **in-cell style on the grapheme at the insertion boundary**, never an inserted character and never the terminal hardware cursor (OpenTUI owns that cursor and moves it every frame, which leaked stray bars into transcript and welcome rows in #130). `caretPaint()` splits the text into `before`/`marked`/`after` grapheme pieces that always concatenate back to the original string, so blink-on and blink-off phases have identical display width, soft wrapping and double-width/emoji placement (#137). At end-of-text the last grapheme carries the style; an empty composer shows no marker (only the dim placeholder). Focus/overlay state and the ~530 ms blink cadence are unchanged.
- `Ctrl+W` removes the preceding whitespace-delimited unit and any whitespace immediately before the cursor, including line breaks. `Ctrl+Backspace` and `Alt+Backspace` skip preceding non-word graphemes then remove a run of letters, numbers, and underscores. Word movement uses the same grapheme-safe word boundaries.
- `Alt+D` (`composer.wordDeleteForward`) removes one word forward at the cursor. Each kill (`Ctrl+W`, `Ctrl+U`, `Ctrl+K`, `Ctrl+Backspace`, `Alt+Backspace`, `Alt+D`) replaces the kill buffer; `Ctrl+Y` (`composer.yank`) inserts the last killed text at the cursor. The buffer is bounded to the last kill and never sent to the server.
- Multiline expands upward; footer stays fixed. Long paste becomes one undo transaction and one preserved attachment/text block; bracketed paste must maintain insertion order with subsequent keystrokes.
- Prompt history stored per project; separate `!` shell history; nonempty drafts aren't overwritten on Up unexpectedly.
- Pasting an image yields a chip; if clipboard access unsupported on WSL/SSH, use explicit `@/absolute/path` or attach-file command rather than pretending it pasted.
- Slash commands must be distinguishable: frontend local (`/goal`, `/tasks`, `/sessions`, `/help`, `/model`, `/agent`, `/diff`) vs server-provided user commands (`session.command`); never send a local slash verb as an ordinary model prompt accidentally.
- `!` commands: show cwd and completed output, but don't silently treat shell output as the next agent prompt. Validate session shell API behavior before promising Claude's automatic agent response on `!` command completion.

## Discoverability and overrides

Help lists current keys in a compact overlay. Config entries refer to actions, not raw key injection; allow disabling conflicts. If keys cannot be delivered by terminal, show reliable alternatives. Reject duplicate bindings in the same context (unless explicit priority) during config load. `Shift+Tab` remains reserved for agent cycling in composer, regardless of Claude compatibility profile. No leader-prefix/chord syntax supported in v1.

## Regression tests

Simulate every row above and focus context, plus AltGr on Windows, Ctrl+C in Windows Terminal, Ctrl+J newline, paste races, Shift+Enter unsupported, Escape double-tap timing, key repeats, IME composition, and Left arrow from an empty shell-mode draft versus a normal empty prompt.
