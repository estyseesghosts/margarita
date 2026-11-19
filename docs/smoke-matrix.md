# Manual smoke matrix (issue #104)

Covers behavior that cannot be reliably synthesized in GitHub Actions: real terminal key
decoding, host-specific modifier handling, narrow viewports, and live async races against a
running OpenCode service. Run these on multiple independent terminals (Windows Terminal,
Ghostty, tmux, a Unix PTY) and on Windows + Unix. No change is judged complete solely from
CI snapshots.

Each case lists the trigger, what to observe, and where it is (or is not) covered by the
automated suite. Mark `skipped-hosts` clearly when a case needs a terminal CI does not have.

## Cross-server identity (regression for #82–#86)

| # | Trigger | Observe | Automated coverage |
|---|---------|---------|-------------------|
| M1 | Pair two hosts that both reuse a session ID (e.g. `ses_same` on local and remote). | The overview shows two server-qualified rows; opening either never confuses the hosts. | `test/production-assembly.test.ts`, `src/app/multi-server-events.test.ts` |
| M2 | With both hosts displaying `ses_same`, open the remote row and cancel/steer a queued item. | The cancel/steer reaches only the remote backend; the launch backend is never touched. | `test/production-assembly.test.ts` (issue #104) |
| M3 | Remove the remote server while its session is open. | Subsequent actions fail closed and never fall through to the launch backend; an error notice names the removed host. | `test/production-assembly.test.ts` |
| M4 | Restart with a remote whose credential was deleted. | Startup does not abort; the remote registers unauthorized and stays out of the overview. | `test/production-assembly.test.ts` |

## Running state and missed events (#80, #85)

| # | Trigger | Observe | Automated coverage |
|---|---------|---------|-------------------|
| R1 | A host reports a session running, then later reports the turn finished. | The running badge clears; Enter is treated as a plain prompt, not an implicit queue. | `src/app/multi-server-events.test.ts` (issue #80), `test/production-assembly.test.ts` (issue #104) |
| R2 | Refresh a session snapshot while a registration/refresh epoch is stale. | No snapshot is committed against a superseded host; no duplicate session rows. | `src/app/multi-server-events.test.ts` (issue #85) |

## First session with attachments (#77)

| # | Trigger | Observe | Automated coverage |
|---|---------|---------|-------------------|
| F1 | Start a brand-new remote session, attach an image and a PDF, type a prompt, submit. | The first `prompt` to the remote carries both attachments as `data:` URIs; no empty session is created on the launch host. | `test/production-composition.test.ts` (issue #77) |

## Real terminal key decoding (not reliably synthesizable in CI)

Run these under an actual terminal; where CI has no terminal, report the host as skipped and rely on `src/ui/key-events.test.ts` for the decoder unit coverage.

| # | Trigger | Observe | Automated coverage |
|---|---------|---------|-------------------|
| K1 | Press `Esc` while a session runs (empty and nonempty draft). | The session interrupts exactly once; the draft is preserved; a notice shows the server outcome. | `src/app/controller.test.ts` (issue #90) |
| K2 | Press `Esc Esc` quickly on an empty, idle composer. | Rewind selection is entered; no files are mutated until confirmed. | `src/app/controller.test.ts` (issue #90) |
| K3 | Press `Esc Esc` quickly on a nonempty draft. | The draft is cleared with safe restore; `Ctrl+S` brings it back. | `src/app/controller.test.ts` (issue #90) |
| K4 | With an overlay / permission card / completion open, press `Esc` while a session runs. | The overlay/permission/completion owns the key; the session is NOT interrupted. | `src/app/controller.test.ts` (issue #90) |
| K5 | Windows Terminal legacy `ESC` sequence (no bracketed paste / modern mode). | Decodes to `escape`; no spurious interrupt or insert. | `src/ui/key-events.test.ts` (decoder unit; manual on Windows Terminal) |
| K6 | `Ctrl`/`Alt`/`Shift`+`Enter`, `AltGr`, and bracketed paste. | Modifier chords map to their documented actions; paste preserves insertion order. | `src/ui/key-events.test.ts` (decoder unit; manual on real terminals) |
| K7 | `Alt`+`Left`/`Right` word movement over Unicode grapheme clusters and emoji. | Cursor moves by word, never splitting surrogate pairs or combining sequences. | `src/domain/composer.test.ts`; manual on real terminal |
| K8 | Narrow terminal viewport (e.g. 40 columns). | Queue row, action ID, sticky prompt, tool groups, inline diffs, throbber all render without truncating semantic meaning. | Renderer unit checks; manual snapshot on narrow PTY |

## Async route races (not mockable-only)

| # | Trigger | Observe | Automated coverage |
|---|---------|---------|-------------------|
| A1 | Submit a prompt, switch routes before the response resolves, then switch back. | No cross-host side effects; the prompt lands on the host that owned the session when sent. | `test/production-assembly.test.ts`; `src/app/controller.test.ts` |
| A2 | Reorder out-of-order responses from two servers with identical session IDs. | Each host's transcript/queue/inbox stays under its own server-qualified key. | `src/app/multi-server-events.test.ts` |

## Release gate (CI)

- `bun run verify` must be clean on Windows and Linux (`.github/workflows/verify.yml`).
- The writable integration suite (`bun run test:writable`) is run locally or in a dedicated job with OpenCode v2.3 installed; it is not part of CI.
