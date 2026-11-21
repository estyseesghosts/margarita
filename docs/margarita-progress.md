# Margarita: progress report, lessons and implementer guide

Written 2026-11-21 from the 15 chat transcripts in `marg-chat-transcripts/` (Claude Code TUI dumps, OpenCode session JSON exports, one Codex markdown export), plus a look at the repository itself (`git log`, `package.json`, `src/`, `docs/`).

A note on evidence. Most of what follows comes from the agents' own words: their summaries, the compaction summaries, and the retrospectives you repeatedly asked them for ("what have you accomplished, what has gone well, what has gone poorly and why"). I cross-checked commit hashes and issue numbers where several transcripts overlap, and I checked the repo state directly. I did not re-run the test suite for this document. Where an agent said it had *not* verified something in a real terminal, I say so too. Treat numbers like "927 tests pass" as "what the agent reported at that time".

---

## 1. What margarita is

**margarita** (binary name `marg`, package name `margarita`) is a terminal frontend for the **OpenCode v2 server** (pinned to `@opencode/client` 2.3.0). The pitch in the README is that it makes OpenCode feel like Claude Code or Codex: a single inline conversation view with a pinned prompt, folded tool calls, a sticky prompt header, a throbber, a one-line footer, and an overview of sessions grouped by project.

It is a client only. It never owns the OpenCode server, and that rule is written into `margarita/AGENTS.md`:

> Never start, stop, or reconfigure the user's OpenCode service or touch OpenCode's own config/storage. Margarita only connects to an existing service. Live tests are opt-in.

