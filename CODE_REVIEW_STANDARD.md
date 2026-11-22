# Code Quality and Maintenance Review Standard

**Audience:** Code-review agents assessing existing code, proposed changes, bug fixes, and refactors.  
**Objective:** Make the codebase more correct, understandable, predictable, and economical to maintain without imposing needless rewrites.

## 1. Review philosophy

High-quality code is code whose **behavior can be explained, whose assumptions are visible, whose failures are manageable, and whose future changes can be made without surprising unrelated parts of the system**. It is not merely short, clever, modern, generic, or heavily documented.

Review in this order:

1. **Correctness:** Does it satisfy the real contract in normal, edge, and failure cases?
2. **Safety and stability:** Can it corrupt data, violate an invariant, leak resources, hang, deadlock, or expose users to risk?
3. **Design:** Are responsibilities, ownership, dependencies, and state transitions appropriate?
4. **Changeability:** Can the next developer safely find and change the relevant behavior?
5. **Verification:** Are important claims supported by meaningful tests or other evidence?
6. **Readability:** Can a human follow the control flow, data flow, and reasoning?
7. **Consistency:** Does it follow the project's established conventions and language-specific standards?

A change **need not be perfect** to pass review. It must demonstrably improve or preserve overall code health, respect the project’s constraints, and not introduce unjustified regressions. Do not hold up a correct fix over an aesthetic preference. Do not excuse a real correctness bug because the code is pretty.

## 2. Establish the actual contract first

Before judging implementation quality:

- Read the project README, `AGENTS.md`, relevant architecture documents, configuration, tests, and public API contracts.
- Determine the platform, supported versions, resource budget, compatibility requirements, and non-goals. A constrained console homebrew project, terminal UI, library, and web service have different legitimate tradeoffs.
- Identify **who depends on this behavior**: callers, users, plugins, persisted formats, external services, release artifacts, and developers.
- Inspect the surrounding implementation and at least one complete call path. A diff alone may hide important state or lifetime behavior.
- Distinguish a deliberate constraint from an accidental limitation. Do not recommend solutions that quietly invalidate a product or performance requirement.
- Identify what the change claims to fix and whether the implementation addresses the underlying cause rather than disguising a symptom.

**Do not:** invent requirements, apply a generic “best practice” without understanding the project, assume a passing build means correct behavior, or assume an unfamiliar design is wrong merely because it differs from your preference.

## 3. Correctness and invariants

Review the code as a set of contracts, not as isolated statements.

**Require:**

- Inputs are validated at the right boundary. Internal trusted values should not be revalidated everywhere without reason.
- Preconditions, postconditions, and invariants are explicit in types, checks, or carefully chosen documentation.
- Edge cases are accounted for: empty input, duplicates, missing entries, malformed input, partial reads/writes, stale values, integer boundaries, Unicode, cancellation, retries, timeouts, and shutdown.
- Resource ownership and cleanup are predictable across success, failure, early return, and interruption.
- Mutations are atomic where users reasonably expect them to be. Partial success is specified or safely rolled back.
- Concurrent and asynchronous behavior is safe under reordered events, duplicate notifications, delayed responses, reconnection, and teardown.
- Error paths retain enough information to identify the cause and preserve any recoverable state.

For each stateful operation, ask: **What can happen before, during, after, twice, and not at all?** For each asynchronous operation, ask: **What if a later request finishes first? What if the owner disappears?**

**Do not:** silently swallow errors; replace failures with plausible but false defaults; assume operations execute once or in order; use success-path tests as evidence for recovery behavior; or introduce a fallback that changes a core invariant without being visible to callers.

## 4. Architecture, responsibility, and boundaries

A maintainable system makes it reasonably obvious **where a change belongs**.

**Prefer:**

- One clear owner for each responsibility and each piece of mutable state.
- Dependencies pointing toward stable interfaces or core logic rather than allowing every component to depend on every other component.
- Domain logic separated from transport, persistence, terminal/UI rendering, hardware interaction, and third-party API adaptation when these concerns can vary independently.
- Explicit translation between external data formats and internal representations.
- Modules grouped around coherent capabilities or data ownership, not arbitrary file sizes or fashionable patterns.
- Public APIs that expose required behavior while hiding replaceable implementation details.
- Types and data models that make invalid states difficult to represent.

