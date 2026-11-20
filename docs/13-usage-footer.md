# 13 — Usage, money and the only persistent chrome

## Required footer

Claude Code opens each session with a compact, bordered welcome panel rendered directly into the chat transcript, not a fixed application header, so it naturally scrolls out of view as the conversation grows. The left side features Claude’s small pixel-art mascot, a simple “Welcome back!” greeting, the active model name, its reasoning effort level, subscription or API billing information, and the current project directory. A small title along the top identifies the Claude Code version. On wider terminals, the right side displays contextual getting-started tips, recent session activity, and occasionally release notes or update notices. The layout adapts to terminal width, collapsing or omitting secondary information when space is limited. Its restrained borders, muted secondary text, and minimal decoration make it feel like part of the conversation rather than permanent application chrome.

We will adapt this transcript-inline 'welcome panel' to this application, and opencode's behaviours. Put a little ascii cat face as the mascot. 

**No persistent header bar.** A single compact footer beneath the composer is the only always-visible status area. It should convey: **agent, model/variant, execution state, session token count, session USD spend**. The user specifically values token and spend visibility, so both stay visible at ordinary terminal widths.

Example, proposed:

```text
build (shift+tab) · muse-ember-1.0#high · ⬇ 1 shell ⬅ 3 sessions · 46ktok (33%) · $0.38
```

Use actual server session totals. Do not call total token usage "context remaining". Session API `Session.Info` includes `cost` (Money.USD) and `tokens` (TokenUsage.Info: input, output, reasoning, cache). [OpenCode API](https://opencode.ai/docs/api), especially schema `Session.Info` and `TokenUsage.Info`. Tokens get rounded to the nearest thousand.

## Costs: display contract

`cost` is a USD monetary value as reported by OpenCode. Format `$0.38`, `$1.24`, `$123.40`; optionally 3–4 fractional digits below 1 cent when user opts in. For unpriced local/free model sessions, show `$0.00` **only if server explicitly reports zero**; do not imply zero billing when usage/cost data absent. Show `—` or `cost unavailable` where necessary. If server returns a cost aggregate for session, present it as **session spend**, not account spending or external subscription quota. Don't infer actual vendor invoice from estimates.

If child agent costs are rolled into parent: **verification required**. Until checked, label only `Session cost (server-reported)` and do not claim all child consumption is included.

## Tokens: display contract

Server `TokenUsage.Info` fields `input`, `output`, `reasoning`, and nested `cache` represent aggregate usage. The footer headline should be a clearly defined **total usage count** if safely computable without double-counting caches. Choose formula only after inspecting generated type and how input/cache overlap in API. Safe initial strategy: show `input/output` separately when ambiguity persists: `42k in · 5k out`. Secondary `/usage` detail shows all categories with cache. Do not add `reasoning` to `output` if reasoning is already included in output in particular provider accounting.

If the user wants context-window occupancy, derive it from *active context after compaction* and current model context limit; that is a separate feature requiring accurate model metadata, not cumulative session usage. [Session context](https://opencode.ai/docs/api).

## Update timing and consistency

Update footer on `session.usage.updated`, end-of-step events, and canonical session snapshot refresh. Debounce UI redraws (e.g., 100–250ms) without changing numbers. Do not animate increments each token—usage may only settle after a request completes. While a model run is active, leave last known total shown with `~`/pending mark only if meaning is clear. On reconnect mark stale until refreshed.

## Narrow width

At ≥100 cols show `build · openai/gpt-6.1-sol#high · running · 47k tokens · $0.38`. At 80 cols shorten provider name and labels; at 50 cols retain `build · high · 47k · $0.38`, optionally status symbol. At very narrow widths, preserve token and spend first, move other data to `/status`; avoid horizontal scrolling. Don't introduce a header to solve width limitations.

## Source of truth

Use `session.get` or refreshed session list as authoritative numbers. The `session.usage.updated` event can improve timeliness; its payload must be interpreted by generated types, and any unknown event is not allowed to set usage to zero. Cache the last valid confirmed value. [OpenCode API](https://opencode.ai/docs/api).

## Clickable footer and session analytics (#124)

The footer is rendered as separate semantic segments with stable action IDs, not one string with text search. The **agent**, **model/variant** and **context** segments are clickable (OpenTUI `onMouseDown` on the visible span only), so click targets always align with the text after width degradation and resize. Agent opens the agent picker, model the model picker, and context the usage summary. Each has a keyboard equivalent (`/agent` / Shift+Tab, Alt+P / `/model`, `/usage`), so no action requires a mouse. Each control is a **toggle**: clicking it a second time closes the overlay it owns, without selecting a row, resetting the composer, or submitting anything (#139). The exception to the click guard is strictly the matching footer-controlled overlay; permission/form/revert and all other unrelated dialogs are never dismissed or bypassed by a footer click. Picker opens carry a token plus route identity, so a rapid double-click during a slow catalog load cancels cleanly and a late response can neither resurrect a dismissed picker nor open one on a route the user has since left.

Three quantities are kept strictly separate. **Lifetime** input/output/reasoning/cache totals and USD spend are the server's cumulative `session.tokens`/`cost` and are never reset by compaction. **Current context** is the sum of the latest assistant step's token categories (`input + output + reasoning + cache.read + cache.write`, matching OpenCode v2.3.0 `contextUsage`) *after* the last **completed** compaction, divided by the context limit of the **model used on that step** (not the currently selected model). A staged revert excludes later steps; clearing it restores them. A completed compaction with no subsequent valid step shows pending, and a failed/running compaction never resets the reading. When the step model has no known limit, the numeric token count is shown without a fabricated percentage. **USD spend** is server-reported and shown as `not reported` when absent, never `$0.00`; it is labelled as session spend, not an invoice.

`src/domain/usage-analytics.ts` is a pure projector: it returns explicit `unknown`/`unavailable` for missing evidence and never does wire mapping or formatting. `/usage` and a context click call the same projector and the same summary component. The summary also reports activity with explicit denominators: tool-using completed assistant turns / all completed assistant turns, plus tool-call counts by category (read/search/edit/shell/web/delegate/MCP/other) and outcomes (completed/failed/running) with the failure rate only over known outcomes. Tool/turn stats are labelled **loaded messages only** — they are never presented as whole-session figures from a paginated window. Per-assistant token categories and model `limit.context` are preserved through the adapter; per-tool USD and context-window percentages are never invented.

## Tests

- Change selected model mid-session; footer model reflects next-turn selection, cost remains cumulative.
- Compaction does not reset session spend; context-window percentage, if introduced, is separately recalculated.
- Local model with zero USD server cost shows `$0.00` (never a negative number).
- Unavailable cost shows `—`, not `$0.00`.
- 40-column width remains usable, no header bar added.
- Background A updates its footer when reattached after B session executed.
