# 08 — Server adapter and public API map

## Why a thin adapter is mandatory

`@opencode/client` generates methods from the HTTP contract. Use the public methods, not imports from OpenCode's internal core. All SDK-specific shapes live within `packages/adapter`, so model/endpoint changes do not leak into rendering. The official SDK documentation shows `OpenCode.make({baseUrl,headers})`, `client.session.create({location:{directory}})` and `client.session.prompt({sessionID,text})`. [Source](https://opencode.ai/docs/build/client).

### Proposed frontend adapter interface (NOT actual SDK declarations)

```ts
interface BackendAdapter {
  connect(opts: ConnectOptions): Promise<Connection>;
  getCatalog(location: LocationRef): Promise<Catalog>;
  listSessions(q: SessionQuery): Promise<Page<SessionSummary>>;
  createSession(args: {directory: string; parentID?: string}): Promise<SessionSummary>;
  getSession(key: SessionKey): Promise<SessionSummary>;
  listMessages(key: SessionKey, cursor?: string): Promise<Page<Message>>;
  listInbox(key: SessionKey): Promise<InboxItem[]>;
  sendPrompt(key: SessionKey, data: PromptDraft, delivery: 'queue'|'steer'): Promise<Admission>;
  changeDelivery(key: SessionKey, itemID: string, mode: 'queue'|'steer'): Promise<void>;
  cancelQueued(key: SessionKey, itemID: string): Promise<void>;
  switchAgent(key: SessionKey, agentID: string): Promise<void>;
  switchModel(key: SessionKey, model: ModelSelection): Promise<void>;
  getPermissions(key: SessionKey): Promise<PermissionRequest[]>;
  answerPermission(key: SessionKey, id: string, answer: PermissionReply): Promise<void>;
  getForms(key: SessionKey): Promise<FormRequest[]>;
  interrupt(key: SessionKey): Promise<boolean>;
  getDiff(key: SessionKey, range?: TurnRange): Promise<FileDiff[]>;
  getContext(key: SessionKey): Promise<ContextState>;
  putInstruction(key: SessionKey, name: string, text: string): Promise<void>;
  subscribe(signal: AbortSignal): AsyncIterable<BackendEvent>;
}
```

Methods/names are **project-level abstractions**; bind to exact generated client signatures after an SDK probe. Avoid mocking `@opencode/client` in ways that conceal SDK changes.

## Endpoint map (official v2.3.0 API)

| UI operation | HTTP route | Operation ID | Notes |
| --- | --- | --- | --- |
| List projects/sessions | `GET /api/session` | `session.list` | directory/project filters, cursor, archived |
| Create session | `POST /api/session` | `session.create` | location body |
| Read session | `GET /api/session/{sessionID}` | `session.get` | `Session.Info` includes cost/tokens |
| Change agent | `POST /api/session/{sessionID}/agent` | `session.switchAgent` | server authoritative |
| Change model | `POST /api/session/{sessionID}/model` | `session.switchModel` | variant support to confirm |
| Send prompt | `POST /api/session/{sessionID}/prompt` | `session.prompt` | durable admission, `queue`/`steer` semantics |
| List inbox | `GET /api/session/{sessionID}/inbox` | `session.inbox.list` | ordered pending work |
| Change queued delivery | `PATCH /api/session/{sessionID}/inbox/{inboxID}` | `session.inbox.update` | changes to steer/queue |
| Cancel queued item | `DELETE /api/session/{sessionID}/inbox/{inboxID}` | `session.inbox.cancel` | undelivered only |
| List messages | `GET /api/session/{sessionID}/message` | `session.message.list` | cursor, `type` filter |
| Get one message | `GET /api/session/{sessionID}/message/{messageID}` | `session.message.get` | recovery / lazy detail |
| Session context | `GET /api/session/{sessionID}/context` | `session.context` | after latest compaction |
| Diff | `GET /api/session/{sessionID}/diff` | `session.diff` | turn boundaries and working copy semantics |
| Interrupt | `POST /api/session/{sessionID}/interrupt` | `session.interrupt` | interrupted:boolean |
| Background running tools | `POST /api/session/{sessionID}/background` | `session.background` | **NOT** UI detach |
| Forms | `GET /api/session/{sessionID}/form` | `session.form.list` | pending interactive forms |
| Permissions | `GET /api/session/{sessionID}/permission` | `session.permission.list` | pending approvals |
| Run slash callback | `POST /api/session/{sessionID}/command` | `session.command` | server-defined command |
| Agent catalog | `GET /api/agent` | `agent.list` | location scoped |
| Model catalog | `GET /api/model` | `model.list` | snapshots can precede plugin settlement |
| Default model | `GET /api/model/default` | `model.default` | location scoped |
| Provider catalog | `GET /api/provider` | `provider.list` | list active providers |
| Event stream | `GET /api/event` | `event.subscribe` | volatile, global locations |
| Optional event log | `GET /api/experimental/session/{sessionID}/log` | `experimental.session.log` | experimental, sequence-based |
| Durable session instructions | `PUT /api/experimental/session/{sessionID}/instructions/entries/{key}` | `experimental.session.instructions.entry.put` | optional goals sync |
| Fork | `POST /api/session/{sessionID}/fork` | `session.fork` | copy before message |
| Revert | `/api/session/{sessionID}/revert/*` | `session.revert.*` | staged/commit, protect against concurrent edits |