When reviewing a proposed abstraction, require a concrete answer to: **Which real duplication, coupling, or change risk does this remove?** A useful abstraction reduces the number of things a maintainer must understand; a bad abstraction merely moves complexity into another file.

**Do not:** create an interface for every single implementation; add factories, registries, plugin systems, or inheritance layers without current need; split simple logic across many tiny wrappers; build a universal framework around one use case; expose internals merely to simplify one test; or centralize unrelated responsibilities in a `Manager`, `Utils`, or `Common` catch-all.

Duplication is not always worse than coupling. Two short, independently evolving operations can be clearer than a shared function with six flags. Conversely, copied complex logic that must remain identical is an actual maintenance risk.

## 5. Human-readable control flow

Good code makes the _important path_ easy to see and the _unusual path_ difficult to overlook.

**Prefer:**

- Functions with a coherent purpose, inputs, outputs, and side effects.
- Straightforward execution order; early returns for invalid or exceptional cases when they reduce nesting.
- Intermediate values named for their meaning when they clarify a complex expression.
- Operations at roughly one level of abstraction within a function.
- Local reasoning: the reader should not need to inspect six unrelated files to understand a simple operation.
- Explicit branching where a dense expression, callback chain, or iterator pipeline obscures behavior.
- Small enough scopes to track variable lifetimes and mutation, without artificially fragmenting obvious logic.

**Example:** Prefer `if !session.is_connected() { return Err(NotConnected); }` followed by the normal path over five nested conditions. Prefer `remaining_bytes` to `n`, except where a short conventional name genuinely improves readability.

**Do not:** compress operations into one-liners to reduce line count; split every three lines into a helper; hide meaningful side effects in getters; use clever operator tricks; create functions whose names claim one action but mutate unrelated state; or rewrite readable loops into combinator chains merely to appear idiomatic.

There is no universal maximum function length, nesting count, or file length. Flag these only when they create a demonstrated comprehension or change-risk problem.

## 6. Naming and vocabulary

Names should tell readers what a thing **means**, not merely what data type it holds.

**Prefer:**

- Domain terms that match product behavior and existing documentation.
- Names that distinguish source from derived state, desired from observed state, and request from result.
- Verbs for actions, nouns for values, and boolean names that read as propositions (`is_ready`, `has_pending_write`).
- Units where confusion is possible (`timeout_ms`, `frame_count`, `bytes_written`).
- Precise differences between superficially similar concepts (`active_model`, `configured_default_model`, `last_used_model`).

**Do not:** use generic names such as `data`, `thing`, `result2`, `handle_stuff`, or `process` when a specific term exists; introduce multiple synonyms for one concept; encode obsolete implementation details into names; or overextend names into prose when context already supplies the meaning.

A misleading name is often more dangerous than a short name.

## 7. State, events, and lifecycle

Stateful software deserves special scrutiny because locally correct handlers can produce globally incorrect behavior.

**Require:**

- A clearly identified source of truth for each value.
- Derived state computed from its source unless caching is justified and invalidation is reliable.
- Event handlers that behave correctly under duplicate, missing, late, and out-of-order events.
- Explicit ownership of subscriptions, timers, tasks, file handles, threads, sessions, and UI focus.
- Idempotent cleanup and reconnection where appropriate.
- Defined behavior for initialization, loading, empty, ready, error, interrupted, and disposed states.
- Versioning or request identity when an old asynchronous response could overwrite newer state.

**Do not:** create multiple independently mutable copies of the same state; paper over lifecycle bugs with arbitrary delays; preserve stale UI placeholders after authoritative values arrive; turn a temporary missing value into a permanent default; or add reactive synchronization effects when the value can simply be derived.

For streaming or event-driven clients, check event ordering, replacement versus append semantics, transcript replay, partial records, missing optional fields, cancellation, and whether rendering changes if events arrive in another valid order.

## 8. Errors, diagnostics, and recoverability

Errors are part of the API and user experience.

**Prefer:**

