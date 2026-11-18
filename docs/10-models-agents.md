# 10 — Agents, models, providers and effort

## Agent behavior (intentional divergence from Claude Code)

`Shift+Tab` cycles **OpenCode agents**, not permission modes. Newly created sessions start with **`build`** if present in `GET /api/agent`; fallback to the server default only if Build is unavailable, with an unobtrusive explanatory status. Initial list should include server-known `build` and `plan` (where configured) and any user-defined *primary/selectable* agents; exclude disabled, hidden and subagent-only entries unless shown in separate picker. OpenCode agents can be customized/disabled: [Agents docs](https://opencode.ai/docs/agents/). Server agent switch route: [`session.switchAgent`](https://opencode.ai/docs/api).

Agent cycle is ordered by explicit config first (`build`, `plan`, then stable alphabetical custom agent IDs), not backend response ordering, and wraps around. `Shift+Tab` after a session reattach should use the actual selected agent from server, not frontend's remembered value. If agent switched while running, selection applies to **subsequent provider turns**; show a tiny `Agent: plan (next turn)` hint if not immediate. Do not interrupt execution implicitly.

Custom agents later: abstract the UI around `AgentDescriptor` (`id`, `displayName`, `selectable`, `description`, `permissions`) without embedding assumptions that `build` and `plan` are eternal. A future default agent set may be bundled as optional configuration to OpenCode server. Until then reuse server agents; don't fork core prompts. [OpenCode agents configuration](https://opencode.ai/docs/agents/).

## Provider and model selection

`--provider` is explicit server provider ID (e.g. `openai`), `--model` is a catalog model ID, `--effort` chooses an **available variant**. The model syntax in OpenCode is `provider/model#variant`; official examples include `openai/gpt-6.1-sol#high`. **Model list and effort variants are dynamic**; never hardcode high/medium/low as universal. Sources: [OpenCode models](https://opencode.ai/docs/models/), [OpenCode provider/model endpoints](https://opencode.ai/docs/api).

Model picker opened with `Alt+P` should be a minimal searchable list, grouped first by provider, with short variant hint. Search tokens by ID, name, provider. Mark unavailable credentials/models based on actual server catalog. Don't show prices the server didn't supply. Current selection in footer `openai/gpt-6.1-sol#high` can be shortened to `gpt-6.1-sol · high` if provider is obvious.

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
