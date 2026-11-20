# Side questions (`/btw`): capability gap

## Determination

**No — the pinned OpenCode v2.3.x HTTP API does not expose a terminal-client-callable side
question.** Margarita therefore does not implement `/btw`, and never will by faking it.

## Evidence

- Upstream changelog (`https://opencode.ai/changelog`) documents the `/btw` panel in the
  **desktop client**. That is a desktop UI surface, not evidence of an HTTP endpoint.
- Pinned SDK `@opencode/client@2.3.0` (`package.json`), generated surface
  `node_modules/@opencode/client/dist/promise/generated/types.d.ts` and
  `dist/effect/api/api.d.ts`:
  - `session.prompt` accepts `text`, `files`, `agents`, `delivery` and skill attachments —
    there is no side-question, transient-session or parent-session field.
  - The event union contains session/inbox/permission/form/compaction/revert events, but no
    side-question lifecycle event.
  - There is no `session.btw`, `question.*` or equivalent RPC method.
- Searches of the pinned SDK for `btw`, `side question`, `transient` and `parentSession`
  return no matches.

A cursor-based lookahead into the server binary would be guesswork about an unpublished
protocol, so it is deliberately out of scope.

## What Margarita does instead

`/btw` is registered as a frontend-local command solely so the client can answer honestly:
it shows a warning that side questions are desktop-only and that **nothing was sent**. It
does not create a session, touch the running turn's inbox, queue or steer a prompt, or
claim isolation that the server does not provide. This satisfies the issue's unsupported
path: the UI never advertises `/btw` as working.

## Revisit criteria

Implement a real side-question surface only if a future SDK exposes a stable endpoint that
can be shown to: (1) run without mutating or steering the parent execution, (2) report its
own cost and identity, and (3) be cancelled independently. Tests must assert all three.
