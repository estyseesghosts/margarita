# marg03 + marg04: distilled

Two consecutive agent runs against the same goal, in the same repo, each picking up from the previous run's log:

> you are working on margarita. use my github account to check the open issues. fix every open P1 issue. one commit, one issue closed.

| | marg03 | marg04 |
|---|---|---|
| Starting point | reads `marg02.json` (the earlier run had closed #4, #5, #15) | reads `marg03.json`; #9 left uncommitted in the tree |
| Models | `inkling-2-small` (opencode, then via commandcode) | a short `longcat-2.5-free` stint, then `inkling-2-small` via openrouter for most of it |
| Wall time | about 44 min | about 111 min |
| Assistant messages | 568 | 959 |
| Input tokens | 1.33M | 4.2M |
| Outcome | interrupted | interrupted, with one P1 (#20) still open |

Both runs ended as `interrupted`. The user stopped them. Neither finished by itself.

## 1. What was accomplished

Each issue below got a commit with `bun run verify` green and a closing GitHub comment with evidence. Nothing was pushed.

### marg03: 8 issues

| Issue | Commit | What changed |
|---|---|---|
| #6 | `080cc9d` | The selected overview row now stays visible during keyboard navigation. Rows got stable ids and the view calls `scrollChildIntoView` with `nearest` alignment. A 24-row renderer test presses Down 50 times and Up 50 times. |
| #3 | `1bfa3b8` | Local state writes are serialized. There is a per-path in-process save chain and a cross-process lock file with stale-lock recovery. Writes are read-merge-write, so concurrent writers keep each other's project histories. Temp files are unique, renames are atomic, files are `0600`, and corrupt state is moved aside instead of reset. The controller flushes saves on exit. |
| #11 | `2d6b820` | `--continue` now finds the latest session beyond the first 500. `findLatestSessionIn(directory)` pages a directory-scoped `listSessions` query (capped at 50 pages), filters archived and child sessions, and falls back to loaded pages if the server ignores directory filtering. |
| #10 | `bcd1d09` | `--resume <id>` hydrates session metadata for sessions outside the initial pages. A new `ensureSession` fetches and stores the summary, and `sendToSession` calls it before resolving `@file` mentions. |
| #2 | `96cbaa0` | Catalogs are scoped to the selected project directory. They carry a directory key and a generation counter. Stale responses are discarded, a failure clears the catalogs, and consumers refuse a non-fresh catalog instead of silently using another project's. |
| #7 | `4b3627c` | Tool output is retained as a bounded head plus tail with truthful elision labels. The cap is configurable as `transcript.toolOutputChars` (1000–1000000, default 64000). |
| #8 | `0e421cf` | Staged reverts are recovered or cleared safely. The controller reconciles on every summary refresh and on `revert-changed` events, and verifies the stage is still the one the dialog was opened for before acting. `flushRevertOnExit()` clears a pending stage, and overlays dismiss when the stage disappears elsewhere. |

#9 (remote `@file` mentions) was implemented but not committed. The run was interrupted partway through writing its controller tests.

### marg04: 9 issues

| Issue | Commit | What changed |
|---|---|---|
| #9 | `022ada8` | `@file` mentions resolve against the server filesystem on an explicit `--server` connection, using the server's `file.find`. A new pure module `src/domain/server-path.ts` handles posix and Windows path shapes. Unresolved mentions give a warning notice instead of being dropped silently. |
| #22 | `1d295dd` | Server-provided edit diffs are carried through to the transcript. OpenCode 2.3 sends patches as `metadata.files[].patch` (or `metadata.diff` for the patch tool). Margarita only read a `metadata.diff` string, so it dropped real patches and real line numbers. A completed edit with no usable patch now shows an explicit "diff unavailable" state. |
| #30 | `82dc80a` | Up on an empty composer cancels the newest queued follow-up on the server and restores its full text for editing. Cancellation races are handled: not-found or conflict shows "Already delivered", and a session switch or new draft mid-flight parks the text in the stash. `FakeBackend` gained a FIFO inbox model. |
| #31 | `16bb11a` | Frontend-local commands such as `/sessions` and `/interrupt` no longer depend on the server command catalog. Server commands keep the catalog gate. Admission errors give a command-specific notice. |
| #28 | `7387e11` (amended) | The throbber is now a per-turn lifecycle marker anchored to its task. Segments are bounded by idle messages (this covers prompts steered mid-run), and completed segments freeze to "Completed in Xs". |
| #29 | `a912561`, then revised in `3a4b6a5` | Queued follow-ups render directly above the running throbber (FIFO, max 3). After the user shared a screenshot, the style was reworked into a highlighted row with a tree-style hint, `└ Queued · ctrl+enter to steer now`. |
| #26 | `712506c` | Completed diff rows no longer remount on every streamed update. |
| #23 | `274cc81` | Related tool calls fold into stable groups, for example "Ran 11 shell commands, read 3 files, edited 6 files". Failures never fold, and a lone edit keeps its inline diff. |
| #21 | `8df5908` | The local `/goal` and its `/sync` instruction machinery were replaced with the native `opencode.goal` plugin. |
| #32 | `6267a83` | `/compact` is now a local built-in that calls native session compaction (`client.session.compact`). #32 was filed during the runs. |

**Left open at the end of marg04:**
- **#20** (writable integration tests). The run never started it.
- **#1** is a P0, so the agent treated it as out of scope.

## 2. What was learned about the project

### OpenCode server behaviour

- OpenCode 2.3 delivers steered prompts mid-execution inside the same turn. **Idle messages are the true turn boundaries.** The first #28 attempt segmented per user prompt and was wrong. It was rewritten around idle-bounded segments.
- Server commands (`session.command`) run command-plugin effects at admission time with `steer` delivery, not as deferred prompts. That is why #31 split local controls from server commands.
- Native compaction is `POST /api/session/{id}/compact`. It is accepted, not complete. Repeated requests merge at the next safe point, and it works regardless of `compaction.auto`. No `/summarize` alias exists in the pinned version.
- There is no `revert.get` RPC. Staged revert state is only readable through `getSession().revert`, so reconciliation has to ride on summary refreshes plus events.
- The server has a `file.find` API and a shell-output cursor RPC (`shell.output`). The latter was noted but not wired for #7.
- Edit and write patches arrive as `metadata.files[].patch`. The patch tool uses `metadata.diff`.

### Frontend and tooling gotchas

- **Solid's `createStore` merges objects at a path instead of replacing them.** A key missing from the new value stays in the store. This hid the #8 bug (stale `revert` never cleared). Using `reconcile()` fixed it; `produce` and `delete` hit TS2704/TS2540 on readonly types.
- **Identity-keyed `<For>` remounts every row** when `foldTranscript` returns fresh node objects each tick. The #26 fix was `<Index>` plus getter-based props and `===`-equal content strings, so the native diff and markdown renderables never re-parse.
- **OpenTUI test input quirks:**
  - `pressKey` takes `meta` for Alt, not `alt`. `alt: true` was silently ignored and sent a plain Enter.
  - Key names are uppercase `RETURN`. `'return'` was emitted as the literal string `\x1Breturn`.
  - Ctrl+Enter only decodes under the kitty keyboard protocol. Production enables it (`useKittyKeyboard`) but the test renderer must too.
  - `composer.steer` is bound to alt+enter by default and is consumed by the action router before a raw `alt+return` branch can run.
- **`cellsUpdated` is not a usable remount probe.** It read 0 in both the `<For>` and `<Index>` cases. The working probe compares frame bytes of the visible diff rows across an unrelated append, ignoring the trailing scrollbar glyph.
- **Ordering matters in the controller.** Catalogs load at attach, so tests must seed `serverCommands` before `attach()`. Local commands clear the composer before running, so a usage error does not preserve the draft.
- **Windows path normalisation lowercases by design** for case-insensitive comparison. `joinServerPath` initially normalised directory and relative parts separately, so `..` could not pop directory segments and the drive or UNC root was doubled. The new unit tests caught both.
- **`bun test` reported line numbers that did not match the file** (about 100 lines off). The agent suspected a stale cache, then Unicode line separators, then `bunfig`, and finally treated it as a display-offset quirk. It was never root-caused.

### Process and shell constraints

- This is Windows with PowerShell. The tool's shell scanner rejects heredocs, apostrophes and em-dashes in `--comment`, and PowerShell does not honor `\"` inside double-quoted strings. The workaround was to write commit messages and comments to scratch files and use `git commit -F` and `gh --body-file`. Plain `-m` strings worked for commits that avoided problem characters.
- `bun run verify` is the gate: `format:check`, `oxlint --deny-warnings`, `bun check` typecheck, then `bun test`. Test count grew from 219 at the start of marg02 to 347 at the end of marg04.
- The untracked `docs/marg*`, `docs/22-prompt-header.md`, `docs/23-tools.md` and `docs/github-issue-29.png` were deliberately never staged.

## 3. What went well

- **The handoff chain worked.** Each run began by reading the previous log (`marg02`, then `marg03`) plus git and `gh` state, and correctly identified what was done and what was in flight. The marg04 agent found the half-written #9 work in the tree and finished it.
- **Verification discipline held.** Every commit followed a green `verify`, and every issue closed with an evidence comment.
- **Tests caught real bugs before commit.** Examples: the `joinServerPath` bugs, the Solid store merge bug in #8, and a #26 test that passed even with `<For>` restored. The agent checked that last one and replaced the probe with a discriminating one.
- **Design choices were reasoned and recorded.**
  - #7 chose head+tail retention with truthful labels over wiring on-demand retrieval, because the issue allowed either.
  - #2 kept the catalog flat but bound it to a directory key.
  - #21 kept `/criteria` working through a top-level sidecar field after the local goal was removed.
  - It also consulted the OpenCode upstream plugin source to match semantics.
- **Scope was respected.** #1 (P0) was left alone. Session dumps stayed untracked. Nothing was pushed. No live server tests were run.
- **User corrections were absorbed cleanly.**
  - "One commit may close overlapping issues" was applied from then on.
  - "Finish and commit #23 first, then revise #29 to the screenshot" was done in that order.
  - The "alt+enter is also acceptable" addendum was handled, since alt+enter already worked.
- **Honest self-correction in some places.** Examples: the agent noticed its first #28 segmentation was wrong and rewrote it, and it posted a follow-up comment when #21 was closed with a `<sha>` placeholder.

## 4. What went poorly, why, and how it was resolved

1. **The #10/#11 commit split burned a large part of marg03.**
   - The agent had implemented both together, then tried to commit them separately. This took about 70 messages of reset, stash, scratch copies, a stash pop conflict, and a half-removed `ensureSession` that broke `main.ts`.
   - The user interrupted and relaxed the rule ("one single commit, as long as the issues get closed").
   - The agent still managed two commits in the end, by restoring the combined files from `.git/*.combined` backups.
   - **Lesson:** investigate and commit overlapping issues in order, or stage hunks deliberately up front. Do not untangle a combined tree afterwards.

2. **Shell quoting kept failing.**
   - The first #6 commit failed because the message contained quotes that PowerShell turned into pathspecs.
   - The closing comment for #21 went out with a literal `<sha>` placeholder and needed a second comment.
   - #32's close failed once on `\"`.
   - **Resolution:** scratch message files, `--body-file`, and the Edit tool instead of scripted replacements. One scripted replace mangled UTF-8 glyphs (`Add-Content`) and another made a mess of a test block.
   - **Cost:** repeated retries, and a small tooling workaround added to the compaction summary.

3. **A false-failure rabbit hole in #29, about 45 messages.**
   - Tests failed with confusing line numbers. The agent chased a stale cache, symlinks, Unicode separators and `bunfig` before finding the real causes: the wrong `pressKey` option name (`alt` vs `meta`), a lowercase key name, and a wrong `indexOf` anchor that matched the welcome box.
   - **Resolution:** debug dumps and a deliberate-syntax-error experiment. The line-number mismatch itself was never explained.
   - **Lesson:** check the test harness API before suspecting infrastructure.

4. **The goal-continuation loop produced boilerplate and flailing.**
   - Hundreds of marg04 messages begin "Continuing #N", "The objective stands", "The reminder matches the active objective". For example, #9 in marg03 (messages 498–581) and #21 and #32 in marg04 are strings of near-identical turns that each do a single read or edit.
   - The pattern coincides with repeated compactions. marg03 compacted three times, with a "Continue working toward the active goal" nudge after each interruption. marg04 compacted at least four times.
   - It looks like the model re-orienting after each context reset and each synthetic nudge.
   - **Effect:** wasted tokens and a lot of re-reading of the same files.
   - **Not resolved.** It is a harness and model behaviour, not something the repo fixes.

5. **Unclear progress.**
   - At one point the user had to ask "which issue are you on right now? what have you fixed so far?"
   - The agent could answer only because the summary was fresh. It does not narrate state on its own.

6. **Flaky environment and model instability.**
   - marg03 ran on two providers, and marg04 on three models, including a one-message `ernie-5.5-flash-preview` turn and a `longcat-2.5-free` stint before settling.
   - marg04 hit a provider error ("Network connection lost", 502) at message 937 during #32, then continued after a retry.
   - The agent could not control any of this.

7. **Interrupts and slow serial verifies.**
   - marg04 was interrupted many times (messages 55–67, 70, 483). The harness logged "User requested that active blocking work be moved to the background" while `bun run verify` ran.
   - Verify is slow enough that the agent read the next issue while waiting. That was productive but meant context juggling.

8. **Late tests or checks sometimes broke assumptions.**
   - #23's grouping change broke six focus-navigation tests (fixtures now folded differently). The agent resolved it by splitting runs into inspect and edit segments at flush time.
   - #32 broke four server-command tests that used `compact` as the exemplar, so they were renamed to `deploy`.
   - #21 hit three test failures from catalog seeding order and an untrimmed criterion.
   - These were all caught by verify before commit, so the damage was only time.

## 5. Where it stands

- **Local branch:** `master` with about 20 commits ahead of origin, including the three from marg02 and the two #29 commits.
- **Open P1:** #20 (writable OpenCode integration tests for prompt, queue, permissions and reconnect semantics). It is the biggest remaining item and the only one that needs a real server. AGENTS.md makes live tests opt-in (`MARGARITA_LIVE=1`), so the next run needs an explicit decision on how to write them.
- **Open P0:** #1 (print mode must wait for the admitted turn, not just session inactivity). It was ruled out of scope by "P1".
- **Untracked, intentionally:** the `docs/` dumps and screenshot.
