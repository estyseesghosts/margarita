# 07 — Shell-first CLI contract

## A positional prompt starts a new interactive session

```sh
unnamed
unnamed "Investigate performance in this repository"
unnamed --provider openai --model gpt-6.1-sol --effort high "Analyze the rendering path"
unnamed --agent plan --model openai/gpt-6.1-sol#high "Propose tests"
unnamed --cwd ../kohjoh "Inspect Goldenrod"
unnamed --continue
unnamed --resume ses_... 
unnamed --resume                  # Open overview/picker, not start new
unnamed --server http://127.0.0.1:4096 --no-start-server
unnamed --print --provider openai --model gpt-6.1-sol "Explain this file"
unnamed --print --json "Count failures"   # NDJSON output for scripts
```

`unnamed` is a **placeholder executable name**, not a settled product name. It should be changeable in `package.json` `bin` without touching application architecture. Positional prompt **must stay interactive**; explicit `--print`/`-p` is noninteractive. Claude Code documents positional prompt and flags in [its CLI reference](https://code.claude.com/docs/en/cli-reference). OpenCode uses `opencode run` for noninteractive operation and supports `--model`, `--agent`, `--continue`, and `--session`: [OpenCode commands](https://opencode.ai/docs/cli/commands).

## Flag specification

| Flag | Value | Default | Semantics |
| --- | --- | --- | --- |
| positional `[prompt...]` | string | none | New session + first prompt; join remaining words with spaces only if shell passed them separately |
| `--provider` | provider ID | from model/default | Disambiguate model provider |
| `--model` | ID or `provider/id[#variant]` | server/project default | Exact model selection |
| `--effort` | variant name | model/project default | Maps to **OpenCode model variant**, not generic per-request reasoning knob |
| `--agent` | OpenCode agent ID | `build` if available | Initial agent |
| `--cwd` | absolute/relative path | `process.cwd()` | New-session project cwd, normalized |
| `--server` | URL | discovered service | Connect remote/existing server; no implicit local start |
| `--no-start-server` | bool | false | Fail instead of auto-starting local service |
| `--continue`, `-c` | bool | false | Most recent eligible top-level session in cwd |
| `--resume`, `-r` | optional ID | absent | Exact ID or overview selector |
| `--print`, `-p` | bool | false | Noninteractive; print final text, deterministic exit codes |
| `--json` | bool | false | Requires `--print`; NDJSON structured events/results |
| `--config` | path | XDG/AppData default | Alternate frontend config |
| `--help`/`--version` | bool | false | No server connection |

Optional later: `--fork-session`, `--attach <id>`, `--agent-only`, `--no-autosave`, `--color`, `--debug-log PATH` (opt-in). Avoid mirroring every Claude flag.

## Model/effort resolution rules

1. `--model openai/gpt-6.1-sol#high` is fully specified; reject contradictory `--provider different` or `--effort low` instead of unexpectedly overriding user intent.
2. `--provider openai --model gpt-6.1-sol --effort high` resolves to `openai/gpt-6.1-sol#high` for the OpenCode catalog/selection layer.
3. `--model gpt-6.1-sol --effort high` without provider may resolve if exactly one connected catalog match; otherwise error with providers listed.
4. `--provider openai` alone selects that provider's applicable configured default only if resolvable, else asks in interactive picker; in noninteractive mode return error.
5. If model lacks variant `high`, **fail with available variants**—no silent fallback to default effort.
6. Use OpenCode model config/ref from generated SDK types; do not string-concatenate and send a guessed request shape. [OpenCode model variant docs](https://opencode.ai/docs/models/).

## Startup transaction (and crash safety)

```
parse args → read frontend config → locate project → Service.ensure/remote connect
  → server.info + catalogs → validate selected agent/model/variant
  → create OR resolve session → switch agent/model if necessary
  → submit prompt (if any) → attach UI → stream canonical state
```

If validation fails, do not create an empty session. If session creation succeeds but prompt admission fails, report session ID and retry option without silently duplicating. If network timeout occurs after a submit, query server inbox/messages before retry; **never blindly resend**. Distinguish `--resume` and `--continue` conflicts. If `--continue` with positional prompt, send it as a new turn in existing session; this must be explicit in help.

## Exit codes (proposal)

`0` successful ordinary UI exit or print run; `1` agent run failed; `2` args/config validation; `3` service unavailable; `4` credentials/authorization; `5` model/provider/agent unavailable; `6` session not found; `130` SIGINT for print jobs interrupted by caller. Interactive Ctrl+C uses safe confirmation before exit; process SIGTERM must restore terminal and avoid cancelling backend session.

## Exact stdout/stderr rules

Interactive mode takes terminal screen; warnings/errors appear in appropriate overlay or stderr only before renderer starts. Noninteractive text uses stdout for final answer, stderr for diagnostics, nonzero exit on failure, NDJSON for `--json`. Never print auth credentials, private reasoning, full environment variables or hidden chain-of-thought. Print mode attaches to existing backend runtime instead of launching its own model execution. The CLI is **not** a thin `opencode run` wrapper: it uses the same client adapter as the TUI.

## Path rules

Expand `~` only deliberately; resolve `--cwd` before network calls. Preserve drive case in display; normalize for equality. Detect a Git root for display/grouping but **do not silently change the execution cwd** to the root if user started within a subdirectory. Offer `--cwd` as the authoritative override.

## CLI acceptance matrix

- Quoted prompt with punctuation/newlines intact.
- No prompt opens overview, with current project preselected.
- Full model ID + --provider mismatch fails before mutation.
- Unknown effort lists supported variants.
- Multiple providers with same model ID prompts or errors deterministically.
- `--resume ses_id` stays on same backend session; avoids fresh session.
- `--continue "prompt"` appends once and remains interactive.
- `--print` is noninteractive and leaves no renderer terminal artifacts.
- Windows PowerShell, cmd.exe, bash/zsh quoting documented and tested.