The stack is Bun 1.4.4 (pinned by `.bun-version`), strict TypeScript, SolidJS (1.9.12) rendered through OpenTUI (`@opentui/core` and `@opentui/solid` 0.9.2). Lint is `oxlint` with type-aware rules and `--deny-warnings`. The project ships as a single self-contained executable (`bun run build` produces `dist/marg.exe`, about 126 to 130 MB because it embeds the Bun runtime and OpenTUI's native library), and it is also runnable from source with `bun run start`.

It is **new**. The first commit (`f75a975`, "Scaffold Bun workspace…") landed on 2026-11-18. By 2026-11-21 the repository has about 180 commits, roughly 78 test files, a 6,300-line `src/app/controller.ts`, 30 spec documents in `docs/`, and issue numbers up to #176 on GitHub (`estyseesghosts/margarita`, public). In three and a half days the project went from an empty folder with a spec to a feature-rich client with multi-server support, a writable integration suite, and a CI workflow.

---

## 2. How the work actually happened

The work was done by a rotating cast of agents, none of which remembered the previous one. Continuity came from three things: the spec docs in `docs/`, the git history, and **transcript handoffs**, where you told each new agent to "read marg0X to see where we left off".

| Phase | Transcript(s) | Agent / model | What happened |
| --- | --- | --- | --- |
| 0. Bootstrap | `marg00.txt` | Claude Code, Opus 5.5 | Read the spec docs, scaffolded the repo, built milestones 0 to 5 (domain layer, adapter, controller, UI, print mode, forms, diffs, perf suite, goals and plans, Ctrl+B, `/export`, themes, packaging ADR). Ended at 164 passing tests, with live-gated checks still pending. |
| 1. Polish and publish | `marg01.txt` | Claude Code, Sonnet 5.5 | Built the docs/22 sticky prompt header and docs/23 markdown and diff rendering that the last agent had only listed as "next". Fixed tool grouping against your screenshots. Rewrote the README, set version 0.0.1, created the public GitHub repo and pushed. Fixed the squished welcome cat. |
| 2. P1 issue sweep | `marg02.json`, `marg03.json`, `marg04.json` (`marg05.md` is a distillation of the last two) | OpenCode goal mode, mostly free models (`hy4-flash-free`, `inkling-2-small`, `longcat-2.5-free`) | Closed #4, #5, #15, then 8 issues, then 9 more, working from a `/goal` of "fix every open P1, one commit one closed issue". All three runs ended `interrupted` by you. |
| 3. Remaining issues, writable suite | `marg06.txt` | Claude Code, Sonnet 5.5 | Closed #1 (print mode waits for its own turn) and #20 (writable integration suite against a disposable OpenCode). Closed #33 to #38 and more until the usage limit hit. Added CI. |
| 4. Remote servers epic | `session-dff1e8a6…json` | OpenCode, DeepSeek-class model | Closed #42, #43, #45, then the whole multi-server epic #47 to #59. Later reopened #53/#54/#55/#56 because they were closed prematurely, redid them, and rewrote local history so each issue has its own commit. |
| 5. Multi-host hardening | `session-0dd4d9bd…json`, `session-99816c0f…json`, `session-54c0f9ed…json` | OpenCode, several free models (DeepSeek, Nemotron and others) | Fixed identity and routing bugs that the multi-server epic introduced: #74 to #79, #82 to #87, #90, #104, #113. |
| 6. Codex and the long batch run | `codex-session-01a1fab1…md`, `session-6737d5d0…json` | Codex (cut off by rate limits), then OpenCode | Codex started with the #116 model-switch race and delegated independent P2 fixes to subagents, then ran out of budget. The OpenCode agent that picked it up closed ~30 issues in ~12 commits. |
| 7. Token-budget mode | `session-f2932d08…json`, `session-fe467b86…json` | OpenCode | Explicitly asked to batch related issues because of token limits. Closed 27 of 32 issues in 12 commits, then the last 7 in 5 commits, ending with the issue tracker empty. |
| 8. After the transcripts | repo `git log` | n/a | `c7fd215` closed #169 to #176 in one commit (cross-server requests, exports, mentions, state locking). The tree currently has uncommitted work on `src/main.ts`, `scripts/build.ts`, a new `src/build-version.ts` and deletions of `docs/marg0*.txt/json`. |

The transcripts give a clear arc. Early on the work was feature building against a spec. After the public release you moved to a **file an issue, an agent fixes it, the issue closes** loop, and later issues increasingly came from you (and from review passes) catching regressions of earlier fixes. The center of gravity moved from "build the client" to "make the client correct when more than one server, session and async operation is in flight at once".

---

## 3. What we built

### 3.1 Architecture

Layering is deliberate and was cited by several agents as the thing that made fixes cheap:

- `src/domain/` is **pure and deterministic**. No UI imports, no SDK imports. Transcript folding (`transcript.ts`), the composer buffer (`composer.ts`, grapheme-aware), keymap (`keymap.ts`), footer formatting, throbber, execution markers, goal/plan model, usage analytics, rewind, model sorting, mention parsing (`file-reference.ts`), pairing, server identity and path identity. Nearly every behaviour has a unit test here first.
- `src/adapter/` maps the OpenCode wire format to domain types (`wire-mapping.ts`), implements the `Backend` interface (`backend.ts`), supervises the event stream with bounded buffer, batching, capped backoff with jitter and overflow-to-resync (`event-pump.ts`), and manages multiple servers (`server-manager.ts`, `connection.ts`, `pairing.ts`).
- `src/app/` holds `AppController` (`controller.ts`), the single owner of frontend state, `app-state.ts`, the key router, the production assembly (`production-assembly.ts`) that `main.ts` uses, and remote connection logic.
- `src/ui/` is SolidJS over OpenTUI: transcript view, composer view, overview view, overlays, throbber, queued-message preview, theme and syntax colours.
- `src/config/` is persistence: config (JSONC, validated), local state, goal sidecar store, server profiles, credentials (DPAPI on Windows, Keychain, Secret Service), file locks, schema guards, unpair recovery.
- `src/cli/` is the argument parser, target resolution and print mode.
- `test/` holds the fake backend (`fake-backend.ts`), acceptance, perf, production-composition, recorded fixtures (`test/fixtures/opencode-2.3.0/`), the opt-in writable suite (`test/writable/`) and opt-in live smoke tests.

### 3.2 Feature inventory

Core client:
- Starts in a **new session in the current directory** by default. Nothing is created server-side until the first prompt, so launching and quitting leaves no empty sessions.
- Overview of sessions grouped by project, sorted by most recent use, six per project with inline `[Show more]` / `[Show less]`, five filter tabs, status dots, deterministic project colours, remote markers.
- Conversation view: inline welcome panel (the ASCII cat is fixed at 7 columns and never squished; right-hand hints are dropped when narrow), folded tool calls ("Ran 11 shell commands, read 3 files, edited 6 files"; failures never fold), markdown rendering, diffs with line numbers and syntax colours, a sticky header that pins the prompt you are currently reading, queued follow-ups shown above the throbber, a per-turn throbber anchored to its task, Ctrl+O full-detail output, paging and windowing for long histories (10k-message performance suite).
- Composer: grapheme-safe editing, history search (Ctrl+R), stash (Ctrl+S), undo/redo, kill buffer (Ctrl+Y yank), forward-word delete, `$EDITOR` handoff (Ctrl+G), `@file`, `@directory` and `@agent` mentions with `#start-end` line ranges, image and PDF paste as inline `data:` attachments, a painted blinking caret.
- Controls: Shift+Tab agent cycle, an agent picker, a model picker and a separate effort/variant picker (Alt+E, `/effort`), steering (Ctrl+Enter, Alt+Enter, F6), Ctrl+B to background tools, Esc interrupt and Esc-Esc rewind, `/rewind`, `/fork`, `/revert`, `/rename`, `/compact` (native server compaction), `/export` (full chat as JSON), `/goal`, `/criteria`, `/plan`, `/sync` (goal sync was later replaced with the native `opencode.goal` plugin), `/btw` (truthfully reports that side questions are unsupported).
- Permission cards, form questions, subagent worker tracking, usage and context analytics.
- Print mode (`marg -p`) with `--json`, documented exit codes, and a design that follows the turn it admitted rather than waiting for "session idle".
- Themes: dark, light, high-contrast, plain (NO_COLOR), each contrast-tested.

Multi-server (the "remote epic", #47 to #59):
- Server-qualified identity (`SessionRef {serverID, sessionID}` and `sessionKey()`), a connection manager with isolated backends and one event stream per server, persistent server profiles with OS credential storage, `/pair`, `/servers`, `/unpair` (with a durable cleanup queue), `--remote`, `--local`, a unified overview with remote markers and offline caching, per-server pagination, and per-server catalog scoping.

Engineering infrastructure:
- `bun run verify` (format check, oxlint, typecheck, tests) as the gate; GitHub Actions workflow running verify on Windows and Linux.
- `bun run test:writable`: a **disposable** OpenCode server started by the suite on a free port, with all four XDG roots under a temp directory and a mock OpenAI-compatible model in-process. It never touches your real service. This suite found three bugs the fake backend hid (see 5.7).
- `bun run capture:fixtures` records sanitized raw SDK responses, which `src/adapter/fixtures.test.ts` maps through the real wire mappers on every `bun test`.
- An opt-in compatibility harness for OpenCode v2.3.1 and v2.3.2 (#148), `docs/smoke-matrix.md` for what CI cannot cover, and a release checklist.

---

## 4. What has gone well

1. **The layered, pure-domain design paid for itself repeatedly.** When agents asked "where does this fix belong", the layering answered. #74 and #75 (MCP call visibility, current-action line) were almost entirely domain changes plus thin view wiring. Identity bugs (#77, #78, #79) were controller-ordering problems with an untouched domain layer. This is also why free, weaker models could land correct fixes: the pure functions are small and testable in isolation.

2. **The test suite asserts behaviour, not mock calls.** The UI tests mount the real `App` through OpenTUI's `testRender` and assert on captured character frames. `FakeBackend` is a full in-memory backend with injectable failure hooks. That let agents prove "the footer shows `1 queued` for A and `2 queued` for B" as rendered output. The suite grew from 45 tests (milestone 0) to about 930 and held at 0 failures at every reported commit gate.

3. **Mutation checking became a house convention.** In the #77 to #79 session the agent deliberately broke each fix, confirmed named assertions failed, and reverted, then recorded that in the commit body. For example, dropping the group's `live` field failed four assertions; restoring the launch-server lookup failed both catalog tests. A related habit, a *source-scanning test* (`src/ui/view-keys.test.ts`) that fails if UI code looks things up by bare `session.id`, guards a whole bug class instead of one instance.

4. **Handoff chains worked.** Each run started by reading the previous transcript plus `git log` and `gh issue list`, and correctly identified what was done and what was in flight. Several agents found half-finished work in the tree (#9 in marg04, the #83/#82 diff, the #133/#134/#138 batch) and finished it instead of redoing it.

5. **Verification discipline.** The standard flow settled to: implement, full `bun run verify`, commit, push, `gh issue close` with an evidence comment, confirm `CLOSED`. Agents that were told "do not wait for the background verify" correctly refused to claim success until the notification arrived (the #86 verify later turned out to have two failures, which proved the point).

6. **Real-server testing found real bugs.** The writable suite caught that `message.list` rejects `order` together with `cursor` (older-page paging was broken against a real server), that OpenCode emits **one idle marker per run, not per turn** (which would have made print mode print the wrong reply when a follow-up was queued), and that a declined permission ends a run with no idle marker at all.

7. **Research-first honesty.** For #100 (`/btw`) the agent searched the entire pinned SDK for side-question support, found none, wrote `docs/24-side-questions.md` recording the evidence, and shipped a command that truthfully says it is unsupported. For #133/#134/#138 it confirmed from generated SDK types that `AgentInfo` has no provenance field and documented that upstream limitation instead of inventing one.

8. **Root-causing instead of symptom-patching.** #77 was an ordering bug (`clearComposer()` then `openSession()` restored the fresh session's empty draft, so the later attachment read was empty by construction). The fix was an immutable *submission envelope* captured before any route change. #79 turned up a second latent cause the issue did not mention (`openOverview()` silently retargeted the composer to whichever host sorted first). #125 discovered that OpenCode mints `cursor.next` for every non-empty page, so it is a navigation hint and not proof that older history exists.

9. **User corrections were absorbed cleanly.** "One commit may close overlapping issues", "finish #23 first, then redo #29 to the screenshot", "alt+enter is also acceptable", and "your new cursor introduced a bug" were each applied in order without drama.

10. **Shared modules replaced copy-paste.** Three persistence modules had separate lockfile logic with a fixed 10 s stale threshold. `file-lock.ts`, `schema-guard.ts` and `unpair-recovery.ts` unified them, and each became independently testable with injected clocks and liveness checks.

11. **Deterministic async tests via injection and gates.** Instead of sleeps, tests inject `isAlive`, `now`, credential runners, backends and *gates* (promises the test releases) so races such as "createSession resolves after the user navigated away" are reproducible.

---

## 5. What has gone poorly, why, and how it was fixed

These are grouped by theme, and each notes what it cost. The point is to recognise the patterns early.

### 5.1 Identity and async races: the single biggest source of bugs

**What happened.** Most issues after #47 are the same bug in different clothes: some code path used a bare `session.id`, the launch server, or "whatever route is current *now*" where it needed the owning host or the route as it was *when the action started*.

- #78 footer, queue and keys keyed by bare session ID across hosts.
- #79 overview catalog actions resolved against the launch server.
- #84 a `--remote` Linux host treated as win32 because the frontend OS was used for path semantics (so `/srv/App` and `/srv/app` merged).
- #85 refresh epochs not rechecked after an `await`, so old responses clobbered new ones.
- #86 queued and goal RPCs not capturing immutable server/session identity.
- #87 delayed paste landing in a different route; #113 `createSession` resolving late and stealing focus.
- #149 and #152 `--resume` and `--continue` discarding the owning `serverID`.
- #160 history repainting another project's visible transcript after a late admission.

**Why.** Single-server code was written first and then multi-server support was layered on. The key space (`sessionKey`) was fixed in #47, but every call site written before that, and many written after by agents who did not know the rule, still used bare IDs. `AppController` is a 6,300-line hub that distinguishes `serverID` (launch host) from `activeServerID()` (route host), and mixing them up was a recurring hazard.

**How it was fixed.**
- One `currentView()` selector instead of patching six call sites (#78).
- Capture `SessionRef` and route key **synchronously, before the first await**, then compare after each await (#86, #87, #113).
- Epochs are bumped monotonically and **never deleted**: deleting a counter lets it restart at a previously used value, defeating the stale-response guard (#140, #147).
- `backendFor(serverID)` is fail-closed: an unknown host throws, never falls back to the launch backend.
- The source-scanning guard test (above), and `test/production-assembly.test.ts` which exercises the real composition with colliding session IDs across two fake hosts (#72, #104).

### 5.2 Premature closes and regressions of closed issues

- The multi-server epic #47 to #59 was closed first. Then #53/#54/#55 turned out to be only partially implemented (aggregation and per-server catalog scoping were missing, `@file` routing still keyed off a global flag). An agent **reopened four issues**, implemented them properly, and re-closed them. A follow-up, #72 ("Exercise production multi-server composition in CI"), exists precisely because the unit fixtures hid that `main.ts` never wired `backendFor`.
- #81 was itself a regression report against closed #71. One regression test encoded the bug it was meant to prevent: an existing `@file` completion test asserted that `openOverview()` reverts to the launch host, which *was* #79's defect.
- #93 (distinct Ctrl+W boundary) was "done" in the domain with a passing unit test, but `key-router.ts` still routed both Ctrl+W and Ctrl+Backspace to `deleteWordBackward`.

**Lesson.** A closed issue is not proof of acceptance, and a green unit test does not prove a user-facing key binding works. Check call sites with grep, test at the controller/renderer boundary, and read acceptance criteria literally.

### 5.3 Git hygiene versus the "one commit, one issue" rule

- In marg03 the agent implemented #10 and #11 together and then tried to commit them separately. This burned roughly 70 messages of reset, stash, scratch copies, a stash-pop conflict and a half-removed `ensureSession` that broke `main.ts`. You interrupted and relaxed the rule ("one single commit, as long as the issues get closed").
- Later agents correctly batched, but then the opposite problem appeared: `54b5039` closed #53, #54 and #55 in one commit, and the earlier rule was still "one commit per issue". The agent asked before rewriting history, you answered, and local `master` was rewritten into `7d68409`, `09719d0`, `3ea2b2b`, `8d75da8` with a proof that the final tree was byte-identical (`git diff --stat final-split -- .` empty).
- GitHub only auto-closes on a literal `Fixes #N` (or `fixes #N`). One batch commit used `#91:` bullets and ten issues stayed open until they were closed by hand.
- An agent found local `master`, the staged index and `origin/master` at three different states. It proved the staged diff was byte-identical to the upstream merge (`git diff --no-index`, 279 lines, zero differences) and used `git reset --mixed` instead of guessing.
- A closing GitHub comment went out with a literal `<sha>` placeholder and needed a second comment.

**Lesson.** Decide the commit shape *before* writing code. If two issues overlap in the same functions, say so in the plan and make one commit with `Fixes #A, fixes #B`. Do not untangle a combined tree afterwards. (You have since explicitly allowed batching.)

### 5.4 Shell, quoting and tooling friction on Windows

This was the most reliably repeated time sink, in every agent runner (Claude Code and OpenCode).

- The tool shell scanner rejects heredocs, apostrophes and em-dashes in `--comment`/`-m` strings; PowerShell does not honour `\"` inside double-quoted strings; Git Bash heredocs with backticks and `${}` keep failing; `Get-ChildItem -la` is not a thing (use `-Force`); `> /dev/null` tries to create `C:\dev\null`.
- A scripted replace mangled UTF-8 glyphs (`Add-Content`). Another script's `\n` became a literal newline inside a test string. Two careless line-range splices deleted a function and duplicated a `describe` header.
- A PowerShell `String.Replace` with a literal `` `n `` silently matched nothing, tests passed, and the agent briefly concluded "the test doesn't bite". It caught this by grepping for the line it thought it had removed.

**Resolution that worked.** Write commit messages and issue comments to a scratch file and use `git commit -F file` and `gh issue close N --comment-file`/`--body-file`. Use the Edit tool with unique anchors, never a scripted find/replace. Use Glob and Grep tools instead of shell pipelines. And **verify a mutation or an edit applied before trusting a result**.

### 5.5 Lint, formatter and compiler strictness

None of these are bugs, but each cost one or more full verify cycles the first time it was hit (a verify run is about 35 s; with many agents it was often auto-backgrounded):

- `unicorn(consistent-function-scoping)`: helpers defined inside `describe()` must be hoisted to module scope. Hit in nearly every session.
- `no-shadow`, `no-array-sort`/`no-array-reverse` (use `toSorted()`/`toReversed()`), `no-useless-spread`, `no-control-regex`, `consistent-return` on exhaustive switches, `no-floating-promises` and `await-thenable` on `expect(...).rejects`, `unbound-method` (don't capture `backend.method` directly), `no-unused-vars` (prefix unused params with `_`), and `typescript(no-unsafe-type-assertion)`: not even a cast through `unknown` is allowed; use the existing `isRecord` guard or explicit narrowing.
- `exactOptionalPropertyTypes`: `prop?: string` rejects an explicit `undefined`. Declare `prop?: string | undefined`. One agent's "fix" of a JSX spread `...({})` was invalid syntax.
- `expect(x).toBeDefined()` does not narrow the type. Use `if (x === undefined) throw …`.
- `Route` is a union (`overview | conversation | new`), so `route.serverID` fails typecheck. Tests use `toMatchObject({ kind: 'conversation', serverID })`.
- The first `bun run verify` after editing commonly fails on `bun fmt --check`. Run `bun run format` first.

### 5.6 SolidJS store and OpenTUI semantics

These misled agents several times, and they are not in the style guide:

- **`createStore` merges objects at a path instead of replacing them.** A key missing from the new value stays. This hid #8 (a stale `revert` was never cleared), a stale `olderCursor` surviving the last page, a dropped `variant` surviving a model change, and it caused composer text to leak across controllers because drafts aliased the live composer. Fixes: `reconcile()`, explicit clearing before set, `produce`, and copying (`{ ...current }`) before an optimistic write. Store proxies are live references: restoring an optimistic value by passing back the captured proxy "restores" the *new* value.
- Direct mutation (`state.running['ses_a'] = true`) is silently dropped by the store proxy. In tests, drive state through the public path (`controller.onEvents(serverID, events, resync)`).
- **Identity-keyed `<For>` remounts every row** if `foldTranscript` returns fresh node objects each tick. The #26 fix was `<Index>` with getter-based props and `===`-equal content strings, so the native diff and markdown renderables do not re-parse.
- OpenTUI test input quirks: `pressKey` takes `meta` (not `alt`) for Alt; key names are uppercase (`RETURN`), and `'return'` is emitted as the literal `\x1Breturn`; Ctrl+Enter only decodes under the kitty keyboard protocol, so the test renderer must enable it too; the PageUp key name had no keycode in the mock, so the raw escape sequence is used; `cellsUpdated` is not a usable remount probe (it read 0 for both `<For>` and `<Index>`), and the working probe compares frame bytes of visible diff rows across an unrelated append.
- **The native terminal cursor is the wrong way to draw a caret.** #117 used `renderer.setCursorStyle`/`setCursorPosition`. The renderer repaints and owns the final cursor coordinates, so the next paint invalidated the position, leaving the bar wherever the last draw operation ended. You filed #130 with screenshots. The resolution was to abandon the hardware cursor, paint `▏` inside the composer with a timer-driven blink, add a regression test, and delete the dead `caret-position.ts` helper rather than keep unused code.

### 5.7 Fake backend versus real server

The fake backend is good, but it is only as truthful as its authors' guesses.

- `FakeBackend.switchAgent` only recorded the call and never updated session state, which broke server-confirmed switching tests until it mirrored `switchModel`.
- Real OpenCode behaviours the fake hid (found by the writable suite): `order` + `cursor` rejected together; one idle marker per run; declined permission ends a run with no idle marker; a prompt's inbox item ID equals the ID of the user message it becomes; the event stream is live-only (no replay, so reconnect must re-read canonical state); there is no `revert.get` RPC, so staged revert is only readable via `getSession().revert`; steered prompts arrive mid-turn inside the same turn, so **idle messages are the real turn boundaries** (the first #28 attempt segmented per user prompt and was wrong).
- Edit and write patches arrive as `metadata.files[].patch`, the patch tool uses `metadata.diff`. Marg read only a `metadata.diff` string, so it dropped real patches (#22). Your server also names its shell tool `execute`, which marg did not recognise, so shell calls were never folded until you showed a screenshot.
- The writable suite sometimes cannot delete its temp directory immediately after shutdown on Windows (EPERM). It warns instead of failing.

### 5.8 The goal loop, compactions and flailing

- Hundreds of messages in marg03/04 begin "Continuing #N", "The objective stands", "The reminder matches the active objective". The pattern tracks compactions (marg03 compacted 3 times, marg04 at least 4) and the synthetic "Continue working toward the active goal" nudges. Effect: wasted tokens and repeated re-reading of the same files. It is harness and model behaviour. It is not fixed in the repo.
- You twice had to ask what the agent was working on ("which issue are you on right now?"). The agent answered only because it had just summarised. Agents do not narrate state on their own.
- A single false-failure rabbit hole in #29 took about 45 messages: the agent chased a stale cache, symlinks, Unicode line separators and `bunfig` before finding the real causes: the wrong `pressKey` option name, a lowercase key name, and an `indexOf` anchor that matched the welcome box. The `bun test` line-number mismatch (about 100 lines off) was never explained.
- The model churn was high: free models, an `ernie-5.5-flash-preview` one-message turn, a `longcat-2.5-free` stint, a Codex run cut off by rate limits, and a Claude Code run that paused at "Usage limit reached · continuing automatically at 9:20am". A 502 "Network connection lost" hit mid-#32. Each switch costs a re-orientation.
- Plan mode switched in real time mid-investigation of #101 (your note: "i didn't think it would switch you to plan mode in real time, ill file that as an issue"). No work was lost because nothing had been edited yet.

### 5.9 Things that were closed, shipped or asserted too early

- Several agents reported "committed", "fixed" or "works" while the verification was still in the background or the real UI had not been run. The most important case: the compiled `marg.exe` initially failed when launched from the repo folder because the compiled binary read the repo's `bunfig.toml` (an `@opentui/solid/preload` that is not in the exe). The agent's earlier check ran from a folder with no `bunfig.toml`, so it looked fine. You reported it with a screenshot ("does it work"). The build now tells the exe to ignore `bunfig.toml` and `.env` in the launch folder (`4ed9e1f`), and `src/build-version.ts` (uncommitted) is related work.
- Agents explicitly flagged things they did **not** verify: marg.exe interactive use, syntax colours from tree-sitter (which fails in the test environment and falls back to plain text), mouse-wheel scrolling and streaming for the sticky header, Ctrl+B against a real running tool, Windows Terminal key decoding. You said you would do live behaviour testing yourself. Keep that division of labour honest: say "tested against the fake backend" or "not exercised live" in the issue comment.
- #34 closed without the real-OpenCode integration tests the issue asked for (the disposable service does not load the goal plugin). The agent said so in the close comment. #38's recovery list is in memory only and is lost on client restart; that was also stated.

### 5.10 Repository hygiene

- The session dumps are meant to stay out of the repo (`AGENTS.md` says nothing from `claude-code/` is ever tracked, and agents repeatedly refused to stage `docs/marg*`). However, commit `4385498` ("docs") **did** add `docs/marg00.txt` through `docs/marg05.md`, plus `docs/22-prompt-header.md`, `docs/23-tools.md` and a screenshot. Because the repository is public and history is public, those dumps are in the public history. Current working tree shows them as deleted and uncommitted.
- Twelve commits (`822c7ae` merge of PR #115, `186aa79` and related fail-closed model selection work, README edits and an upload) carry the author name `jules ♡` rather than `terezi`, while the other 168 use `terezi <jules@foxtails.me>`. They share an email. I don't know whether that is intentional, but it contradicts the "always use the default git identity" rule if unintended.
- Two untracked scratch files, `marg06.txt` and `docs/marg06.txt`, were left alone by every agent, which is correct.
- The Claude Code harness attribution reminder and `AGENTS.md` conflict. One agent noticed this and left the `Co-Authored-By` line out. `AGENTS.md` wins. See section 7.

---

## 6. Recurring bug classes: a checklist

When a new issue arrives, ask whether it is one of these before you start.

1. **Bare-ID lookup.** Any `state.x[session.id]`, `state.x[sessionID]`, `activeServerID()` used where the *owning* host of that object is needed, or `deps.serverID` used for something that is route-scoped. Use `keyFor(serverID, sessionID)`/`sessionKey()`.
2. **Await gap.** Code that captures state before an `await` and uses current state after it, or the reverse. Capture an immutable origin (`SessionRef`, route key, epoch, catalog generation) synchronously and compare after.
3. **Last-write-wins on responses.** Anything that replaces a collection from a network response needs an epoch/generation guard, a registered-host check and a failure path that does *not* treat failure as an empty list (#80, #85, #140).
4. **Merge-instead-of-replace in the Solid store.** If a field can become absent, use `reconcile` or explicitly clear it.
5. **A cursor or marker taken as proof.** `cursor.next` is not proof of more history (#125). A single idle marker is not a turn boundary (#28, #1).
6. **A shared "global" flag where per-server data is needed.** `remoteFilesystem`, global model catalog, global compaction boundary, a single in-flight-admission bit (#54, #143, #163).
7. **Unicode and widths.** Cursor positions must be grapheme boundaries; display cells are not UTF-16 length; text should pass `isWellFormed()`. Use the existing grapheme helpers.
8. **Silent drops.** Things that silently disappear on conflict (a cancelled queued message with a busy composer, an unresolved mention, an oversized paste, an unsupported side-question) should give a visible notice and a recovery path, never nothing.
9. **Closed does not mean accepted.** If an issue touches code that another closed issue also touches, read that issue's acceptance criteria and look for tests that pin the old behaviour.

---

## 7. Advice for future agent implementers

### 7.1 Do

**Orient before editing.**
- Read `margarita/AGENTS.md`, `../typescript-style-guide.md`, the relevant `docs/NN-*.md`, `git log --oneline -30`, `git status`, and the open issues. Read the whole issue list before you pick anything, and re-read it after a while; the tracker is live and new issues arrive during a run (several appeared mid-session). Issues use title prefixes `[P0]`, `[P1]`, `[P2]`, `[P3]` and have **no labels** (the JSON has `labels: []`), so `gh issue list --label P1` returns nothing. Filter by title.
- Use `gh` yourself. It is authenticated as the owner's account against `estyseesghosts/margarita`. You were told twice: "i shouldn't have to copy and paste issues from the browser". If a long `gh` command trips the scanner, run one `gh issue view N` at a time.
- If you are handed a transcript, parse it rather than reading it raw: they are 1 to 8 MB. User messages, goal text, compaction summaries and assistant prose are the useful parts; tool calls are noise. (This document's own extraction did exactly that.)

**Work the way the best runs did.**
1. Pick a priority order (P0, then P1, then P2) unless told otherwise. Batch issues that touch the same functions into one investigation, one gate and one commit. This was explicitly sanctioned and saved a lot of tokens.
2. Read the issue's "Implement" and "Done when" sections, then write tests from the acceptance criteria, not from your implementation. In #74, the spec required first-appearance ordering and the test caught the agent's wrong bucketing.
3. Fix the domain layer first when it is pure. Add controller and UI work only where the behaviour is observable.
4. Mutation-check non-trivial fixes: break the fix, confirm the right tests fail, restore. Confirm the mutation actually applied.
5. Run the **whole gate** after each logical change: `bun run format`, then `bun run verify`. It stops at the first failing stage.
6. Commit with `git commit -F <file>`; include `Fixes #N` (or `fixes #A, fixes #B`) so GitHub auto-closes. Verify the issue shows `CLOSED` with `gh issue view`. Add a closing comment with evidence: what changed, test names, what was *not* verified (live OpenCode, real terminal).
7. Push only when it is in scope for the run. Earlier runs explicitly did not push; later ones pushed each batch. Follow the current instruction.

**Respect the architecture.**
- Keep `src/domain` free of UI and SDK imports.
- Route every server interaction through `backendFor(serverID)`. Fail closed for unknown hosts.
- Key per-session data by `sessionKey`/`keyFor`. Compare directories with `directoryKey(directory, platformFor(serverID))`, where the platform comes from the owning server's metadata and degrades to case-preserving POSIX when unrecorded. Never use the frontend OS for a remote host.
- For anything async that touches state: capture origin first, check after each await, and decide what happens if the user moved (continue in the background, stash the result, or discard with a notice).
- Persist with the existing patterns: per-path save chain plus cross-process lock file with liveness-based stale recovery (`file-lock.ts`), read-merge-write or compare-and-swap, unique temp file plus atomic rename, `0600` permissions, schema-version guard that refuses downgrades, and move corrupt state aside instead of resetting.
- Credentials never go on argv; pass secrets on stdin. Do not strip whitespace from secret bytes.
- Prefer deleting dead code to keeping it (the style guide says so, and agents have been praised for deleting `caret-position.ts`).

**Verify against reality where you can, and say where you could not.**
- Read the pinned SDK's generated types (`@opencode/client` 2.3.0, `promise/generated/types.d.ts`) or the checkout in `opencode/` before guessing a wire shape. It already supports more than marg used (agent attachments, `file.find` with `type: 'directory'`, `session.background`, `session.compact`, `experimental.job.list`).
- Use `test/writable` (`bun run test:writable`) when behaviour depends on real server semantics. It is isolated. Update fixtures with `bun run capture:fixtures` after an SDK or server upgrade and review the diff.
- If a fix is something only a real terminal can show (key decoding in Windows Terminal, kitty protocol, tmux, mouse scroll, tree-sitter highlighting), record it in `docs/smoke-matrix.md` and tell the user plainly that it is untested live.

**Communicate.**
- When asked "what are you on?", answer with the issue number, what is done and what is left. Say whether a verify run is pending and do not report it as green until you have seen output.
- If you reopen, rewrite history or change a rule, say so and explain why before doing it. (The history rewrite was only done after asking.)

### 7.2 Don't

- **Don't start, stop or reconfigure the user's OpenCode service**, read or write OpenCode's own config or storage, or run `opencode models` / `opencode debug config` probes that can start the managed service. Two such commands were blocked in the marg06 run, and the agent correctly did not retry or work around them. Live tests that write must use a disposable service with mock model credentials. If a live prompt is genuinely needed, use a free model (`longcat-2.5` or `inkling`) and a read-only probe where possible.
- **Don't commit session dumps**, `claude-code/` content, `private-gitignore/`, the untracked `marg06.txt` files, or anything from the screenshot folder. `AGENTS.md` at the workspace root: nothing from `claude-code/` is ever tracked, and commits must never mention that folder. Use it privately as a reference only.
- **Don't attribute yourself.** No `Co-Authored-By`, no "Generated with" lines, no agent name in commit messages or PR descriptions. Use the machine's default identity, `terezi <jules@foxtails.me>`. If a harness tells you to add attribution, `AGENTS.md` overrides it. Don't change git config.
- **Don't hide a batched commit.** If one commit closes several issues, say so in the message and the close comments. Never reference (`Fixes #N`) an issue the commit does not actually fix.
- **Don't trust a green test as proof the feature works.** Grep for call sites. Test at the rendered-frame level for UI behaviour.
- **Don't treat failure as empty.** A failed refresh must not wipe rows, active flags or page metadata. A failed lookahead must fail closed.
- **Don't write scripts that rewrite source with find/replace or line-range splices**, especially in PowerShell on Windows. Use the Edit tool.
- **Don't estimate what the server did not report.** Doc 21 says the throbber leaves out per-turn token counts because the server only reports session totals. #141 to #143 later redefined "turn" precisely (one user prompt plus all its assistant steps) so usage numbers would be truthful.
- **Don't fake an unsupported feature.** Say it is unsupported, say why, and say what would change that (`/btw`).
- **Don't loosen a test budget without recording it.** Milestone 4 raised the first-frame budget for a 10k-message session from 1.5 s to 4 s (it took about 1.65 s). That is documented as a guard against accidentally quadratic code, not a target.
- **Don't pad the loop.** "Continuing #N" messages after every compaction are token waste. After a compaction, re-read state once, then act.
- **Don't wait on a backgrounded verify by polling.** Do read-only planning, then act on the completion notification.

### 7.3 Tooling quick reference

| Task | Command / note |
| --- | --- |
| Full gate | `bun run verify` (format:check → `oxlint --type-aware --deny-warnings` → `bun check` → `bun test`) |
| Fix formatting | `bun run format` (or `bun fmt --no-script <files>`) |
| Pinned Bun | Bun 1.4.4. Several agents wrapped the gate in a PowerShell helper (`margverify.ps1`, run with `BUN_BE_BUN=1` and a copy of `dist/marg.exe` as `bun.exe`). It is not in the repo. Use plain `bun` if it is the pinned version. |
| Writable integration | `bun run test:writable` (needs `opencode` v2.3 on `PATH`; sets `MARGARITA_LIVE_WRITE=1`) |
| Read-only live smoke | `MARGARITA_LIVE=1 bun test test/live-smoke.test.tsx` |
| Multi-server live | `MARGARITA_LIVE_MULTI=1` with `MARGARITA_LIVE_SERVER_A/B` |
| Re-record fixtures | `bun run capture:fixtures` and review the diff |
| Build binary | `bun run build` → `dist/marg.exe` (ignores `bunfig.toml` and `.env` in the launch folder) |
| Commit | write message to a temp file, `git commit -F file` |
| Close issue | include `Fixes #N` in the commit; confirm with `gh issue view N --json state`; comment with evidence |

### 7.4 Where to look for things

- Behaviour spec: `docs/01-product-contract.md` to `docs/26-job-state-lifecycle.md`. The numbered docs map to areas (22 prompt header, 23 tools, 21 throbber, 20 conversation interactions, 19 config/commands, 18 recipes, 15 testing, 11 goals/plans/tasks, 06 composer and keymap, 07 CLI contract, 08 server adapter, 09 sessions and events, 12 permissions, 13 usage footer, 14 terminal platform, 25 compatibility, 26 job-state lifecycle).
- Multi-server: `docs/remote-servers.md`, `src/domain/server-identity.ts`, `src/adapter/server-manager.ts`, `src/app/multi-server-*.test.ts`, `test/production-*.test.ts`.
- Decisions: `adr/0001-through-0005.md`, `adr/0006-packaging.md`; checklists in `checklists/`.
- Release and manual checks: `checklists/release-candidate.md`, `docs/smoke-matrix.md`.
- Upstream reference: the sibling `opencode/` checkout. Agents consulted `packages/core/src/tool/mcp.ts` and `runtime.ts` (MCP tools are registered as `<normalizedName(server)>_<normalizedName(tool)>`, so match configured server names by flattened prefix, not by guessing a separator) and the upstream `opencode.goal` plugin.

---

## 8. Known gaps and open threads

- **Not verified in a real terminal by any agent:** interactive `marg.exe`, Windows Terminal, Ghostty and tmux key checks from the release checklist, mouse-wheel behaviour of the sticky header, streaming-response behaviour of the sticky header, and Ctrl+B against a real running tool. Tree-sitter syntax highlighting fails in the test environment and falls back to plain text.
- **Not covered by tests:** the narrow-window welcome panel (an agent said it added no test), real-OpenCode goal-plugin integration (the disposable service does not load it), per-turn token counts in the throbber (by design).
- **In-memory only:** the interrupt intent in #34 and the cancelled-queue recovery list in #38 are lost on client restart.
- **A flaky test:** one UI acceptance test was described as occasionally timing-flaky in the remote epic run. The final gates passed, but it has not been root-caused.
- **Unexplained:** the `bun test` line-number offset (about 100 lines) from the #29 investigation.
- **Verify wrapper:** `margverify.ps1` is referenced by agents but does not live in the repository; if it matters to you, consider adding a documented script so future agents do not each reinvent it.
- **Uncommitted tree right now:** `README.md`, `package.json`, `scripts/build.ts`, `src/main.ts`, new `src/build-version.ts` and its test, deletion of `docs/marg00.txt` to `docs/marg05.md`, and an untracked `docs/marg06.txt`. Review before the next agent commits so nothing unrelated slips into an issue commit.
- **Public history:** the session dumps committed in `4385498` are in public git history. Removing them from the tree does not remove them from history.
- **Attribution:** the 12 `jules ♡` commits versus `terezi` authorship, described above.
- **Version:** `package.json` currently reads `0.0.0`. The README rewrite had set `0.0.1`, and the tree's `package.json` is modified. Check which is intended.

---

## 9. Ledger: issues and commits mentioned in the transcripts

Hashes are as the agents reported them. Local history was rewritten once (`54b5039` split), and some hashes may differ from the reported ones if history changed again.

| Phase | Issue(s) | Commit | Summary |
| --- | --- | --- | --- |
| marg02 | #4, #5, #15 | n/a | first P1 fixes |
| marg03 | #6 | `080cc9d` | overview row stays visible during keyboard navigation |
| marg03 | #3 | `1bfa3b8` | serialized, locked, atomic local state writes |
| marg03 | #11 | `2d6b820` | `--continue` finds the latest session beyond the first 500 |
| marg03 | #10 | `bcd1d09` | `--resume <id>` hydrates sessions outside initial pages |
| marg03 | #2 | `96cbaa0` | catalogs scoped to project directory with generation guards |
| marg03 | #7 | `4b3627c` | bounded head+tail tool output with truthful elision labels |
| marg03 | #8 | `0e421cf` | staged reverts recovered or cleared safely |
| marg04 | #9 | `022ada8` | remote `@file` mentions via server `file.find` |
| marg04 | #22 | `1d295dd` | server edit diffs carried through |
| marg04 | #30 | `82dc80a` | Up on empty composer cancels newest queued follow-up |
| marg04 | #31 | `16bb11a` | frontend-local commands independent of server catalog |
| marg04 | #28 | `7387e11` | per-turn throbber lifecycle anchored to idle messages |
| marg04 | #29 | `a912561`, `3a4b6a5` | queued follow-ups above throbber, restyled to screenshot |
| marg04 | #26 | `712506c` | completed diff rows no longer remount |
| marg04 | #23 | `274cc81` | stable tool-call groups |
| marg04 | #21 | `8df5908` | local `/goal` replaced by native `opencode.goal` |
| marg04 | #32 | `6267a83` | `/compact` is native session compaction |
| marg06 | #1 | `8f138f6` | print mode follows its own turn |
| marg06 | #20 | `674775d` | writable OpenCode integration suite, fixtures, CI |
| marg06 | #34 | `b7a2778` | goal interrupt intent (in-memory only) |
| marg06 | #37 | `61496d3` | CLI flags on resume/continue |
| marg06 | #38 | `c4827de` | recovery list for cancelled queued text |
| marg06+ | #33, #35, #36, #39 to #41, #44, #46 | n/a | closed in the same runs |
| remote epic | #45 | `e3475d9` | incremental print-mode polling |
| remote epic | #43 | `50bf972` | goal read states (no goal vs unavailable RPC) |
| remote epic | #42 | `f062703` | inline pasted image and file attachments |
| remote epic | #47 | `745f8c8` | server-scoped identities |
| remote epic | #48 | `7fe5a86` | multi-server connection manager |
| remote epic | #49 | `77fd929` | persistent server profiles with OS credential storage |
| remote epic | #50, #51 | `b6ac63c`, `16370ff` | `/pair`, `/servers`, `/unpair` |
| remote epic | #52 | `aaabafd` | `--remote`, `--local`, remote-aware `--cwd` |
| remote epic | #53, #54, #55, #56 | `7d68409`, `09719d0`, `3ea2b2b`, `8d75da8` | reopened, redone, history rewritten |
| remote epic | #57, #58, #59 | `2b31f94`, `179b213`, `93c4a01` | overview tabs, status dots, project colours |
| hardening | #77, #74, #75, #76, #78, #79 | `8a87350`, `32730a2`, `48247a0`, `774dedf`, `71cfab2`, `316ccef` | attachments in new sessions, MCP visibility, current-action line, Ctrl+B hint, qualified keys |
| hardening | #83 and #82 | `d16da01` | refuse unpairing launch server; staged reverts bound to owning host |
| hardening | #84, #85, #86 | `8dc4ffc`, `2800dd4`, `53e048c` | remote path platform, refresh epochs, immutable RPC identity |
| hardening | #90, #104 | `6aae027`, `cb88c8e` | contextual Esc, cross-server regression matrix |
| hardening | #87, #113 | `7bd325d`, `1c43112` | paste and createSession route ownership |
| long run | #91, #92, #93, #94, #95, #110, #116, #118, #119, #120 | `8142049` | model-switch races, MCP scoping, keymap, composer |
| long run | #125, #97, #126 to #128, #121/#122, #96 | `ca14957`, `aa40adc`, `bd106a0`, `55d40cf`, `9528d98` | phantom banner, kill buffer, greetings, footer colours, undo/redo |
| long run | #100, #129, #98/#99 | `0e11734`, `8ea18d3`, `ac83dde` | `/btw` truthful, notification placement, mention attachments |
| long run | #117, #130 | n/a | native cursor attempt, then painted caret after regression |
| long run | #101, #102 | `659feb7`, `aff8dfd` | worker lifecycle, rewind |
| budget run | #133, #134, #138 | `5fcf34c` | agent mention catalog snapshots |
| budget run | #141, #142, #143 | `ccea241` | turn-accurate usage |
| budget run | #132, #146, #163 | `5e7ecc2` | agent switch serialization, picker admission |
| budget run | #140, #147 | `d22b7e3` | epoch and Ctrl+B identity |
| budget run | #131, #153 | `156e2d8` | one bounded OSC 52 write |
| budget run | #144, #145 | `6361a1f` | three-outcome pagination, UTC rewind labels |
| budget run | #149, #152 | `840100d` | CLI resume/continue server-qualified |
| budget run | #154, #155 | `e2a179b` | binary paste origin guard, PDF validation |
| budget run | #150, #157 | `76325cc` | schema guards, shared locks |
| budget run | #156, #159 | `26b8d25` | unpair recovery, exact credential bytes |
| budget run | #151, #158 | `055bf66` | print abort, whitespace fidelity |
| budget run | #161, #162 | `b0b32b7` | goal revisions, stable plan IDs |
| final batch | #167, #168 | `f6fd3a5` | transcript folding keeps canonical assistant text |
| final batch | #165, #166 | `836e081` | model and effort pickers |
| final batch | #160 | `422d596` | history scoped per project |
| final batch | #164 | `86b1f72` | mention punctuation parser |
| final batch | #148 | `4605afe` | opt-in compatibility harness |
| later | #169 to #176 | `c7fd215` | cross-server requests, exports, mentions, state locking |

---

## 10. Source transcripts

| File | Format | What it is |
| --- | --- | --- |
| `marg00.txt` | Claude Code TUI dump | Opus 5.5 bootstrap, milestones 0 to 5 |
| `marg01.txt` | Claude Code TUI dump | docs/22 and 23, tool grouping, README, publish |
| `marg02.json`, `marg03.json`, `marg04.json` | OpenCode export | goal-mode P1 sweeps (interrupted) |
| `marg05.md` | markdown | previous agent's distillation of marg03 and marg04 |
| `marg06.txt` | Claude Code TUI dump | #1, #20, then issues #33 to #46 until usage limit |
| `session-dff1e8a6…json` | OpenCode export | remote epic #42 to #59, reopen and history rewrite |
| `session-0dd4d9bd…json` | OpenCode export | #74 to #79 |
| `session-99816c0f…json`, `session-54c0f9ed…json` | OpenCode export | #83 to #90, #104, #87, #113 |
| `codex-session-01a1fab1…md` | Codex export | #116 and delegated P2 work, cut off by rate limits |
| `session-6737d5d0…json` | OpenCode export | ~30 issues in ~12 commits, #117/#130 cursor regression |
| `session-f2932d08…json` | OpenCode export | 27 of 32 issues, token-budget batching |
| `session-fe467b86…json` | OpenCode export | final 7 issues, tracker empty |
