# 10 — Agents, models, providers and effort

## Agent behavior (intentional divergence from Claude Code)

`Shift+Tab` cycles **OpenCode agents**, not permission modes. Newly created sessions leave the
agent unset unless the user picks one, so the **server's effective `default_agent`** (which may
be `build`, `plan` or a custom project agent) wins; this respects OpenCode's directory-scoped
config merging instead of hard-coding a frontend preference. The list includes every server-known
primary/selectable agent — built-ins, global and project-local — and excludes disabled, hidden
and subagent-only entries from both the cycle and the picker. OpenCode agents can be
customized/disabled: [Agents docs](https://opencode.ai/docs/agents/). Server agent switch route:
[`session.switchAgent`](https://opencode.ai/docs/api).

Agent cycle is ordered by explicit config first (`build`, `plan`, then stable alphabetical custom agent IDs), not backend response ordering, and wraps around. `Shift+Tab` after a session reattach should use the actual selected agent from server, not frontend's remembered value. If agent switched while running, selection applies to **subsequent provider turns**; show a tiny `Agent: plan (next turn)` hint if not immediate. Do not interrupt execution implicitly.

**Switch acknowledgement (#256).** The pinned `@opencode/protocol` 2.3.x contract defines
`session.switchAgent` as `POST /api/session/:sessionID/agent` with `success: NoContent` and
`SessionNotFoundError` as the only declared error. A resolved promise therefore means the
server accepted and committed the selection for subsequent provider turns, even though the
optional `agent` field on `session.get` may still be absent. Margarita keeps prompt admission
blocked until that acknowledgement and a fresh session read complete; an absent summary field
is not treated as a different agent, while a reported different agent fails the switch. The
disposable writable suite asserts that the next assistant message uses the selected agent.

Custom agents are supported through the searchable **F3 / `/agent` picker**, which lists every
selectable agent returned by the server's location-scoped `agent.list` (built-ins, global and
project-local, including nested IDs). Rows show the agent ID and description; the current
agent is marked. `Shift+Tab` / `Alt+Shift+Tab` remain the quick cycle over the same
de-duplicated, alphabetically stable set, so backend result ordering never changes the cycle.
A server-rejected switch restores the previously confirmed agent, and an agent that disappears
or becomes hidden/disabled is never silently replaced — the user is asked to pick another.

**Provenance limitation (#123).** The pinned `@opencode/client@2.3.0` `AgentInfo` exposes
`id`, `name`, `model`, `request`, `system`, `description`, `mode`, `hidden`, `color`, `steps`
and `permissions` — **no source/scope field**. There is therefore no supported way for a
terminal client to tell a project-defined agent from a global or built-in one, and guessing
from IDs or reading config files on Margarita's own machine would be wrong for remote servers.
Margarita deliberately cycles and offers the **full selectable catalog** instead of applying a
project-only filter it cannot verify. If a future server API exposes provenance, the quick
cycle can narrow to the project-defined set without changing the picker.

**#138 investigation (re-confirmed).** The generated SDK types were checked again with the
2.3.2 package: `AgentInfo` still has **no** `source`, `scope`, `builtin`, `location` or
`path` field, and `AgentListInput` only accepts `location.directory` — it returns the merged,
effective catalog for that directory. The config agent definitions carry no provenance either.
There is consequently no server-supported way for *any* client, local or remote, to classify
an agent as project-defined, global or built-in. The smallest upstream addition that would
unblock project-defined-first cycling is an optional provenance field on `AgentInfo` (for
example `source: 'project' | 'global' | 'builtin'`, scoped to the queried `location.directory`),
plus a matching filter on `agent.list` so the server — not the client — resolves the set.
Until that exists, Margarita keeps the full deterministic selectable catalog for Shift+Tab;
this is an explicit limitation, not a silent approximation of project-aware behavior.

New sessions leave `agent` unset when the user has not chosen one, so the **server's own
`default_agent`** wins; an explicit choice or CLI flag overrides it. Existing sessions are
never moved automatically. [OpenCode agents configuration](https://opencode.ai/docs/agents/).

## Provider and model selection

`--provider` is explicit server provider ID (e.g. `openai`), `--model` is a catalog model ID, `--effort` chooses an **available variant**. The model syntax in OpenCode is `provider/model#variant`; official examples include `openai/gpt-6.1-sol#high`. **Model list and effort variants are dynamic**; never hardcode high/medium/low as universal. Sources: [OpenCode models](https://opencode.ai/docs/models/), [OpenCode provider/model endpoints](https://opencode.ai/docs/api).

Model picker opened with `Alt+P` is a minimal searchable list with **one row per model** — effort is not expanded into extra rows. Rows are grouped by provider (alphabetical); official Anthropic and OpenAI/Codex providers order by numeric release then tier (`Mythos > Fable > Opus > Sonnet > Haiku`, `Astra > Sol > Terra > Luna`), while third-party routers stay alphabetical even when their model IDs mention a vendor. Search tokens still match ID, name and provider, including across groups. Don't show prices the server didn't supply. Current selection in footer `openai/gpt-6.1-sol#high` can be shortened to `gpt-6.1-sol · high` if provider is obvious.

Effort is selected separately with `Alt+E` or `/effort` (no argument opens the picker; `/effort high` selects directly). Its choices come from the effective model's verified scoped catalog, with a `default (no override)` row and any variants the server advertises — never a hardcoded list. Marking the current variant, changing model, and confirming switches follow the same server-verified path as model selection; an unsupported variant never carries onto a different model.

`F2` cycles recently selected models in session/project, skipping models no longer present in catalog. Avoid accidentally switching variant to default when cycling: preserve (modelID, providerID, variant) tuple as recently used selection. An explicit `--effort high` can select `#high`; if unsupported, error with variants from catalog.

## API model-selection matrix

| Event | Frontend action | Backend persistence |
| --- | --- | --- |
| CLI creates session | Resolve model/variant before creating | `session.switchModel`, then first prompt |
| `Alt+P` picks model | Validate against live catalog | `session.switchModel` |
| F2 cycles model | Validate available | `session.switchModel` |
| Shift+Tab agent | Validate agent selectable | `session.switchAgent` |
| Server emits model/agent selected | Update footer and transcript marker | Canonical server wins |
| Model removed while running | Show stale selection, do not blindly mutate | Await user choice / backend error |

The API's model and agent switches apply to subsequent turns, so UI must not falsely relabel past assistant responses. Assistant message schema includes its actual model and agent: [OpenCode API Session.Message.Assistant](https://opencode.ai/docs/api).

## Model variants vs reasoning traces

Effort (`#low`, `#high`, etc.) specifies model invocation configuration if catalog accepts it. It does **not** guarantee a readable chain of thought. Independently, OpenCode `reasoning` content may or may not be populated. The detailed transcript renders available text; otherwise only token count is known. [OpenCode reasoning schema](https://opencode.ai/docs/api).

## Permission implications of Plan agent

OpenCode `plan` is an agent configuration with its own tools/permissions. `Shift+Tab` to plan is not a permission-mode toggle; it must not silently alter global backend policy in ways not defined by that agent. If the future custom Plan agent is read-only, enforce by server-side agent permissions and test file writes/shell behavior. [OpenCode agents](https://opencode.ai/docs/agents/).

## Model/provider edge cases

- Same model name under two providers → provider required or prompt in interactive UI.
- `--model openai/gpt-6.1-sol#high` and `--effort low` → conflict, hard error.
- Provider connected but credentials expired → show provider error, preserve draft.
- Model removed from catalog during run → current run may complete; switch blocked for next turn until revalidated.
- Special variants `fast`, `thinking`, `max` → use catalog names, no normalization to nonexistent standard efforts.
- Developer changes model in another client → event updates footer; show a terse transient note but do not steal focus.
