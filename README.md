# OpenCode v2 conversation-first TUI — engineering documentation

**Status:** implementation specification, not an implementation. **Research snapshot:** 2026-11-18. **Upstream baseline:** OpenCode v2.3.0 (2026-11-13). **Runtime:** Bun / TypeScript. **Frontend:** OpenTUI + Solid (proposed). **Server:** existing OpenCode v2 background service.

## Product in one paragraph

Create a standalone minimal, Claude Code-like terminal frontend for the **OpenCode v2** server. A running agent session is a conversation, not a tab or pane. Pressing **Left** from an empty, unfocused composer returns to a lightweight **agent overview** with sessions grouped by **project folder**; that overview contains its own prompt composer to launch a new session immediately. Switching away detaches the *view*, not the executing session. No header bar, no multiplexed terminals, no persistent sidebars. Collapsed tool activity by default; expand detailed tool calls and available reasoning with `Ctrl+O`. Tiny, stable footer with **token counts and session USD spend**. `Shift+Tab` cycles **OpenCode agents** with `build` as default. Direct single key/modifier shortcuts only; no multi-key `Ctrl+X A` chords. Start directly from the shell with `unnamed --provider openai --model gpt-6.1-sol --effort high "Prompt"`, subject to actual model/variant availability.

## Non-negotiable UX contracts

1. **No header bar** in the conversation view. Session/project identification belongs in the overview, terminal title (optional), or a terse footer.
2. **No default split panes, tab strips, taskbar, file tree, PTY multiplexer or window manager**. The terminal is already a window manager's canvas.
3. `Shift+Tab` = cycle selectable OpenCode agents. Default `build` when available. `plan` is an agent, **not** a transplanted Claude permission mode.
4. **Left** on an *empty composer with cursor at the beginning and no modal/completion active* returns to overview. It must **not** steal ordinary Left-arrow editing.
5. Overview: grouped by folder; all relevant local projects; newest activity first within groups; status indicator, sessions in parallel, new-session composer; changing selection does **not** abort or cancel.
6. **Claude-style minimal transcript**: group repetitive tool activity; keep errors and permission questions prominent; show available reasoning only in detailed transcript; never fabricate hidden reasoning.
7. **Footer:** provider/model/variant, current agent, running/idle/needs-input state, session token usage and actual session spend. The number is a session total; do **not** label it context-window occupancy unless separately computed.
8. **One CLI executable, positional interactive prompt**; `-p/--print` is explicit noninteractive mode, never assumed because a prompt was supplied.
9. **Server remains authoritative** for agents, permissions, models, events, session history and mutations. The UI may persist local presentation state but may not fork or impersonate a backend agent.
10. **Multi-client-safe:** the frontend can detach/reattach to one running backend session. Never accidentally spawn a second agent loop or erase queued input.

## Reading order

| File | Purpose |
| --- | --- |
| [docs/01-product-contract.md](docs/01-product-contract.md) | Behavioral requirements, flows, exclusions |
| [docs/02-upstream-source-map.md](docs/02-upstream-source-map.md) | Verified upstream API/source code and caveats |
| [docs/03-system-architecture.md](docs/03-system-architecture.md) | Packages, boundaries, process lifecycle |
| [docs/04-navigation-overview.md](docs/04-navigation-overview.md) | Left-arrow overview, project grouping, focus rules |
| [docs/05-conversation-rendering.md](docs/05-conversation-rendering.md) | Minimal UI, grouping, detailed transcript, reasoning |
| [docs/06-composer-and-keymap.md](docs/06-composer-and-keymap.md) | Single keybindings, collisions, editing behavior |
| [docs/07-cli-contract.md](docs/07-cli-contract.md) | Executable commands, argument validation, exit modes |
| [docs/08-server-adapter.md](docs/08-server-adapter.md) | OpenCode v2 endpoint mapping and adapter API |
| [docs/09-sessions-events.md](docs/09-sessions-events.md) | Session/inbox state machines, sync, reconnect |
| [docs/10-models-agents.md](docs/10-models-agents.md) | Agent cycling, model catalog, variants/effort |
| [docs/11-goals-plans-tasks.md](docs/11-goals-plans-tasks.md) | Explicit goals, plans, tasks and durable context |
| [docs/12-permissions-and-safety.md](docs/12-permissions-and-safety.md) | Permission UX and server enforcement |
| [docs/13-usage-footer.md](docs/13-usage-footer.md) | Tokens/cost semantics and footer rules |
| [docs/14-terminal-platform.md](docs/14-terminal-platform.md) | Cross-platform input, resize, clipboard, accessibility |
| [docs/15-testing-acceptance.md](docs/15-testing-acceptance.md) | Deterministic tests, fixtures, regressions |
| [docs/16-delivery-roadmap.md](docs/16-delivery-roadmap.md) | Milestones, issue-sized work, gates |
| [docs/17-risks-open-questions.md](docs/17-risks-open-questions.md) | Confirmations and dependency risks |
| [docs/18-implementation-recipes.md](docs/18-implementation-recipes.md) | TypeScript-oriented reducers, queue/reconnect recipes |
| [docs/19-config-commands.md](docs/19-config-commands.md) | Config schema, slash commands, persistence and key overrides |
| [docs/20-conversation-interactions.md](docs/20-conversation-interactions.md) | Fine-grained UX interaction behavior |
| [adr/0001-through-0005.md](adr/0001-through-0005.md) | Architecture decision records |
| [checklists/upstream-verification.md](checklists/upstream-verification.md) | Upstream contract probes before coding |
| [checklists/done-criteria.md](checklists/done-criteria.md) | Release-level checks |