Every item above is grounded in [OpenCode API](https://opencode.ai/docs/api). For SDK method call names, trust generated package exports, not HTTP operation IDs as guessed camelCase aliases.

## Model selection, effort and agents

The OpenCode model syntax is `provider/model#variant`, and its catalog's variants can be model-specific. The frontend resolves the CLI selector and uses the SDK's supported model-selection type. If the SDK switch-model request doesn't propagate a variant, submit a provider/model and variant only through a validated supported method; **don't insert prose like “think high” into prompt as a substitute for `high` effort.** [Models](https://opencode.ai/docs/models/).

## Event adapter and event buffer

Use a single shared event connection per backend process. The SDK event subscription is an async iterable with backpressure and **no replay or auto-reconnect**. Do not perform view rendering directly inside event iteration:

```ts
// Pseudocode only: explicit async bounded queue and resync policy required.
async function readEvents(source: AsyncIterable<BackendEvent>, sink: EventBuffer) {
  try {
    for await (const event of source) sink.push(event);
  } catch (err) {
    sink.markDisconnected(err);
  }
}
```

`EventBuffer` drains in batches to domain reducers; overflow triggers hard resync from session/messages/inbox. The event source may emit many concurrent projects, so project/session filtering happens after buffering, not by assuming current route. [SDK SSE semantics](https://opencode.ai/docs/build/client).

## Errors and idempotency

`400`: validate payload/action, explain; `401`: auth/credential problem; `404`: deleted or inaccessible session, preserve unsent draft and return to overview; `409`: concurrent update/session busy or invalid state, refetch and offer retry; `503`: server unhealthy, reconnect display. A request timeout after POST does not mean operation failed. Reconcile by checking inbox/messages and known IDs before retrying to avoid duplicate prompts. Generate local attempt IDs for diagnostics only; never claim server idempotency keys unless verified.

## Transport and authentication

Remote `--server` implies an explicit host URL; attach bearer auth only through secure environment/config, not in shell history or logs. Do not send private project paths to an unknown endpoint without confirming destination. Default local `Service.ensure()` discovers a shared daemon and provides headers via `Service.headers(endpoint)`; verify Bun + Windows support. [Client docs](https://opencode.ai/docs/build/client).

## Compatibility probe checklist

At startup query `server.info`, agent/model/provider catalogs, sample session list. During test run create a harmless temporary session, post a prompt to a test provider only with user opt-in, verify events, inbox, session usage, and cleanup. Avoid automatic paid model calls in startup compatibility checks.
