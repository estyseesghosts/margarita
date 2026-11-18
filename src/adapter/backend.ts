import { ClientError, OpenCode, type OpenCodeClient } from '@opencode/client';

import type { AgentDescriptor } from '../domain/agent-cycle.ts';
import { type BackendEvent, normalizeEvent } from '../domain/backend-event.ts';
import type { FileDiff } from '../domain/diff.ts';
import type { FormRequest, FormValue } from '../domain/form.ts';
import type { ModelSelection } from '../domain/model-ref.ts';
import type { CatalogModel } from '../domain/model-resolution.ts';
import { type NativeGoal, toNativeGoal } from '../domain/native-goal.ts';
import { localServerID } from '../domain/server-identity.ts';
import type { SessionSummary } from '../domain/session.ts';
import type { TranscriptMessage } from '../domain/transcript.ts';
import type { Connection } from './connection.ts';
import {
  maxToolOutputChars,
  type PermissionPrompt,
  type QueuedInput,
  toAgentDescriptor,
  toCatalogModel,
  toFileDiff,
  toFormRequest,
  toModelSelection,
  toPermissionPrompt,
  toQueuedInput,
  toSessionSummary,
  toTranscriptMessage,
} from './wire-mapping.ts';

export type { PermissionPrompt, QueuedInput } from './wire-mapping.ts';
export type { NativeGoal } from '../domain/native-goal.ts';

export type BackendErrorKind =
  'not-found' | 'conflict' | 'unauthorized' | 'invalid' | 'transport' | 'unknown';