- Error types or messages that distinguish actionable failure modes.
- Context added at useful boundaries: what operation failed, which resource was involved, and what the caller can do.
- Preservation of the original cause rather than replacing all failures with `UnknownError`.
- Explicit retry policy: which failures are retryable, retry limits, backoff, and cancellation behavior.
- Structured diagnostic data for complex flows; predictable logging levels; protection of secrets and personal data.
- User-visible errors that are accurate and comprehensible, with optional technical detail when needed.

**Do not:** log and rethrow the same failure at every layer; catch every error and continue as if successful; create endless silent retries; panic on routine external input; flood logs with per-frame or per-event chatter; or claim a diagnostic exists without verifying that it can isolate the failure in practice.

## 9. Tests that prove behavior

Tests are evidence, not decoration. Review whether each test can detect a realistic regression.

**Require, as applicable:**

- Tests for the intended behavior and the bug being fixed.
- At least one test that fails against the old broken behavior when a regression is being repaired, where practical.
- Boundary and negative cases, not just ideal inputs.
- Integration tests at real component boundaries, especially parsing, persistence, serialization, concurrency, and external protocol interactions.
- Deterministic fixtures, explicit time control, and isolated state; no unbounded sleeps or network dependencies in routine tests.
- Assertions on **observable effects**, not simply that a mocked method was invoked.
- Validation that tests themselves would fail if the underlying code were wrong.

**Do not:** generate broad snapshot updates without inspecting semantic changes; mock away the behavior under test; copy production logic into the test oracle; test implementation details so tightly that harmless refactors break the suite; or assert only `is_ok()` for a function whose returned value matters.

A test suite with many tests but no coverage of failure transitions can still be weak. Focus on valuable behavior, not counts or coverage percentages alone.

## 10. Performance and resource discipline

Performance is part of correctness when the project has latency, memory, power, frame-time, or throughput requirements.

**Review:**

- Algorithmic growth on realistic and worst-case inputs.
- Work repeated inside hot loops, render paths, input handling, or streaming updates.
- Avoidable allocation, copying, conversions, parsing, disk/network access, and contention.
- Cache lifetime and invalidation cost, not just cache-hit speed.
- Memory growth, large buffering, unbounded queues, and resource retention.
- Tail latency, long frames, cold start, and slow-device behavior where relevant.

**Require measurements** before treating a plausible hot path as a verified bottleneck. Record hardware, workload, baseline, measurement method, and before/after results. Preserve correctness while optimizing.

**Do not:** add caches by default; trade deterministic behavior for speed without a requirement; use lock-free or unsafe techniques without proof of benefit and documented invariants; optimize code merely because it looks slow; or claim improvement from a benchmark that measures a different workload.

## 11. Comments and documentation

Code should describe **what happens**. Documentation should capture **intent, contract, and non-obvious constraints**.

**Prefer:**

- Comments explaining surprising decisions, protocol quirks, hardware limitations, algorithms, or why an apparently simpler approach is wrong.
- API documentation covering inputs, outputs, errors, ownership/lifetime, invariants, side effects, and usage constraints.
- Architecture notes describing boundaries and rationale without duplicating the source line-by-line.
- README/build/release updates when behavior or workflow changes.
- TODOs linked to a concrete condition, issue, or reason, with enough context to act on them.

**Do not:** narrate obvious assignments; add verbose comments to compensate for confusing code that could be clarified; leave comments contradicting the implementation; write aspirational documentation for features that do not exist; or preserve old TODOs after their underlying condition is gone.

Treat inaccurate documentation as a bug. Check examples and commands rather than assuming they still work.

## 12. APIs, compatibility, and dependencies

**Require:**

- Clear stable public contracts, including error and cancellation behavior.
- Intentional serialization formats, migration paths, and version handling.
- Backward compatibility where promised; explicit breaking-change documentation where not possible.
- Dependencies justified by actual functionality, maintenance status, portability, security, and build impact.
- Reproducible builds and release paths for supported targets, not only the developer’s machine.

**Do not:** introduce a large dependency for one trivial helper; alter persisted data or public API shape without testing existing consumers; expose implementation-only types as public contracts; or silently drop a supported platform to simplify a patch.

Review external inputs, file paths, shell invocation, deserialization, authentication/authorization, secrets, and output escaping at trust boundaries. Do not make security claims unsupported by a concrete threat model or test.

## 13. User interfaces and interaction code

