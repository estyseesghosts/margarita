# 17 — Risks, uncertain assumptions, decisions to validate

The requested workflow is settled. The items below are **engineering verification**, not questions to block implementation.

## High-risk integration edges

| Risk | Why it matters | Probe/mitigation |
| --- | --- | --- |
| Live-only event source loses events | Stream disconnect can leave wrong UI state | Subscribe/buffer, reconcile snapshots; don't assume replay ([SDK](https://opencode.ai/docs/build/client)) |
| Queue/steer behavior under active run | Wrong Enter default interrupts work | Test inbox delivery modes against real server; use durable prompt API ([API](https://opencode.ai/docs/api)) |
| Shared service lifetime under Bun Windows | TUI may accidentally own subprocess | `Service.ensure` Windows/Bun harness; kill TUI during active run |
| Model variants differ by provider | `--effort high` might fail | Catalog validation; exact `provider/model#variant`, never silent fallback ([models](https://opencode.ai/docs/models/)) |
| `session.background` confusion | Would unexpectedly alter tools | Never invoke on Left; pure UI route switch ([API](https://opencode.ai/docs/api)) |
| Session grouping cross-project pagination | Overview may omit older projects | Exhaust cursor/explicit load more, test multiple roots ([API](https://opencode.ai/docs/api)) |
| Output huge or malicious | Terminal flicker, escape injection, OOM | Virtualize, cap, sanitize |
| Multi-client races | Wrong permission reply/duplicate submission | Server source of truth, re-fetch after conflict |
| Token category semantics | Double-count misleading totals | Confirm usage formula from actual `TokenUsage.Info`; separate known values |
| Session tool costs with children | Misleading spend | Show `server-reported session cost` only; verify inclusion |
| Experimental instruction entry instability | Goal sync breaks | Keep structured plan sidecar primary, sync optional |
| Key decoding under Windows/tmux | Ctrl+Enter indistinguishable; Alt chords swallowed | Capability detection, `/steer` fallback, terminal matrix |

## Known source-specific cautions

- OpenCode `GET /api/model` snapshot may arrive before all provider/plugin settlement; refresh or subscribe to provider/model updates. [API](https://opencode.ai/docs/api).
- OpenCode v2.3.0 includes background subagent behavior changes; don't infer top-level execution status from child-only events. [Changelog](https://opencode.ai/changelog/v2.3.0).
- OpenCode API experimental schema is evolving rapidly. The generated client is the gatekeeper, not prose copied from an old v1 integration. [Client](https://opencode.ai/docs/build/client).
- Claude Code's Left-arrow session overview behavior belongs to its agent view, and is reproduced as a **design contract** in our new frontend; don't assume the OpenCode server has a matching overview route. [Claude sessions](https://code.claude.com/docs/en/sessions).
- Claude Code's `Ctrl+O` expands details and tool traces. OpenCode server provides available reasoning parts, but provider-hidden reasoning cannot be reconstructed. [Claude interactive](https://code.claude.com/docs/en/interactive-mode), [OpenCode message schema](https://opencode.ai/docs/api).

## Open implementation questions and chosen defaults

### Exact API signature for variant/effort

**Default:** use generated model reference and catalog; CLI accepts `--effort` only if catalog validates. **Probe:** inspect `@opencode/client` v2.3.0 `session.switchModel` and `session.prompt` generated types; capture actual variant-preserving response. If impossible, gate effort on supported method, not a text prompt hack.

### Agent cycling during execution

**Default:** send `session.switchAgent`, update footer when confirmed, explain selection applies to subsequent turns. **Probe:** verify whether a running turn's next step picks new agent immediately or only next user turn. Never claim earlier output belongs to new agent.

### Cross-project overview query

**Default:** page session.list without narrowing by current directory if server permits; group by `projectID` and location directory. **Probe:** ensure all accessible sessions returned; cross-server support deferred.

### Terminal renderer

**Default:** full-screen OpenTUI for MVP, no header. **Probe:** alt-screen, native scrollback tradeoffs and input lag. Classic scrollback mode can be future renderer, not an implicit requirement to block starting.

### Goals and plans ownership

**Default:** local versioned sidecar with optional explicit server instruction sync. **Probe:** instructions entry behavior across compaction, fork and reconnect. Future server-shared plans need explicit plugin RPC with persistence.

### Queue editing

**Default:** cancel undelivered server item then restore copy in composer; no arbitrary in-place editing until documented by server. **Probe:** cancellation racing with delivery.

### Multi-client simultaneous composing

**Default:** each terminal maintains independent local draft and view state; backend inbox serializes accepted messages. **Probe:** update and permission conflicts; never lock a conversation just because it is visible elsewhere.

### Price display

**Default:** show server-reported session USD spend and individual known token categories. **Probe:** child sessions, cache accounting and local zero-cost models; clearly mark unavailable values.

## Decisions deliberately NOT reopened

No header. No tab strip. No multiplexer/window management. Shift+Tab cycles **agents** (Build default). No Ctrl+X-letter chords. Group tools. Ctrl+O displays detailed transcript with reasoning where available. Left-empty-composer enters project-grouped overview. Overview has new-session composer. Navigation doesn't stop runs. CLI positional prompt creates interactive session with provider/model/effort flags. These are user requirements, not open design alternatives.
