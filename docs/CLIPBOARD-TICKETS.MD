# **Margarita — clipboard and text selection issues**

Audited [Margarita master at `f417eef`](https://github.com/estyseesghosts/margarita/commit/f417eefee97addc3d1dac4888c3dc18868ee609a?utm_source=chatgpt.com), using its current OpenTUI 0.9.2 implementation.

There are several distinct problems in the current tree:

- **Copying exists, but only in a limited form.** `Alt+C` and `/copy` open a picker for tool output, diffs, errors and fenced code blocks. Ordinary assistant responses are not included.
- **Clipboard writes are unreliable.** Margarita exclusively uses OSC 52, without a native system clipboard backend. Its 4,096-byte Base64 limit means anything exceeding roughly 3 KB of UTF-8 text gets written to a file instead.
- **Paste processing exists, but clipboard acquisition is incomplete.** Margarita listens for terminal-generated paste events but has no explicit `Ctrl+V` action or system clipboard reader.
- **Mouse interaction lacks clipboard integration.** Existing mouse handlers perform UI actions, but there is no application-level selection-to-clipboard workflow or context-sensitive right-click handling.

The existing paste processing, route ownership protections and exact-text copy picker are worth preserving. This should be a targeted extension of those systems, not a rewrite.

## **Intended interaction model**

| Interaction                   | Behaviour                                    |
| ----------------------------- | -------------------------------------------- |
| Left-click and drag           | Select terminal text visibly                 |
| Release selection             | Automatically copy when autocopy is enabled  |
| Right-click with selection    | Copy selected text                           |
| Right-click without selection | Paste into the active input                  |
| Ctrl+V                        | Paste from system clipboard                  |
| Ctrl+Shift+V                  | Terminal-native or application paste         |
| Ctrl+Shift+C                  | Copy selected text                           |
| Alt+Shift+C                   | Copy last complete agent response            |
| Alt+C                         | Preserve existing copy picker                |
| Ctrl+C                        | Preserve interrupt, clear and exit behaviour |
| Ctrl+Y                        | Preserve existing composer yank              |

I would enable autocopy by default, make it configurable, and keep explicit selection copying available regardless of that setting. The proposed new copy shortcuts are implementation choices, not existing Margarita bindings.

## **Issue 1 — Implement a reliable client-local clipboard service**

**Priority: P0 · Foundation**

The current clipboard implementation treats almost every TTY as capable of accepting OSC 52. It cannot determine whether the terminal actually accepted the clipboard write, and it has no clipboard read capability.

**Source references**

- [`src/app/clipboard.ts:7–40`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/app/clipboard.ts?utm_source=chatgpt.com#L7-L40) — current clipboard service.
- [`src/domain/osc52.ts:10–14`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/domain/osc52.ts?utm_source=chatgpt.com#L10-L14) — encoded payload limit.
- [`src/app/production-assembly.ts:302–314`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/app/production-assembly.ts?utm_source=chatgpt.com#L302-L314) — production dependency injection.
- [`src/app/controller.ts:6139–6147`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/app/controller.ts?utm_source=chatgpt.com#L6139-L6147) — controller-level copy destination.

**Deliverables**

- Extend the existing clipboard service to support both reading and writing.
- Implement native clipboard access on Windows, macOS and Linux, including Wayland and X11.
- Prefer native clipboard access for local execution; retain OSC 52 as a fallback for appropriate terminal environments.
- Support large, multiline Unicode payloads without the current OSC 52 size restriction when using native access.
- Distinguish successful native writes, unconfirmed OSC 52 writes, unavailable clipboards and file fallbacks.
- Route all existing clipboard consumers through the same service, including the copy picker, inspector and external form URL copying.
- Inject clipboard dependencies so tests do not require an actual desktop clipboard.

**Avoidables**

- Do not introduce a second, independent clipboard implementation in the UI.
- Do not execute clipboard operations on the OpenCode server.
- Do not spawn a shell on every mouse movement.
- Do not split oversized text into multiple OSC 52 writes; receivers generally replace rather than append clipboard contents.
- Do not silently write clipboard contents to disk on every failed autocopy.

**Regression traps**

- Windows Unicode encoding and CRLF handling.
- Wayland clipboard ownership and helper-process lifetimes.
- SSH, WSL, tmux and headless environments.
- Clipboard contention or unavailable system services.
- Concurrent writes completing out of order.
- Existing owner-only file fallback guarantees.

## **Issue 2 — Repair paste acquisition and unify paste entry points**

**Priority: P0 · Depends on #1**

Margarita already has fairly extensive paste processing. The missing piece is reliably acquiring clipboard contents and delivering them to that processing layer.

`Ctrl+V` currently falls through the keyboard router without performing a clipboard action. The existing mounted UI tests simulate bracketed paste directly, bypassing this problem.

**Source references**

- [`src/ui/app.tsx:80–107`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/ui/app.tsx?utm_source=chatgpt.com#L80-L107) — keyboard and terminal paste hooks.
- [`src/app/key-router.ts:445–480`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/app/key-router.ts?utm_source=chatgpt.com#L445-L480) — control-key handling.
- [`src/app/controller.ts:3428–3518`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/app/controller.ts?utm_source=chatgpt.com#L3428-L3518) — paste processing and attachment classification.
- [`src/app/controller.ts:3527–3668`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/app/controller.ts?utm_source=chatgpt.com#L3527-L3668) — overlay routing and originating draft protection.
- [`src/domain/composer.ts:115`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/domain/composer.ts?utm_source=chatgpt.com#L115) — text insertion.

**Deliverables**

- Introduce a configurable `clipboard.paste` action, bound to `Ctrl+V` by default.
- Support `Ctrl+Shift+V` where delivered to the application.
- Create one common paste entry point accepting clipboard bytes and MIME metadata.
- Route native clipboard reads and existing OpenTUI paste events through that entry point.
- Capture the originating session, server, overlay and form token **before** asynchronous clipboard acquisition begins.
- Ensure paste inserts at the current editing position and participates in existing undo history.
- Preserve image, PDF and file-path attachment handling.
- Report clipboard acquisition and processing errors instead of silently swallowing them.
- Ensure pasted multiline content never triggers submission.

**Avoidables**

- Do not simulate typing individual characters.
- Do not replace the custom composer with an OpenTUI textarea merely to obtain paste support.
- Do not introduce separate paste semantics for keyboard, mouse and bracketed paste.
- Do not repurpose `Ctrl+Y`, which already implements composer yank.

**Regression traps**

- Duplicate insertion when a terminal shortcut also emits bracketed paste.
- Pasting into the wrong session after an asynchronous clipboard read.
- Pasting into a different form after the original form closes.
- Text that resembles a file path being inadvertently consumed as an attachment.
- Searchable overlays receiving multiline input.
- Binary clipboard contents being decoded as ordinary text.
- Paste events arriving while an external editor owns the terminal.

## **Issue 3 — Implement native terminal text selection**

**Priority: P0 · Independent of #1**

Selection needs to become a proper renderer-level interaction. Margarita's transcript is composed of individually rendered, windowed elements rather than ordinary terminal scrollback.

**Source references**

- [`src/main.ts:283–289`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/main.ts?utm_source=chatgpt.com#L283-L289) — renderer initialization.
- [`src/ui/transcript-view.tsx:424–485`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/ui/transcript-view.tsx?utm_source=chatgpt.com#L424-L485) — viewport culling and indexed transcript rows.
- [`src/ui/transcript-view.tsx:783–789`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/ui/transcript-view.tsx?utm_source=chatgpt.com#L783-L789) — mouse-driven disclosure.
- [`src/ui/composer-view.tsx:49–69`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/ui/composer-view.tsx?utm_source=chatgpt.com#L49-L69) — custom composer rendering.

**Deliverables**

- Evaluate and use OpenTUI 0.9.2's selection facilities where sufficient.
- Support visible click-and-drag selection across multiple rendered text elements.
- Support selection within assistant messages, user prompts, code blocks, expanded tool output, diffs and the inspector.
- Support forward and backward selection.
- Correctly extract selected Unicode text across wrapped terminal rows.
- Allow scrolling during selection where supported.
- Maintain a clear distinction between clicking a disclosure control and dragging to select text.
- Clear or safely invalidate selections when their underlying content disappears.

**Avoidables**

- Do not implement an entirely separate terminal framebuffer.
- Do not disable mouse reporting globally to recover terminal-native selection.
- Do not disable transcript windowing or viewport culling.
- Do not store transient mouse coordinates in persistent session state.
- Do not rebuild the entire transcript on each selection movement.

**Regression traps**

- Transcript row slots being reused while selection remains active.
- Streaming output changing the layout beneath a selection.
- Wide characters, emoji, combining characters and wrapped code.
- Terminal resizing during selection.
- Clicking tool disclosure rows, overview sessions or footer controls.
- Sticky prompt duplication.
- Accidentally selecting text hidden behind an overlay.

## **Issue 4 — Implement autocopy, explicit selection copying and contextual right-click**

**Priority: P0 · Depends on #1–3**

This issue owns the interaction policy. Selection itself belongs to #3, and clipboard transport belongs to #1.

**Source references**

- [`src/ui/app.tsx:102–119`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/ui/app.tsx?utm_source=chatgpt.com#L102-L119) — root mouse and paste handling.
- [`src/ui/transcript-view.tsx:1068–1071`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/ui/transcript-view.tsx?utm_source=chatgpt.com#L1068-L1071) — tool row mouse handler.
- [`src/ui/overview-view.tsx:264–265`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/ui/overview-view.tsx?utm_source=chatgpt.com#L264-L265) — session row mouse handler.
- [`src/ui/composer-view.tsx:176–180`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/ui/composer-view.tsx?utm_source=chatgpt.com#L176-L180) — footer mouse actions.
- [`src/config/config.ts:5–28`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/config/config.ts?utm_source=chatgpt.com#L5-L28) — configuration model.

**Deliverables**

- Automatically copy a nonempty selection when the user finishes dragging.
- Introduce configurable clipboard preferences, for example:

```
{
  "clipboard": {
    "autoCopy": true,
    "rightClickCopy": true,
    "rightClickPaste": true
  }
}
```

- Right-click with an active selection copies that selection.
- Right-click without a selection invokes the common paste action.
- Add an explicit `clipboard.copySelection` keyboard action.
- Restrict existing interactive mouse handlers to appropriate mouse buttons.
- Provide lightweight copy confirmation and clear failure feedback.
- Ensure one completed selection gesture results in at most one automatic clipboard write.

**Avoidables**

- Do not continuously copy while dragging.
- Do not implement right-click paste by synthesizing keyboard input.
- Do not introduce a context menu unless it serves a separate, justified purpose.
- Do not let an unhandled right-click propagate into unrelated UI actions.

**Regression traps**

- Right-click simultaneously copying and pasting.
- Right-click expanding a tool group, changing a model or answering an agent question.
- Empty selections overwriting existing clipboard contents.
- Autocopy repeatedly firing during streaming updates.
- Clipboard notices changing transcript height and invalidating the selection.
- Disabling autocopy also disabling explicit copy.

## **Issue 5 — Copy the last complete agent response**

**Priority: P1 · Depends on #1**

This must be implemented using canonical transcript messages, not selected terminal text.

Margarita already separates exact copyable content from rendered output. That is the correct foundation for this feature.

**Source references**

- [`src/domain/copyable.ts:31–94`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/domain/copyable.ts?utm_source=chatgpt.com#L31-L94) — existing copy payload projection.
- [`src/domain/transcript.ts:132–135`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/domain/transcript.ts?utm_source=chatgpt.com#L132-L135) — assistant part types.
- [`src/domain/transcript.ts:200–238`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/domain/transcript.ts?utm_source=chatgpt.com#L200-L238) — canonical message types.
- [`src/domain/execution-segment.ts:71–149`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/domain/execution-segment.ts?utm_source=chatgpt.com#L71-L149) — execution boundaries.
- [`src/app/controller.ts:6075–6147`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/app/controller.ts?utm_source=chatgpt.com#L6075-L6147) — session-scoped copy operations.

**Deliverables**

- Introduce a pure domain function extracting the latest completed agent response.
- Define a response as the assistant's public text across one completed execution, potentially spanning multiple assistant messages and tool calls.
- Preserve original Markdown, code fences, indentation and paragraph breaks.
- Exclude reasoning parts, tool output, execution markers and UI decoration.
- Introduce a `transcript.copyLastResponse` action, provisionally bound to `Alt+Shift+C`.
- Add `/copy last` for discoverability and terminals that cannot deliver the shortcut.
- Include complete assistant responses as an additional category in the existing copy picker.
- When the current execution is still streaming, copy the previous completed response.
- Report unavailable or incomplete history honestly.

**Avoidables**

- Do not simply find the last assistant message. One execution can span multiple assistant messages.
- Do not extract text from rendered transcript nodes.
- Do not use the most recent user message as the sole execution boundary; steering can occur mid-execution.
- Do not request the entire session history from the server on every copy.
- Do not include hidden reasoning merely because detailed transcript mode is enabled.

**Regression traps**

- Executions containing multiple model steps.
- Completed assistant steps within an ongoing execution.
- Interrupted and failed executions.
- Compaction records.
- Steering and queued prompts.
- Partially loaded or evicted history.
- Identical session IDs on different servers.

The existing `executionMarkers()` logic is useful for establishing boundaries, but its fallback completion rules are intended for display. They should not, without additional checks, be treated as proof that a response is complete.

## **Issue 6 — Integrate clipboard actions into key routing and configuration**

**Priority: P1 · Cross-cutting integration**

Margarita already has a centralized configurable keymap. Clipboard actions should follow that architecture.

**Source references**

- [`src/domain/keymap.ts:8–101`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/domain/keymap.ts?utm_source=chatgpt.com#L8-L101) — action IDs and default bindings.
- [`src/app/key-router.ts:48–83`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/app/key-router.ts?utm_source=chatgpt.com#L48-L83) — routing precedence.
- [`src/app/key-router.ts:230–264`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/app/key-router.ts?utm_source=chatgpt.com#L230-L264) — modal routing.
- [`src/ui/overlays.tsx:57–75`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/ui/overlays.tsx?utm_source=chatgpt.com#L57-L75) — generated keybinding help.

**Deliverables**

- Register the new clipboard actions in the central keymap.
- Define clipboard action precedence for the composer, overview, transcript, inspector and modal overlays.
- Route paste to editable overlays without bypassing existing ownership protections.
- Route selection copy without modifying the composer or dismissing unrelated dialogs.
- Preserve configurable key overrides and collision detection.
- Document all shortcuts in F1 help and the README.
- Validate clipboard configuration fields using existing configuration parsing conventions.

**Avoidables**

- Do not scatter raw key comparisons across UI components.
- Do not introduce a separate keyboard dispatcher.
- Do not assume every terminal forwards modified key combinations.
- Do not advertise shortcuts that the active configuration has overridden.

**Regression traps**

- `Ctrl+C` interruption and exit behaviour.
- `Ctrl+Y` composer yank and inspector copying.
- `Alt+C` exact-text copy picker.
- Permission and form handling precedence.
- External editor ownership of keyboard input.
- Terminal-reserved shortcuts.

## **Issue 7 — Add end-to-end clipboard and selection regression coverage**

**Priority: P0 · Acceptance gate for all preceding issues**

The existing tests verify several downstream paste behaviours but do not establish that real clipboard acquisition works. The PTY mouse test primarily checks that mouse interactions do not crash or submit prompts.

**Source references**

- [`src/app/clipboard.test.ts:28–74`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/app/clipboard.test.ts?utm_source=chatgpt.com#L28-L74) — OSC 52 and file fallback tests.
- [`src/ui/app.test.tsx:427–450`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/ui/app.test.tsx?utm_source=chatgpt.com#L427-L450) — simulated bracketed paste.
- [`src/ui/app.test.tsx:4412–4435`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/ui/app.test.tsx?utm_source=chatgpt.com#L4412-L4435) — overlay paste.
- [`src/app/controller.test.ts:5687–5840`](https://github.com/estyseesghosts/margarita/blob/f417eef/src/app/controller.test.ts?utm_source=chatgpt.com#L5687-L5840) — asynchronous paste ownership.
- [`test/smoke/pty-smoke.py:147–166`](https://github.com/estyseesghosts/margarita/blob/f417eef/test/smoke/pty-smoke.py?utm_source=chatgpt.com#L147-L166) — terminal paste and mouse smoke tests.

**Deliverables**

Add deterministic unit and mounted UI tests, PTY tests for terminal input, and real desktop clipboard acceptance tests.

Minimum acceptance matrix:

| Scenario                             | Required result                    |
| ------------------------------------ | ---------------------------------- |
| Ctrl+V with multiline text           | Exact insertion, no submission     |
| Right-click without selection        | One paste                          |
| Right-click with selection           | One copy, no paste                 |
| Drag and release                     | Selection copied once              |
| Autocopy disabled                    | Explicit copy still works          |
| Copy 100 KB response                 | Complete native clipboard contents |
| Copy Unicode code block              | No corrupted characters            |
| Copy during streaming                | Correct completed response         |
| Switch session during clipboard read | No cross-session contamination     |
| Paste image or PDF                   | Existing attachment behaviour      |
| Clipboard unavailable                | Clear, truthful feedback           |
| Exit application                     | Terminal state restored            |

Test against Windows Terminal first, then representative Linux Wayland/X11 terminals, macOS terminals and SSH/tmux environments.

**Avoidables**

- Do not treat successfully emitting OSC 52 as proof of successful clipboard copying.
- Do not rely exclusively on mocked clipboard services.
- Do not introduce flaky timing-based clipboard tests into the standard unit suite.

**Regression traps**

- Clipboard tests interfering with the user's real clipboard.
- Duplicate event delivery.
- Unrestored terminal mouse or bracketed-paste modes.
- Selection processing increasing CPU usage during streaming.
- Clipboard contents leaking into diagnostic logs.

## **Implementation order**

The most important architectural distinction is that Margarita needs two different copy mechanisms:

- **Visual selection copying:** copies what the user selects in the terminal.
- **Semantic response copying:** copies underlying message content independently of rendering, wrapping, scrolling or collapsed sections.

Both should share the same clipboard service.

There is no reason to rewrite the composer, transcript renderer or OpenCode v2 adapter to accomplish this. The existing foundations are sufficient.

**Audit limitation:** I inspected the current repository and relevant tests, but did not reproduce the failure on Windows or execute the application. The missing clipboard acquisition path and OSC 52 limitations are confirmed in source; the precise cause of any additional bracketed-paste failure requires runtime testing. No GitHub issues were filed.