For UI/TUI clients, visual quality and behavioral consistency are functional requirements.

**Check:** focus and keyboard navigation; pointer interaction; repeated toggles; escape/dismiss behavior; resizing; scrolling; selection; text composition and Unicode; empty/loading/error states; accessibility where applicable; updates during streaming; and visual consistency with the project’s design system.

Follow a full user interaction, not only the component that changed. Verify that selection, view state, and underlying data agree after interruptions and asynchronous updates.

**Do not:** fix a display bug by suppressing real data; show placeholder labels as though they were authoritative; add duplicate status messages; create controls with inconsistent close/open semantics; or fix one viewport size by breaking another.

## 14. Rust-specific review requirements

For Rust projects, follow **Google’s Rust Style Guide** as the default project-level review reference, alongside the official Rust style and API guidelines, except where explicit repository rules or platform constraints require a documented deviation:

- Google Rust Style Guide: https://google.github.io/styleguide/rustguide.html
- Rust Style Guide: https://doc.rust-lang.org/style-guide/
- Rust API Guidelines: https://rust-lang.github.io/api-guidelines/

Run available checks such as `cargo fmt --check`, `cargo clippy --all-targets --all-features` (where feature combinations are valid), and appropriate tests. A successful check is supporting evidence, not complete verification.

Review ownership, borrowing, lifetimes, visibility, feature gates, error propagation, trait bounds, unsafe blocks, and cross-platform conditional compilation.

**Prefer:** explicit domain errors, justified allocation, appropriately narrow `pub` visibility, ordinary iteration when clearer, and constructors/types that enforce valid state. Document safety invariants for every `unsafe` contract and verify that **callers actually uphold them**.

**Do not:** add gratuitous `clone()` or `Arc<Mutex<_>>` merely to bypass a poorly designed ownership model; use `unwrap()`/`expect()` on routine recoverable failures; force `unwrap()` avoidance where an invariant is genuinely proven and a panic policy is intentional; hide costs behind elaborate iterator pipelines; use `unsafe` solely to evade the borrow checker; or introduce extensive trait abstractions without multiple genuine use cases. Apply the Google guide in context, especially where it distinguishes library APIs from application code or Chromium-specific rules.

## 15. Regression risk and root-cause analysis

Before approving a fix, trace the **old behavior, failure mechanism, proposed correction, and affected neighboring behaviors**.

- Verify the reported failure or construct the shortest plausible reproduction supported by evidence.
- Find the first point where reality diverges from the intended contract.
- Determine whether the defect belongs to data ingestion, state representation, event processing, business logic, API adaptation, or presentation.
- Test both the repaired case and nearby states that previously worked.
- Check whether a similar fix already exists elsewhere; reuse the correct mechanism rather than adding a second conflicting one.
- Inspect regressions introduced by earlier repairs, especially cancellation, model selection, streaming, error fallback, persistence, and other shared state paths.

**Do not:** insert arbitrary delays, reorder operations without understanding dependencies, filter out valid events to hide a UI bug, replace structured state with string matching, duplicate an entire component to avoid understanding it, or weaken an invariant/test merely to make CI green.

A fix that merely removes the visible symptom but leaves the underlying state inconsistent is not complete.

## 16. Review workflow for agents

1. **Scope:** Establish repository revision, files/commit range, intended behavior, and non-goals.
2. **Map:** Find entry points, owners, call sites, event paths, tests, and relevant documentation.
3. **Trace:** Inspect at least one normal, one boundary, and one failure path. For concurrency, analyze meaningful interleavings.
4. **Verify:** Run relevant checks where possible; use minimal reproductions or static proofs where execution is unavailable. State limitations.
5. **Challenge:** Ask whether the same design works after cancellation, duplicate calls, unexpected input, restart, resize, migration, or another change.
6. **Rank:** Separate confirmed bugs from likely risks and subjective suggestions. Determine impact and how directly the problem is evidenced.
7. **Report:** Provide a precise location, why the behavior is wrong, the triggering scenario, expected behavior, a bounded fix direction, and regression tests. Explain what approaches must **not** be used when they would repeat the failure.
8. **Recheck:** Confirm recommendations do not contradict project constraints or create a second defect. Deduplicate overlapping findings.

