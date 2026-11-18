import { ClientError, OpenCode, type OpenCodeClient } from '@opencode/client';

import type { AgentDescriptor } from '../domain/agent-cycle.ts';
import { type BackendEvent, normalizeEvent } from '../domain/backend-event.ts';
import type { FormRequest, FormValue } from '../domain/form.ts';
import type { ModelSelection } from '../domain/model-ref.ts';
import type { CatalogModel } from '../domain/model-resolution.ts';
import type { SessionSummary } from '../domain/session.ts';
import type { TranscriptMessage } from '../domain/transcript.ts';
import type { Connection } from './connection.ts';
import {
  type PermissionPrompt,
  type QueuedInput,
  toAgentDescriptor,
  toCatalogModel,
  toFormRequest,
  toModelSelection,
  toPermissionPrompt,
  toQueuedInput,
  toSessionSummary,
  toTranscriptMessage,
} from './wire-mapping.ts';

export type { PermissionPrompt, QueuedInput } from './wire-mapping.ts';

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
export type Delivery = 'queue' | 'steer';
export type PermissionDecision = 'once' | 'always' | 'reject';

/** A file reference: `file://` URI plus the `@mention` range it came from. */
export type PromptFile = Readonly<{
  uri: string;
  name: string;
  start: number;
  end: number;
  text: string;
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
  changeDelivery(sessionID: string, inboxID: string, delivery: Delivery): Promise<void>;
  prompt(sessionID: string, draft: PromptDraft): Promise<QueuedInput>;
  runCommand(sessionID: string, name: string, text: string): Promise<void>;
  runShell(sessionID: string, command: string): Promise<void>;
  interrupt(sessionID: string): Promise<boolean>;
  switchAgent(sessionID: string, agent: string): Promise<void>;
  switchModel(sessionID: string, model: ModelSelection): Promise<void>;
  listAgents(directory: string): Promise<AgentDescriptor[]>;
  listModels(directory: string): Promise<CatalogModel[]>;
  defaultModel(directory: string): Promise<ModelSelection | undefined>;
  listCommands(directory: string): Promise<ServerCommand[]>;
  listPermissions(sessionID: string): Promise<PermissionPrompt[]>;
  listForms(sessionID: string): Promise<FormRequest[]>;
  replyForm(sessionID: string, formID: string, answer: Record<string, FormValue>): Promise<void>;
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

export function createBackend(connection: Connection): Backend {
  const client: OpenCodeClient = OpenCode.make({
    baseUrl: connection.baseUrl,
    headers: { ...connection.headers },
  });
  return new OpenCodeBackend(client, connection.baseUrl);
}

class OpenCodeBackend implements Backend {
  constructor(
    private readonly client: OpenCodeClient,
    readonly baseUrl: string,
  ) {}

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
      sessions: page.data.map(toSessionSummary),
      ...(typeof next === 'string' && next !== '' ? { nextCursor: next } : {}),
    };
  }

  async getSession(sessionID: string): Promise<SessionSummary> {
    return toSessionSummary(
      await call('session.get', () => this.client.session.get({ sessionID })),
    );
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
    return toSessionSummary(info);
  }

  async activeSessionIDs(): Promise<Set<string>> {
    const active = await call('session.active', () => this.client.session.active());
    return new Set(Object.keys(active));
  }

  async listMessages(sessionID: string, limit: number, cursor?: string): Promise<MessagePage> {
    const page = await call('message.list', () =>
      this.client.message.list({
        sessionID,
        limit,
        order: 'desc',
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    const messages = page.data
      .map(toTranscriptMessage)
      .filter((message) => message !== undefined)
      .toReversed();
    const older = page.cursor.next;
    return {
      messages,
      ...(typeof older === 'string' && older !== '' ? { olderCursor: older } : {}),
    };
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
                mention: { start: file.start, end: file.end, text: file.text },
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

export function toBackendError(operation: string, cause: unknown): BackendError {
  if (cause instanceof BackendError) return cause;
  if (cause instanceof ClientError) {
    const kind = cause.reason === 'Transport' ? 'transport' : 'unknown';
    return new BackendError(kind, operation, cause.message, { cause });
  }
  if (cause instanceof Error) {
    const tag = cause.name.toLowerCase();
    const kind: BackendErrorKind = tag.includes('notfound')
      ? 'not-found'
      : tag.includes('conflict') || tag.includes('busy')
        ? 'conflict'
        : tag.includes('unauthorized') || tag.includes('forbidden')
          ? 'unauthorized'
          : tag.includes('badrequest') || tag.includes('invalid') || tag.includes('validation')
            ? 'invalid'
            : 'unknown';
    return new BackendError(kind, operation, cause.message || cause.name, { cause });
  }
  return new BackendError('unknown', operation, String(cause), { cause });
}
