# 19 — Configuration, commands and user customization

## Configuration location and precedence

Proposed frontend-specific settings: `~/.config/unnamed/config.jsonc` under XDG and `%LOCALAPPDATA%\unnamed\config.jsonc` on Windows (or a documented AppData-compatible override). Precedence: CLI flags > project-local frontend config **only if explicitly trusted/opted in** > user config > built-in defaults > server defaults for backend-managed values. Never override server permissions simply by loading an untrusted repository file.

```jsonc
{
  "$schema": "https://example.invalid/unnamed-config.schema.json",
  "schemaVersion": 1,
  "ui": {
    "theme": "terminal",
    "header": false,
    "toolGroups": "compact",
    "reasoning": "details-only",
    "reducedMotion": true,
    "defaultRoute": "overview",
    "footer": ["agent", "model", "state", "tokens", "usd"]
  },
  "sessions": {
    "groupBy": "project-directory",
    "sortBy": "last-meaningful-activity",
    "showChildren": false,
    "showArchived": false,
    "keepRunningOnDetach": true
  },
  "agents": {
    "default": "build",
    "cycle": ["build", "plan"],
    "includeOtherSelectableAgents": true
  },
  "input": {
    "enterWhileRunning": "queue",
    "overviewOnEmptyLeft": true,
    "chords": false
  },
  "models": { "recentLimit": 8 },
  "goals": { "syncInstructionEntries": "opt-in" },
  "keys": {
    "agent.cycle": "shift+tab",
    "model.pick": "alt+p",
    "model.recentNext": "f2",
    "transcript.details": "ctrl+o",
    "tasks.toggle": "ctrl+t",
    "history.search": "ctrl+r",
    "composer.stash": "ctrl+s",
    "composer.editor": "ctrl+g"
  }
}
```

The schema URL is a **placeholder**; implement a real local or published JSON schema before distributing config. `header:false`, `chords:false`, and `keepRunningOnDetach:true` are invariant defaults: rather than encourage turning them into true, reject unsupported values in first release. This keeps project requirements honest and limits migration complexity.

## Commands

| Command | Behavior | Backend operation |
| --- | --- | --- |
| `/sessions` or `/bg` | Return to overview | None |
| `/new` | New session for active project, prompt composer | `session.create` on submit |
| `/resume [id]` | Overview/picker or direct attach | `session.get` |
| `/agent [id]` | Pick/switch server agent | `agent.list`, `session.switchAgent` |
| `/model [provider/model#variant]` | Select model/variant | `model.list`, `session.switchModel` |
| `/effort [variant]` | Select valid variant for current model | Model selection API |
| `/goal` | Edit user-defined goal | Local sidecar, optional instruction entry |
| `/plan` | Edit/accept plan | Local sidecar, optional prompt/sync |
| `/tasks` | View checklist | Local sidecar |
| `/diff` | Review changes from session turns | `session.diff` |
| `/transcript` | Toggle details | None |
| `/usage` | Session cost/token breakdown | `session.get`, maybe `session.context` |
| `/interrupt` | Stop active run | `session.interrupt` |
| `/queue` | Show pending inputs | `session.inbox.list` |
| `/steer` | Submit current draft with steer delivery | `session.prompt` with verified delivery mode |
| `/compact` | Explicit compaction | `session.compact` if validated |
| `/help` | Help modal | None |
| `/keys` | Key diagnostics / shortcuts | None |
| `/status` | Connection, session, model details | `server.info`, session.get |
| `/rename` | Session title update | `session.update` |

Never hardcode server-supplied slash commands as a local instruction if they conflict. Local commands take precedence, and users may pass an explicit `/server <command>` route for server callback commands if needed (future). [OpenCode session.command](https://opencode.ai/docs/api), [CLI commands](https://opencode.ai/docs/cli/commands).

## Config validation

At startup parse JSONC with schema validation and detailed path errors; reject unknown keys only with actionable warnings for forward-compatible versions. On invalid config, allow safe defaults and show one warning, but **do not** silently enable an unsafe permission mode or apply arbitrary project-local secrets. Per-action keymap overrides validate with terminal support and context conflict analysis. No key chord parser. A literal `ctrl+x a` is invalid, not interpreted as two separate bindings.

## Persistent UI preferences

Store last project, recent models, transcript fold states, drafts and goal/plan sidecars separately from config. Use a versioned persistence path and atomic saves. Limit draft storage size and provide clear `/clear-drafts` command. Session history remains backend-owned. Hidden tool detail state may be local-only: opening same session from a different frontend need not synchronize its fold preferences.

## Themes and minimalism

Use terminal palette initially (normal text, dim secondary, error/attention accent); no imitation of proprietary Claude logo, icons or typography. Support `NO_COLOR`, dark/light and one `subtle` theme. Layout should work without any branding, header, repeated labels, separators or animated banner. Any footer customization cannot remove both token count and cost without explicit choice.

## Documentation and migration

Maintain a human-readable config reference generated from schema. Every default key should have a corresponding action documentation entry. When app config version changes, migrate in memory and write only after user confirms, or use backed-up atomic migration. Future custom agent sets and remote multi-server overview should be feature gates, not implied by configuration keys that do nothing.