Do not make edits or file issues unless instructed. If you are reviewing only a subset of the system, say so. Never claim to have executed a test, inspected a file, reproduced a defect, or measured performance unless you actually did.

## 17. Classify findings consistently

- **P0 — Critical:** Credible data loss/corruption, severe security exposure, widespread crash, or unusable core functionality requiring immediate attention.
- **P1 — High:** Reproducible or strongly demonstrated major behavioral failure, core contract violation, severe regression, deadlock, or substantial performance failure on a supported target.
- **P2 — Medium:** Real but bounded behavior issue, significant maintainability risk with a concrete mechanism, weak recovery path, or missing regression coverage for a fragile feature.
- **P3 — Low:** Small usability/readability issue, local cleanup, documentation mismatch with limited impact, or clearly optional improvement.

Severity is **impact**, not certainty. Label confidence separately: **Confirmed**, **Strongly supported**, **Plausible / needs verification**. Do not present a hypothetical code smell as a confirmed defect. Do not assign P1 to a stylistic disagreement.

### Required finding format

**Title:** `[P1][state] Older response can overwrite the newly selected model`  
**Location:** Repository-relative file and exact symbol/line range; commit or revision if known.  
**Evidence:** What the implementation demonstrably does; include relevant conditions and observations.  
**Trigger:** The minimal event sequence or input required.  
**Expected / actual:** What should happen versus what happens.  
**Impact:** User-facing failure, correctness risk, or maintenance cost.  
**Fix direction:** Smallest architectural correction that resolves the cause.  
**Do not:** A specific tempting workaround that would conceal the problem or introduce a regression.  
**Verification:** A regression test or repeatable manual scenario.  
**Confidence:** Confirmed / strongly supported / plausible.

Avoid long reports padded with general best practices. Every paragraph should help a developer understand or verify the finding.

## 18. Common false positives and review anti-patterns

**Do not flag automatically:**

- A long function when it is a clear, linear sequence with one purpose.
- A short duplicated block when abstraction would create tighter coupling.
- A `match`, explicit state machine, or verbose error type merely for having more lines.
- A public type or dependency without checking whether other packages legitimately require it.
- An allocation, lock, or clone without estimating frequency and cost.
- Missing tests for behavior outside the project's scope.
- An unfamiliar local convention without checking documented standards.
- Code that differs from your preferred architecture but meets the actual requirements cleanly.

**Never:** manufacture line numbers; speculate about unseen runtime behavior as fact; suggest deleting tests that reveal a real defect; mark a fix complete from a diff alone; recommend sweeping rewrites without a specific payoff; demand style-only changes in unrelated files; create duplicate issue reports; or use static-analysis output without checking relevance.

Good reviewers are skeptical of both the implementation **and their own conclusions**. Search for counterexamples to a proposed finding before reporting it.

## 19. Final review output

Produce, in this order:

1. **Scope and verification:** Revision, areas inspected, tools/tests run, and any unverified assumptions.
2. **Findings:** Ordered by priority, each using the template above; include only actionable, distinct findings.
3. **Systemic risks:** Patterns spanning multiple findings, with evidence and likely root causes.
4. **Recommended sequence:** Fix correctness and data/state invariants first, then regression coverage, then localized design cleanup. Flag dependencies between fixes.
5. **Residual uncertainty:** What needs runtime testing, domain expertise, hardware testing, or additional source access.

If no material issues are found, say so plainly. Do not invent findings to make a review look productive. A review is successful if it provides a reliable assessment—not if it produces the most tickets.

## 20. Primary references

- Google Engineering Practices — [What to look for in a code review](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
- Google Engineering Practices — [The standard of code review](https://google.github.io/eng-practices/review/reviewer/standard.html)
- Google — [Rust Style Guide](https://google.github.io/styleguide/rustguide.html)
- Rust Project — [Rust Style Guide](https://doc.rust-lang.org/style-guide/) and [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/)
- Martin Fowler — [Code Smell](https://martinfowler.com/bliki/CodeSmell.html) (a warning signal requiring investigation, not automatic proof of a bug)

**Final principle:** Prefer changes that make future errors less likely and future reasoning easier. Reject changes that merely make the code look cleaner while obscuring its behavior, weakening its guarantees, or creating new maintenance obligations.
