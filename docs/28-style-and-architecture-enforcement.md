# Style and architecture enforcement

This document closes the enforcement gap recorded in `docs/marg-audit.md` (the
AGENTS/CI findings) and issue #307. It makes the style-guide instructions
reproducible on a clean checkout and states plainly what a green build does and
does not prove. It does **not** create new style rules.

## Source of the rules

The general review standard and the TypeScript/JavaScript guide are the
authoritative documents:

- Windows: `~\workdir\style-guides\README.md` and
  `~\workdir\style-guides\typescript-javascript-style-guide.md`
- Unix-like: `~/workdir/style-guides/README.md` and
  `~/workdir/style-guides/typescript-javascript-style-guide.md`
- Mirror when the local checkout is absent:
  <https://github.com/estyseesghosts/style-guides>

Earlier instructions named a singular `style-guide` directory that does not
exist; that path is removed from `AGENTS.md` and `CLAUDE.md`. Verification must
not depend on a contributor having a local copy of the guides, so no check in
this repository reads them.

## What `bun run verify` checks

`package.json` defines `verify` as the ordered gate below. The same command runs
on Ubuntu and Windows in `.github/workflows/verify.yml`, so every rule in this
table is enforced on both supported development platforms.

| Check | Command | What it actually proves |
| --- | --- | --- |
| Formatting | `bun fmt --no-script --check` | Bun's formatter agrees with the committed source. |
| Lint | `oxlint --type-aware --deny-warnings` | Type-aware lint rules pass; warnings are errors. |
| Types | `bun check` | Strict TypeScript checking, including indexed access and optional properties. |
| Tests | `bun test` | Behavioural assertions pass, including the architecture-gate tests. |
| Boundaries | `bun run check:architecture` | Production import edges and import cycles follow the rules below. |

`check:architecture` is a local Bun script (`scripts/check-architecture.ts`)
that reads `src/**/*.ts(x)` and reports every offending import with a file and
line. Module edges come from the pinned `@babel/parser` syntax parser, so
comments, string literals and multiline imports are never mistaken for edges,
and `import`/`import type`/re-exports/side-effect imports/literal `import()`/
`require()`/`import = require` are all covered (#325). The declarative policy
is exported as `ARCHITECTURE_POLICY` from the script; this table is its human
readable mirror. A computed (nonliteral) dynamic specifier fails closed in
production code because no static gate can prove what it imports. Semantic
ownership and changeability remain review responsibilities.

## Import-boundary rules

Rules apply to production files under `src/`. Files whose name ends in
`.test.ts`/`.test.tsx` and files under `test/` are exempt: tests are allowed to
import any layer so they can exercise real components through the production
assembly. `src/main.ts` and `src/app/production-assembly.ts` are composition
roots and may depend on every layer.

| From | Must not import | Why |
| --- | --- | --- |
| `src/domain/` | `app/`, `ui/`, `adapter/`, `config/`, `cli/`, `perf/`, `solid-js`, `@opentui/*`, `@opencode/*`, or Node I/O (`fs*`, `net`, `http*`, `https`, `tls`, `dgram`, `dns` — bare or `node:` — plus `bun:sqlite`) | Domain logic is pure and reusable; owning wire, storage or render state here is the coupling the audit asks to remove. |
| `src/adapter/` | `app/`, `ui/`, `solid-js`, `@opentui/*` | The adapter owns wire conversion and transport. Calling upward into application or view state hides ownership in the transport layer. `@opencode/client` is expected here. |
| `src/ui/` | `@opencode/*`, and Node network modules (`net`, `http*`, `https`, `tls`, `dgram`, `dns` — bare or `node:` — plus direct `fetch(...)`) | Views must not speak the wire protocol or issue transport RPCs; they call application actions. Solid and OpenTUI imports are expected in this layer. |

These are the machine-checkable categories from issue #307. They are a ratchet,
not a claim that architecture is already clean: the existing UI-to-`AppController`
type dependency described in `docs/marg-audit.md` and issue #318 is deliberately
out of scope for this gate and is owned by that extraction.

## New cycles

The checker computes strongly connected components over relative imports inside
`src/`. Cycles that already exist at the audit baseline are enumerated in
`scripts/architecture-baseline.json`. The gate fails when:

1. a cycle appears that is not in the baseline (**new coupling**), or
2. the baseline lists a cycle that no longer exists (**stale baseline**).

The second rule forces each extraction PR to shrink the baseline instead of
leaving an increasingly meaningless allow-list. A cycle is canonically named by
its sorted module paths, so reordering imports does not change its identity.

## Review-only conventions

These matter, but a green `verify` does not establish them. Reviewers must check
them against the general standard (sections 3–8 and 15) and the language guide:

- one owner and one writer per mutable state family; explicit invalidation of
  derived caches (issues #305, #309, #316, #317);
- cohesive methods and a visible important path, not merely short files;
- correct failure, cancellation, duplicate-event and teardown behaviour;
- meaningful JSDoc for exported cross-module contracts (semantics, ownership,
  errors). The critical contracts `AppController`, `ControllerDeps`, `AppState`
  and `Backend` are documented first; the rest improves as their owners move;
- Google naming and interface preferences **for new code only** (see below).

## Deliberate exemptions and migration notes

The audit and issue #307 explicitly reject mechanical churn. Therefore:

- Wire-format keys such as `sessionID`, `serverID` and `messageID` keep their
  upstream spelling wherever they mirror `@opencode/client` DTOs or persisted
  JSON. The language guide permits names required by an external contract; new
  purely internal identifiers use `serverId`-style casing.
- Existing `Readonly<{...}>` type aliases are not converted to interfaces in
  unrelated files. New exported object shapes follow the guide's interface
  preference.
- Generated code, JSX/Solid conventions and third-party APIs are exempt from
  rules they cannot satisfy; no `@ts-ignore`, blanket lint disables or weakened
  tests may be introduced to satisfy a check.
- Live OpenCode compatibility remains opt-in (`MARGARITA_LIVE=1`). PTY and
  performance checks are run in CI or by the dedicated scripts, not by
  `bun run verify`, and their results are reported separately.
