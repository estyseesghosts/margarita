Filed **15 actionable issues** against [estyseesghosts/margarita](https://github.com/estyseesghosts/margarita?utm_source=chatgpt.com), numbered **#305–#319**.

Each issue specifies deliverables, approaches to avoid, regression tests, and dependencies. They reference your local `~\workdir\style-guides` and its [GitHub repository](https://github.com/estyseesghosts/style-guides?utm_source=chatgpt.com).

### **Foundation — do these first**

| Issue                                                                                                                              | Scope                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [#305 — Architecture and ownership plan](https://github.com/estyseesghosts/margarita/issues/305?utm_source=chatgpt.com)            | Map every mutable state owner, dependency, lifecycle and extraction boundary. **Master tracking issue.** |
| [#306 — Characterization and race tests](https://github.com/estyseesghosts/margarita/issues/306?utm_source=chatgpt.com)            | Preserve existing behavior through deterministic concurrency and integration tests.                      |
| [#307 — Style guides and architectural enforcement](https://github.com/estyseesghosts/margarita/issues/307?utm_source=chatgpt.com) | Fix local guide references, enforce dependency boundaries, improve public contracts and CI.              |

### **Decompose the controller**

| Issue                                                                                                                   | Scope                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [#308 — Session and server coordination](https://github.com/estyseesghosts/margarita/issues/308?utm_source=chatgpt.com) | Session indexes, reconnects, events, pagination and host isolation.           |
| [#309 — Transcript lifecycle](https://github.com/estyseesghosts/margarita/issues/309?utm_source=chatgpt.com)            | Refresh scheduling, caching, invalidation, retries and pagination.            |
| [#310 — Permissions and forms](https://github.com/estyseesghosts/margarita/issues/310?utm_source=chatgpt.com)           | Request ownership, descendant verification and safe replies.                  |
| [#311 — Composer and drafts](https://github.com/estyseesghosts/margarita/issues/311?utm_source=chatgpt.com)             | Route-specific drafts, attachments, undo, paste and external editing.         |
| [#312 — Prompt submission](https://github.com/estyseesghosts/margarita/issues/312?utm_source=chatgpt.com)               | Explicit admission transactions, correct failure handling and draft recovery. |
| [#313 — Models and agents](https://github.com/estyseesghosts/margarita/issues/313?utm_source=chatgpt.com)               | Scoped catalogs, confirmed selection and safe dispatch.                       |
| [#314 — Goals and plans](https://github.com/estyseesghosts/margarita/issues/314?utm_source=chatgpt.com)                 | State ownership, revision control, conflicts and task workflows.              |
| [#315 — Inspection and revert](https://github.com/estyseesghosts/margarita/issues/315?utm_source=chatgpt.com)           | Diff inspection, tool-output viewing and safe destructive operations.         |
| [#317 — Persistence](https://github.com/estyseesghosts/margarita/issues/317?utm_source=chatgpt.com)                     | Serialized writes, cross-process merging, failures and shutdown flushing.     |

### **Clean up the remaining boundaries**

| Issue                                                                                                                   | Scope                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [#316 — Reactive state ownership](https://github.com/estyseesghosts/margarita/issues/316?utm_source=chatgpt.com)        | Replace Solid setter interception and fragile manual cache invalidation.                   |
| [#318 — UI decomposition](https://github.com/estyseesghosts/margarita/issues/318?utm_source=chatgpt.com)                | Break up coupled views and replace direct controller dependencies with narrower contracts. |
| [#319 — Transcript-domain decomposition](https://github.com/estyseesghosts/margarita/issues/319?utm_source=chatgpt.com) | Separate tool classification, incremental projection and preview policies.                 |

## **Implementation order**

I would establish **#305 and #306 first**, with #307 proceeding alongside them. Then extract capability owners in independently testable changes. Remove the old reactive-state coordination and narrow the UI dependencies once those owners exist.

The tickets explicitly prohibit mechanical LOC-driven decomposition, blanket rewrites, replacing proven optimizations, and weakening tests to make refactors pass.

**The completion criterion is not a smaller&#x20;**`controller.ts`**.** It's a codebase where a developer can change one feature without understanding unrelated state, network, persistence and rendering lifecycles.

No source code was modified.

## **Margarita code quality audit**

Significant architectural debt

**My preliminary assessment: Margarita is functional and fairly well defended against regressions, but its application architecture has become substantially more complicated than it should be.**

I inspected the current `master` revision, [`4d9c6af`](https://github.com/estyseesghosts/margarita/commit/4d9c6af5baae04964598f09d477a45c3b63ad8fc?utm_source=chatgpt.com), against your [style-guides repository](https://github.com/estyseesghosts/style-guides?utm_source=chatgpt.com).

The warning about the controller is accurate:

- [`src/app/controller.ts`](https://github.com/estyseesghosts/margarita/blob/master/src/app/controller.ts?utm_source=chatgpt.com) contains **9,065 lines**, approximately 70 fields, and hundreds of methods.
- It owns server synchronization, session lifecycle, transcript caching, composer state, model and agent selection, forms, permissions, navigation, and persistence.
- It directly depends on Solid's reactive store, signals, and batching mechanisms.
- Several other substantial modules surround it, including a 1,698-line transcript view and a 1,443-line transcript-domain module.

However, this is not simply a poorly organized application with no engineering discipline.

The repository has extensive automated testing, deliberate domain/adapter separation, strict TypeScript checking, and explicit protections against asynchronous races. Its latest GitHub Actions run passed on Windows and Linux, including a Linux executable smoke test.

**The central concern is changeability:** too many unrelated features depend on one controller's internal state and lifecycle. That makes future changes expensive and raises regression risk even when the current behavior is correct.

## **1. The actual architectural problems**

| Finding                                            | Severity    | Assessment            |
| -------------------------------------------------- | ----------- | --------------------- |
| Controller owns too many independent systems       | High        | Confirmed             |
| Reactive and non-reactive state are interdependent | High        | Confirmed design risk |
| UI depends on the concrete controller              | High        | Confirmed             |
| Some operations are excessively complicated        | Medium–High | Confirmed             |
| Test suites are themselves difficult to maintain   | Medium      | Confirmed             |
| Poor runtime performance caused by controller size | Unknown     | Not demonstrated      |

### **The controller is more than a coordinator**

A controller legitimately coordinates multiple systems. Margarita goes substantially further.

Consider the responsibilities grouped within the same class:

| Source lines | Responsibility                                                 |
| ------------ | -------------------------------------------------------------- |
| 1108–1976    | Startup, catalogs, sessions, pagination                        |
| 1977–3082    | Events, reconnection, requests, job and transcript refresh     |
| 3291–4474    | Navigation, drafts, pasting, editing, completion, history      |
| 4475–5658    | Prompt submission, session creation, server management         |
| 5659–6490    | Agents, models, selection and confirmation                     |
| 7046–8310    | Permissions, forms, diffs, transcript interactions, inspectors |
| 8311–8985    | Persistence, plans, tasks, rewind and revert                   |

These aren't simply adjacent implementations of one responsibility. They have distinct data lifetimes, failure modes, and reasons to change.

For example, changing file-mention completion should not require understanding the controller's session-reconnection lifecycle.

Your general style guide explicitly discourages this kind of centralization.

### **The state management is particularly concerning**

See [controller.ts, lines 468–686](https://github.com/estyseesghosts/margarita/blob/4d9c6af5baae04964598f09d477a45c3b63ad8fc/src/app/controller.ts?utm_source=chatgpt.com#L468-L686).

Margarita maintains a Solid reactive store alongside numerous ordinary Maps, Sets, counters, timers, and caches.

That arrangement can work. The problem is how those systems synchronize.

At lines 650–686, the controller wraps Solid's overloaded state setter using `Reflect.apply`. It examines the arguments to determine whether to invalidate cached overview projections.

That means adding a new property affecting the overview may require simultaneously changing the state definition, update logic, and manual invalidation rules.

The existing tests protect current behavior, but the design creates an ongoing obligation to keep those pieces synchronized.

**This is one of the first areas I would redesign.** Prefer explicit state transitions with clear owners over inferring which cached views might have changed from overloaded setter arguments.

### **The UI/controller boundary is too broad**

The UI imports `AppController` directly, reads `controller.state`, and invokes its extensive method surface.

Examples include [app.tsx](https://github.com/estyseesghosts/margarita/blob/master/src/ui/app.tsx?utm_source=chatgpt.com), [key-router.ts](https://github.com/estyseesghosts/margarita/blob/master/src/app/key-router.ts?utm_source=chatgpt.com), and [transcript-view.tsx](https://github.com/estyseesghosts/margarita/blob/master/src/ui/transcript-view.tsx?utm_source=chatgpt.com).

Consequently, the controller's internal organization effectively becomes part of the UI's programming interface.

This makes features harder to isolate, test independently, or reuse in another frontend.

The existing domain layer is considerably better separated. The problem is that much of the application behavior still lives outside it.

## **2. What Margarita is doing well**

There is genuine engineering quality in this repository.

**Asynchronous correctness:** The controller uses per-session generations, server-qualified identities, stale-response rejection, explicit ownership checks, and bounded retries. I inspected these in session refresh, form handling, transcript reconciliation, and prompt admission.

For example, [refreshInputRequests()](https://github.com/estyseesghosts/margarita/blob/master/src/app/controller.ts?utm_source=chatgpt.com#L2327-L2456) independently reconciles permissions and forms, protects against late responses, and verifies child-session ownership before displaying requests.

That's substantially better than blindly updating state whenever an HTTP request finishes.

**Testing:** `controller.test.ts` contains approximately 270 test cases, while `app.test.tsx` contains another 115. Additional suites cover backend mapping, multi-server ownership, persistence, and compatibility.

The production-composition tests deliberately use conflicting session IDs across servers. That's meaningful coverage of a real failure mode, not just superficial unit testing.

**Dependency separation:** The OpenCode integration is behind a typed backend interface. The domain modules contain reusable logic that generally does not depend on Solid.

**Performance discipline:** The project has explicit benchmarks, incremental transcript projection, formatting counters, and bounded transcript caches.

The [performance documentation](https://github.com/estyseesghosts/margarita/blob/master/docs/27-performance.md?utm_source=chatgpt.com) also distinguishes measured work from native rendering costs it cannot currently measure.

These qualities are worth preserving during any refactor.

## **3. Does Margarita comply with your style guides?**

**Partially. Not fully.**

I compared the source with both the [general review standard](https://github.com/estyseesghosts/style-guides/blob/master/README.md?utm_source=chatgpt.com) and the [TypeScript/JavaScript guide](https://github.com/estyseesghosts/style-guides/blob/master/typescript-javascript-style-guide.md?utm_source=chatgpt.com).

| Requirement                             | Result           | Evidence                                                       |
| --------------------------------------- | ---------------- | -------------------------------------------------------------- |
| Strict type checking                    | Pass             | Strict TypeScript, indexed-access and optional-property checks |
| No explicit `any` without justification | Generally pass   | Type-aware linting explicitly prohibits it                     |
| Clear transport/domain separation       | Mostly pass      | Typed backend and dedicated domain modules                     |
| Explicit asynchronous ownership         | Strong           | Generations, server qualification, stale-response protection   |
| Coherent module responsibilities        | Fail             | The controller mixes many independently evolving features      |
| Focused functions                       | Partial          | Several methods contain complex, multi-stage workflows         |
| Document top-level exports              | Fail             | Multiple exported types, functions and classes lack JSDoc      |
| Prefer interfaces for object types      | Fail             | Extensive use of `type Foo = Readonly<{...}>`                  |
| Google-style identifier naming          | Partial          | Internal `serverID`, `sessionID`, `messageID`, etc.            |
| Testing and verification                | Good, incomplete | Strong automated tests; live compatibility tests opt-in        |

The interface and identifier issues are relatively minor.

For instance, Google's guide prefers `serverId` rather than `serverID`. External wire-format names must preserve their upstream spelling, but internally defined identifiers could follow the guide.

Likewise, the guide prefers interfaces for object shapes. Margarita frequently uses `Readonly` type aliases instead. This is a genuine style mismatch, but changing all of them immediately would provide little practical benefit.

The JSDoc gap is more significant for public contracts such as `AppController`, `ControllerDeps`, `AppState`, and the backend API.

The biggest violation remains architectural: your general standard asks that responsibilities, mutable state, and dependencies have clear ownership. Margarita currently concentrates too much of that ownership in one class.

There is also an enforcement gap. `AGENTS.md` refers to a local `~/workdir/style-guide` path as well as `style-guides/...`, while CI checks Bun formatting, Oxlint, TypeScript and tests. It doesn't systematically enforce every convention in your guides.

## **4. The testing situation deserves a distinction**

The tests are extensive, but two central test files have grown alongside the production controller.

This suggests that the test organization partly mirrors the architectural coupling.

I would split tests by behavioral responsibility **as those responsibilities are extracted**, keeping shared fixtures where they help. Merely dividing the files without changing their dependencies would accomplish little.

There are also verification limits:

- Live OpenCode compatibility tests require explicit opt-in and aren't exercised against a real service by ordinary CI.
- Windows release verification exercises the executable's help/version commands, but not an equivalent interactive PTY test matrix.
- Reported performance benchmarks don't measure actual native frame rendering.

These are coverage boundaries, not proof of current defects.

## **5. What I would change**

&#x20;P0&#x20;

**Separate state ownership before splitting files.**

Extract transcript synchronization, session lifecycle, and input-request coordination into independently testable units. Define which unit owns each cache, timer, generation counter, and mutation.

P1

**Reduce the controller's public interface.**

Give UI features narrower operations and read-only state views. Keep a compatibility facade during migration so existing interaction code and tests remain functional.

P1

**Make reactive invalidation explicit.**

Replace the state-setter interception with clearly owned state updates and derived reactive selectors. Preserve the existing incremental transcript and overview optimizations.

P2

**Improve tests and style enforcement.**

Organize tests around the extracted behaviors, add architecture-boundary checks, document public contracts, and enforce a practical subset of the TypeScript guide.

I would specifically avoid rewriting Margarita, splitting everything into tiny modules, introducing a general-purpose state framework, or adding one interface for every method.

Those approaches could increase complexity without fixing the ownership problem.

## **Overall verdict**

| Dimension                        | Assessment |
| -------------------------------- | ---------- |
| Correctness safeguards           | Good       |
| Test engineering                 | Good       |
| Code readability                 | Mixed      |
| Architecture                     | Poor       |
| Maintainability as features grow | Concerning |
| Style-guide compliance           | Partial    |
| Need for complete rewrite        | No         |
| Need for deliberate refactoring  | Yes        |

**Margarita has accumulated substantial architectural debt, but not a complete code-quality failure.**

The strongest warning is not that the controller has 9,065 lines. It's that a developer implementing an ordinary interaction may need to reason about a large collection of otherwise unrelated state machines.

The application already contains much of the domain separation, testing infrastructure, and explicit correctness logic needed to improve this.

I would treat this as a **priority architectural refactor**, conducted incrementally with behavioral parity tests, rather than an emergency rewrite or a cosmetic cleanup.

This was a source-level review supported by the passing GitHub CI results, not an independent local build, runtime profile, or exhaustive verification of every execution path. I found significant demonstrated design problems, but I would not claim a new critical runtime defect solely from these findings.