/** Normalized backend failure. Never converted into a pretend success. */
export class BackendError extends Error {
  override readonly name = 'BackendError';
  constructor(
    readonly kind: BackendErrorKind,
    readonly operation: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${operation}: ${message}`, options);
  }
}

export type SessionPage = Readonly<{ sessions: SessionSummary[]; nextCursor?: string }>;
export type MessagePage = Readonly<{ messages: TranscriptMessage[]; olderCursor?: string }>;
/** Message IDs bounding a diff; both open-ended when omitted. */
export type DiffRange = Readonly<{ from?: string; to?: string }>;
export type Delivery = 'queue' | 'steer';
export type PermissionDecision = 'once' | 'always' | 'reject';

/** A prompt file: a `file:`/`data:` URI plus the optional `@mention` range it came from. */
export type PromptFile = Readonly<{
  uri: string;
  name: string;
  mention?: { start: number; end: number; text: string };
}>;

export type PromptDraft = Readonly<{
  text: string;
  files: readonly PromptFile[];
  /** Omitted when idle; while running the server needs an explicit queue/steer choice. */
  delivery?: Delivery;
}>;

/** The narrow set of server operations the frontend needs; see docs/08-server-adapter.md. */
export interface Backend {
  readonly baseUrl: string;
  listSessions(query: {
    cursor?: string;
    directory?: string;
    limit?: number;
  }): Promise<SessionPage>;
  getSession(sessionID: string): Promise<SessionSummary>;
  createSession(args: {
    directory: string;
    agent?: string;
    model?: ModelSelection;
  }): Promise<SessionSummary>;
  activeSessionIDs(): Promise<Set<string>>;
  listMessages(sessionID: string, limit: number, cursor?: string): Promise<MessagePage>;
  listInbox(sessionID: string): Promise<QueuedInput[]>;
  cancelQueued(sessionID: string, inboxID: string): Promise<void>;
  /** Server-side fuzzy file search scoped to `directory`; used for remote `@` mentions. */
  findProjectFiles(directory: string, query: string, limit: number): Promise<string[]>;
  changeDelivery(sessionID: string, inboxID: string, delivery: Delivery): Promise<void>;
  prompt(sessionID: string, draft: PromptDraft): Promise<QueuedInput>;
  runCommand(sessionID: string, name: string, text: string): Promise<void>;
  runShell(sessionID: string, command: string): Promise<void>;
  interrupt(sessionID: string): Promise<boolean>;
  /** Native OpenCode v2 session compaction; accepted ≠ complete. */
  compactSession(sessionID: string, requestID?: string): Promise<void>;
  /** Detaches running tool calls so the turn continues while they finish. */
  backgroundTools(sessionID: string): Promise<void>;
  sessionDiff(sessionID: string, range: DiffRange): Promise<FileDiff[]>;
  renameSession(sessionID: string, title: string): Promise<void>;
  forkSession(sessionID: string, beforeMessageID?: string): Promise<SessionSummary>;
  /** Stages a revert to just before `messageID`; returns the files it would restore. */
  stageRevert(sessionID: string, messageID: string): Promise<FileDiff[]>;
  commitRevert(sessionID: string): Promise<void>;
  clearRevert(sessionID: string): Promise<void>;
  /** Model-visible durable instruction entry (experimental server API). */
  putInstruction(sessionID: string, key: string, value: string): Promise<void>;
  removeInstruction(sessionID: string, key: string): Promise<void>;
  switchAgent(sessionID: string, agent: string): Promise<void>;
  switchModel(sessionID: string, model: ModelSelection): Promise<void>;
  listAgents(directory: string): Promise<AgentDescriptor[]>;
  listModels(directory: string): Promise<CatalogModel[]>;
  defaultModel(directory: string): Promise<ModelSelection | undefined>;
  listCommands(directory: string): Promise<ServerCommand[]>;
  listPermissions(sessionID: string): Promise<PermissionPrompt[]>;
  listForms(sessionID: string): Promise<FormRequest[]>;
  replyForm(sessionID: string, formID: string, answer: Record<string, FormValue>): Promise<void>;
  /** Native OpenCode goal for the session (plugin RPC `opencode.goal/get`); null when unset. */
  getGoal(sessionID: string, directory?: string): Promise<NativeGoal | null>;
  cancelForm(sessionID: string, formID: string): Promise<void>;
  replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionDecision,
  ): Promise<void>;
  /** Live-only stream; ends or throws on disconnect. Caller owns reconnection. */
  events(signal: AbortSignal): AsyncIterable<BackendEvent>;
}

export type ServerCommand = Readonly<{ name: string; description?: string }>;

export type BackendOptions = Readonly<{
  /** Margarita-managed server identity stamped onto every session summary. */
  serverID?: string;
  /** Output cap (characters, head+tail) applied when mapping tool output. */
  toolOutputChars?: number;
}>;

export function createBackend(connection: Connection, options: BackendOptions = {}): Backend {
  const client: OpenCodeClient = OpenCode.make({
    baseUrl: connection.baseUrl,
    headers: { ...connection.headers },
  });
  return new OpenCodeBackend(client, connection.baseUrl, options);
}

class OpenCodeBackend implements Backend {
  constructor(
    private readonly client: OpenCodeClient,
    readonly baseUrl: string,
    private readonly options: BackendOptions = {},
  ) {}

  private summary(info: Parameters<typeof toSessionSummary>[0]): SessionSummary {
    return toSessionSummary(info, this.options.serverID ?? localServerID);
  }

  async listSessions(query: {
    cursor?: string;
    directory?: string;
    limit?: number;
  }): Promise<SessionPage> {
    const page = await call('session.list', () =>
      this.client.session.list({
        order: 'desc',
        limit: query.limit ?? 100,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.directory === undefined ? {} : { directory: query.directory }),
      }),
    );
    const next = page.cursor.next;
    return {
      sessions: page.data.map((info) => this.summary(info)),
      ...(typeof next === 'string' && next !== '' ? { nextCursor: next } : {}),
    };
  }

  async getSession(sessionID: string): Promise<SessionSummary> {
    return this.summary(await call('session.get', () => this.client.session.get({ sessionID })));
  }

  async createSession(args: {
    directory: string;
    agent?: string;
    model?: ModelSelection;
  }): Promise<SessionSummary> {
    const info = await call('session.create', () =>
      this.client.session.create({
        location: { directory: args.directory },
        ...(args.agent === undefined ? {} : { agent: args.agent }),
        ...(args.model === undefined ? {} : { model: toWireModel(args.model) }),
      }),
    );
    return this.summary(info);
  }

  async activeSessionIDs(): Promise<Set<string>> {
    const active = await call('session.active', () => this.client.session.active());
    return new Set(Object.keys(active));
  }

  async listMessages(sessionID: string, limit: number, cursor?: string): Promise<MessagePage> {
    const page = await call('message.list', () =>
      // The server rejects `order` together with a cursor: the cursor already encodes both the
      // order and the direction of the page it came from.
      this.client.message.list({
        sessionID,
        limit,
        ...(cursor === undefined ? { order: 'desc' as const } : { cursor }),
      }),
    );
    const messages = page.data
      .map((message) =>
        toTranscriptMessage(message, {
          maxToolOutputChars: this.options.toolOutputChars ?? maxToolOutputChars,
        }),
      )
      .filter((message) => message !== undefined)
      .toReversed();
    const older = page.cursor.next;
    return {
      messages,
      ...(typeof older === 'string' && older !== '' ? { olderCursor: older } : {}),
    };
  }

  async findProjectFiles(directory: string, query: string, limit: number): Promise<string[]> {
    if (query.trim() === '') return [];
    const result = await call('file.find', () =>
      this.client.file.find({
        query,
        type: 'file',
        limit,
        location: { directory },
      }),
    );
    return result.data.map((entry) => entry.path);
  }

  async listInbox(sessionID: string): Promise<QueuedInput[]> {
    const items = await call('session.inbox.list', () =>
      this.client.session.inbox.list({ sessionID }),
    );
    return items.map(toQueuedInput);
  }

  async cancelQueued(sessionID: string, inboxID: string): Promise<void> {
    await call('session.inbox.cancel', () =>
      this.client.session.inbox.cancel({ sessionID, inboxID }),
    );
  }

  async changeDelivery(sessionID: string, inboxID: string, delivery: Delivery): Promise<void> {
    await call('session.inbox.update', () =>
      this.client.session.inbox.update({ sessionID, inboxID, delivery }),
    );
  }

  async prompt(sessionID: string, draft: PromptDraft): Promise<QueuedInput> {
    const admitted = await call('session.prompt', () =>
      this.client.session.prompt({
        sessionID,
        text: draft.text,
        ...(draft.delivery === undefined ? {} : { delivery: draft.delivery }),
        ...(draft.files.length === 0
          ? {}
          : {
              files: draft.files.map((file) => ({
                uri: file.uri,
                name: file.name,
                ...(file.mention === undefined ? {} : { mention: file.mention }),
              })),
            }),
      }),
    );
    return toQueuedInput(admitted);
  }

  async runCommand(sessionID: string, name: string, text: string): Promise<void> {
    await call('session.command', () => this.client.session.command({ sessionID, name, text }));
  }

  async runShell(sessionID: string, command: string): Promise<void> {
    await call('session.shell', () => this.client.session.shell({ sessionID, command }));
  }

  async interrupt(sessionID: string): Promise<boolean> {
    const result = await call('session.interrupt', () =>
      this.client.session.interrupt({ sessionID }),
    );
    return result.interrupted;
  }

  /**
   * Native v2 compaction (`POST /api/session/{sessionID}/compact`, the same operation the
   * first-party TUI's /compact uses). The reply confirms acceptance, not completion:
   * progress arrives via session.compaction.* events and the compaction message itself.
   */
  async compactSession(sessionID: string, requestID?: string): Promise<void> {
    await call('session.compact', () =>
      this.client.session.compact({
        sessionID,
        ...(requestID === undefined ? {} : { id: requestID }),
      }),
    );
  }

  async backgroundTools(sessionID: string): Promise<void> {
    await call('session.background', () => this.client.session.background({ sessionID }));
  }

  async sessionDiff(sessionID: string, range: DiffRange): Promise<FileDiff[]> {
    const files = await call('session.diff', () =>
      this.client.session.diff({
        sessionID,
        ...(range.from === undefined ? {} : { from: range.from }),
        ...(range.to === undefined ? {} : { to: range.to }),
      }),
    );
    return files.map(toFileDiff);
  }

  async renameSession(sessionID: string, title: string): Promise<void> {
    await call('session.update', () => this.client.session.update({ sessionID, title }));
  }

  async forkSession(sessionID: string, beforeMessageID?: string): Promise<SessionSummary> {
    const info = await call('session.fork', () =>
      this.client.session.fork({
        sessionID,
        ...(beforeMessageID === undefined ? {} : { before: beforeMessageID }),
      }),
    );
    return this.summary(info);
  }

  async stageRevert(sessionID: string, messageID: string): Promise<FileDiff[]> {
    const revert = await call('session.revert.stage', () =>
      this.client.session.revert.stage({ sessionID, messageID, files: true }),
    );
    return (revert.files ?? []).map(toFileDiff);
  }

  async commitRevert(sessionID: string): Promise<void> {
    await call('session.revert.commit', () => this.client.session.revert.commit({ sessionID }));
  }

  async clearRevert(sessionID: string): Promise<void> {
    await call('session.revert.clear', () => this.client.session.revert.clear({ sessionID }));
  }

  async putInstruction(sessionID: string, key: string, value: string): Promise<void> {
    await call('session.instructions.entry.put', () =>
      this.client.experimental.session.instructions.entry.put({ sessionID, key, value }),
    );
  }

  async removeInstruction(sessionID: string, key: string): Promise<void> {
    await call('session.instructions.entry.remove', () =>
      this.client.experimental.session.instructions.entry.remove({ sessionID, key }),
    );
  }

  async switchAgent(sessionID: string, agent: string): Promise<void> {
    await call('session.switchAgent', () => this.client.session.switchAgent({ sessionID, agent }));
  }

  async switchModel(sessionID: string, model: ModelSelection): Promise<void> {
    await call('session.switchModel', () =>
      this.client.session.switchModel({ sessionID, model: toWireModel(model) }),
    );
  }

  async listAgents(directory: string): Promise<AgentDescriptor[]> {
    const scoped = await call('agent.list', () =>
      this.client.agent.list({ location: { directory } }),
    );
    if (scoped.data.length > 0) return scoped.data.map(toAgentDescriptor);
    // Observed on v2.3.0: a location-scoped query can come back empty; fall back to global.
    const global = await call('agent.list', () => this.client.agent.list());
    return global.data.map(toAgentDescriptor);
  }

  async listModels(directory: string): Promise<CatalogModel[]> {
    const models = await call('model.list', () =>
      this.client.model.list({ location: { directory } }),
    );
    return models.data.map(toCatalogModel);
  }

  async defaultModel(directory: string): Promise<ModelSelection | undefined> {
    const result = await call('model.default', () =>
      this.client.model.default({ location: { directory } }),
    );
    if (result.data === null) return undefined;
    return toModelSelection({ id: result.data.id, providerID: result.data.providerID });
  }

  async listCommands(directory: string): Promise<ServerCommand[]> {
    const result = await call('command.list', () =>
      this.client.command.list({ location: { directory } }),
    );
    return result.data
      .filter((entry) => typeof entry.name === 'string')
      .map((entry) => ({
        name: entry.name,
        ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      }));
  }

  async listPermissions(sessionID: string): Promise<PermissionPrompt[]> {
    const requests = await call('permission.list', () =>
      this.client.permission.list({ sessionID }),
    );
    return requests.map(toPermissionPrompt);
  }

  async listForms(sessionID: string): Promise<FormRequest[]> {
    const forms = await call('session.form.list', () =>
      this.client.session.form.list({ sessionID }),
    );
    return forms.map(toFormRequest);
  }

  async replyForm(
    sessionID: string,
    formID: string,
    answer: Record<string, FormValue>,
  ): Promise<void> {
    await call('session.form.reply', () =>
      this.client.session.form.reply({ sessionID, formID, answer }),
    );
  }

  async cancelForm(sessionID: string, formID: string): Promise<void> {
    await call('session.form.cancel', () => this.client.session.form.cancel({ sessionID, formID }));
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionDecision,
  ): Promise<void> {
    await call('permission.reply', () =>
      this.client.permission.reply({ sessionID, requestID, decision }),
    );
  }

  /**
   * Native goal plugin's RPC, read-only. The plugin answers `null` when no goal is set; a
   * server without the plugin (or one that cannot reach it) raises and this surfaces as the
   * upstream error — callers treat it as "no goal to show", matching first-party behavior.
   */
  async getGoal(sessionID: string, directory?: string): Promise<NativeGoal | null> {
    // The first-party TUI scopes this RPC to the session's own project; the startup cwd is
    // wrong whenever another project's session is open.
    const result = await call('opencode.goal.get', () =>
      this.client.rpc.call({
        rpcID: 'opencode.goal',
        method: 'get',
        input: { sessionID },
        ...(directory === undefined ? {} : { location: { directory } }),
      }),
    );
    return toNativeGoal(result.output);
  }

  async *events(signal: AbortSignal): AsyncIterable<BackendEvent> {
    try {
      for await (const raw of this.client.event.subscribe({ signal })) {
        const event = normalizeEvent(raw);
        if (event !== undefined) yield event;
      }
    } catch (cause) {
      if (signal.aborted) return;
      throw toBackendError('event.subscribe', cause);
    }
  }
}

function toWireModel(model: ModelSelection): { id: string; providerID: string; variant?: string } {
  return {
    id: model.modelID,
    providerID: model.providerID,
    ...(model.variant === undefined ? {} : { variant: model.variant }),
  };
}

async function call<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw toBackendError(operation, cause);
  }
}

/**
 * Maps the SDK's declared error bodies (errors with a `_tag`) and transport
 * failures onto stable kinds. Anything we cannot positively identify stays
 * `unknown` rather than being guessed into a success-adjacent bucket.
 */
export function toBackendError(operation: string, cause: unknown): BackendError {
  if (cause instanceof BackendError) return cause;
  const tag = errorTag(cause);
  if (tag !== undefined) {
    return new BackendError(kindForTag(tag), operation, messageOf(cause) ?? tag, { cause });
  }
  if (cause instanceof ClientError) {
    if (cause.reason === 'Transport') {
      return new BackendError('transport', operation, cause.message, { cause });
    }
    if (cause.reason === 'UnexpectedStatus') {
      const status = statusOf(cause);
      return new BackendError(kindForStatus(status), operation, cause.message, { cause });
    }
    return new BackendError('unknown', operation, cause.message, { cause });
  }
  if (cause instanceof Error) {
    return new BackendError('unknown', operation, cause.message || cause.name, { cause });
  }
  return new BackendError('unknown', operation, String(cause), { cause });
}

/** The SDK's declared errors carry `_tag` as an own property and as `name`. */
function errorTag(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  if (cause instanceof ClientError) return undefined;
  const tag = Reflect.get(cause, '_tag');
  if (typeof tag === 'string' && tag !== '') return tag;
  if (cause instanceof Error && cause.name !== 'Error' && cause.name !== '') {
    return cause.name;
  }
  return undefined;
}

const conflictTags = new Set(['ConflictError', 'SessionBusyError', 'FormAlreadySettledError']);
const unauthorizedTags = new Set(['UnauthorizedError', 'ForbiddenError']);
const invalidTags = new Set([
  'InvalidRequestError',
  'InvalidCursorError',
  'FormInvalidAnswerError',
  'UnsupportedModelError',
  'InstructionEntryValueTooLargeError',
]);
const transportTags = new Set(['ServiceUnavailableError', 'RpcError', 'RpcInternalError']);

function kindForTag(tag: string): BackendErrorKind {
  if (tag.endsWith('NotFoundError')) return 'not-found';
  if (conflictTags.has(tag)) return 'conflict';
  if (unauthorizedTags.has(tag)) return 'unauthorized';
  if (invalidTags.has(tag)) return 'invalid';
  if (transportTags.has(tag)) return 'transport';
  return 'unknown';
}

function kindForStatus(status: number | undefined): BackendErrorKind {
  if (status === undefined) return 'unknown';
  if (status === 400 || status === 422) return 'invalid';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 502 || status === 503 || status === 504) return 'transport';
  return 'unknown';
}

/** UnexpectedStatus carries the status on `cause.cause.status` and in `detail`. */
function statusOf(cause: ClientError): number | undefined {
  const inner = cause.cause;
  if (typeof inner === 'object' && inner !== null) {
    const status = Reflect.get(inner, 'status');
    if (typeof status === 'number' && Number.isFinite(status)) return status;
  }
  const detail = cause.message.replace(/^UnexpectedStatus:\s*/, '');
  const parsed = Number.parseInt(detail, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function messageOf(cause: unknown): string | undefined {
  if (cause instanceof Error && cause.message !== '') return cause.message;
  if (typeof cause === 'object' && cause !== null) {
    const message = Reflect.get(cause, 'message');
    if (typeof message === 'string' && message !== '') return message;
  }
  return undefined;
}
