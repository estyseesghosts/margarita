# Release readiness checklist

## Product

- [ ] No conversation header, tab strip, persistent sidebar or terminal multiplexer.
- [ ] Minimal session transcript, composer and token/spend footer.
- [ ] Shift+Tab cycles current OpenCode agents, default `build`; no permission-mode substitution.
- [ ] No multi-step `Ctrl+X` letter chords in default or examples.
- [ ] Left on genuinely empty session composer → overview; ordinary editing never misroutes.
- [ ] Overview grouped by canonical project folder, newest first, accurate status and new-session composer.
- [ ] Attaching/detaching never stops running session; switch between multiple live sessions.
- [ ] `unnamed --provider ... --model ... --effort ... "prompt"` creates and opens interactive session.
- [ ] `--print` explicit only; `--continue` and `--resume` cannot accidentally create duplicates.
- [ ] Default tool grouping hides routine noise but exposes errors.
- [ ] Ctrl+O expands exact tool and reasoning text when available; no fake hidden thought traces.
- [ ] Goals, plans and task states persistent; model sync explicit and honestly labeled.

## Engineering

- [ ] API version pinned, generated SDK types compiled and contract probe passed.
- [ ] Service discover/start works on Bun and Windows without TUI owning agent execution.
- [ ] Live-only SSE reconnect resync works; no phantom messages or double prompts.
- [ ] Queue vs steer and multiple-client permission races tested.
- [ ] Model variant validated per provider/model catalog; no silent effort downgrade.
- [ ] Footer cost USD and token categories match server, no fake context percentage.
- [ ] Local sidecar writes atomic/versioned and no plaintext credentials exported.
- [ ] Output ANSI control sequences sanitized; terminal restored on fatal exit.
- [ ] Transcript virtualization handles stress fixtures; keystrokes stay responsive.
- [ ] Windows Terminal, Ghostty, tmux manual smoke pass.
- [ ] All source claims linked to pinned v2.3.0 docs/source; `--help` current.