## Source of truth / citation policy

Official public OpenCode v2 docs and **tagged** v2.3.0 source files are cited inline, not unverified claims about an API. Claude Code docs are cited only to explain desired UX inspiration. UX requirements invented by this project are marked **design decision**. Anything relying on undocumented behavior is labeled **verification required**. Do not treat code fragments in these documents as compiled, tested SDK examples: they are adapter sketches until a lockfile is generated and `bun run typecheck` succeeds against the pinned SDK.

Use [docs/02-upstream-source-map.md](docs/02-upstream-source-map.md) as the first stop whenever OpenCode changes versions.

## First sprint

Create the workspace and a tiny `connect → list sessions → create session → prompt → stream assistant → detach to overview → reattach` vertical slice. Use OpenCode's **network client** `@opencode/client`, not the embedded `@opencode/sdk`. Use `Service.ensure()` to discover or start the background service. Render real server messages and actual usage data before polishing styling.

## Running margarita

Requires Bun (see `.bun-version`) and an OpenCode v2.3 service that is already running. Margarita discovers the registered local service read-only; it never starts, stops or reconfigures it unless you pass `--start-server` (and only when no service is registered).

The command is `marg`. Build a self-contained executable (Bun runtime and OpenTUI's native library embedded) and put it on your PATH:

```sh
bun install
bun run build                       # → dist/marg.exe (dist/marg elsewhere)
bun run build bun-linux-x64         # cross-compile for another target
```

Copy `dist/marg.exe` into any directory on PATH (for example `%USERPROFILE%\.local\bin`). Alternatively `bun link` registers `marg` from source.

```sh
marg                                # new session in the current directory (Left → overview)
marg "fix the flaky test"           # new session with that prompt
marg --continue                     # latest session in this directory
marg --resume                       # session overview
marg --resume ses_123               # exact session
marg -p -m opencode/longcat-2.5-free "summarize README.md"   # print mode
marg --help
```

From a checkout, `bun run start …` is equivalent.

The overview lists sessions by project, most recently used first, six per project; `[Show more]` expands the rest inline.

Packaging rationale: [ADR-0006](adr/0006-packaging.md).

Keys: `Left` on an empty prompt opens the overview · `Shift+Tab` agent · `Alt+P` model · `F2` recent model · `Ctrl+O` details · `Ctrl+R` history search · `Ctrl+S` stash · `Ctrl+G` `$EDITOR` · `Ctrl+J` newline · `Alt+Enter` steer · `Ctrl+T` goal and task checklist · `Ctrl+B` move running tools to the background · `Ctrl+C` interrupt/clear/exit · `F1` help. Override in `%LOCALAPPDATA%\margarita\config.jsonc` (XDG config dir elsewhere).

Goals and plans: `/goal <title>`, `/criteria a; b`, `/plan step one; step two` (or a pasted list), `/plan propose` asks the agent and `/plan adopt` turns its reply into a proposal you accept (`a`) or reject (`r`) in Ctrl+T. Plans are local (`goals/` under margarita's state directory) until you run `/sync on`, which writes a short instruction entry the agent sees; `/sync off` removes it. Session tools: `/rename`, `/fork`, `/revert` (confirm or restore), `/diff [turn]`, `/export [file]` (full chat log as JSON).

Config (`config.jsonc`):

```jsonc
{
  "agents": { "default": "build", "cycle": ["build", "plan"] },
  "input": { "enterWhileRunning": "queue" },       // or "steer"
  "keys": { "tasks.toggle": "alt+t" },              // single keys only, no chords; see F1 for action IDs
  "ui": { "theme": "dark", "animation": true, "ascii": false }  // theme: dark | light | high-contrast
}
```

Environment: `NO_COLOR`, `MARGARITA_NO_ANIMATION=1` (static activity indicator), `MARGARITA_ASCII=1` (ASCII spinner frames), `MARGARITA_SERVER_PASSWORD` (for `--server`).

## Development

- `bun run verify` — format check, oxlint (type-aware), typecheck, tests.
- `MARGARITA_LIVE=1 bun test test/live-smoke.test.tsx` — read-only check against your running service.
- Layers: `src/domain` (pure, tested), `src/adapter` (SDK mapping, event pump), `src/app` (controller, key router), `src/ui` (OpenTUI/Solid views), `src/cli` (args, print mode).
