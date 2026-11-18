import type {
  Backend,
  Delivery,
  MessagePage,
  PermissionDecision,
  PermissionPrompt,
  PromptDraft,
  QueuedInput,
  ServerCommand,
  SessionPage,
} from '../src/adapter/backend.ts';
import type { AgentDescriptor } from '../src/domain/agent-cycle.ts';
import type { BackendEvent } from '../src/domain/backend-event.ts';
import type { ModelSelection } from '../src/domain/model-ref.ts';
import type { CatalogModel } from '../src/domain/model-resolution.ts';
import type { SessionSummary } from '../src/domain/session.ts';
import type { TranscriptMessage } from '../src/domain/transcript.ts';

/** In-memory backend for UI and controller tests. Records every mutating call. */
export class FakeBackend implements Backend {
  readonly baseUrl = 'http://fake';
  sessions: SessionSummary[] = [];
  messages: Record<string, TranscriptMessage[]> = {};
  active = new Set<string>();
  permissions: PermissionPrompt[] = [];
  agents: AgentDescriptor[] = [];
  models: CatalogModel[] = [];
  readonly calls: { name: string; args: unknown[] }[] = [];

  async listSessions(): Promise<SessionPage> {
    return { sessions: this.sessions };
  }
  async getSession(sessionID: string): Promise<SessionSummary> {
    const session = this.sessions.find((entry) => entry.id === sessionID);
    if (session === undefined) throw new Error('NotFound');
    return session;
  }
  async createSession(args: {
    directory: string;
    agent?: string;
    model?: ModelSelection;
  }): Promise<SessionSummary> {
    this.calls.push({ name: 'createSession', args: [args] });
    const session: SessionSummary = {
      id: `ses_${this.sessions.length + 1}`,
      projectID: 'p',
      directory: args.directory,
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    };
    this.sessions.push(session);
    return session;
  }
  async activeSessionIDs(): Promise<Set<string>> {
    return new Set(this.active);
  }
  /** Newest-first pages like the server; the cursor is the index where the page ends. */
  async listMessages(sessionID: string, limit: number, cursor?: string): Promise<MessagePage> {
    this.calls.push({ name: 'listMessages', args: [sessionID, limit, cursor] });
    const all = this.messages[sessionID] ?? [];
    const end = cursor === undefined ? all.length : Number(cursor);
    const start = Math.max(0, end - limit);
    return {
      messages: all.slice(start, end),
      ...(start > 0 ? { olderCursor: String(start) } : {}),
    };
  }
  async listInbox(): Promise<QueuedInput[]> {
    return [];
  }
  async cancelQueued(sessionID: string, inboxID: string): Promise<void> {
    this.calls.push({ name: 'cancelQueued', args: [sessionID, inboxID] });
  }
  async changeDelivery(sessionID: string, inboxID: string, delivery: Delivery): Promise<void> {
    this.calls.push({ name: 'changeDelivery', args: [sessionID, inboxID, delivery] });
  }
  async prompt(sessionID: string, draft: PromptDraft): Promise<QueuedInput> {
    this.calls.push({ name: 'prompt', args: [sessionID, draft] });
    return {
      id: 'in_1',
      kind: 'user',
      delivery: draft.delivery ?? 'queue',
      text: draft.text,
      createdAt: 1,
    };
  }
  async runCommand(sessionID: string, name: string, text: string): Promise<void> {
    this.calls.push({ name: 'runCommand', args: [sessionID, name, text] });
  }
  async runShell(sessionID: string, command: string): Promise<void> {
    this.calls.push({ name: 'runShell', args: [sessionID, command] });
  }
  async interrupt(sessionID: string): Promise<boolean> {
    this.calls.push({ name: 'interrupt', args: [sessionID] });
    return true;
  }
  async switchAgent(sessionID: string, agent: string): Promise<void> {
    this.calls.push({ name: 'switchAgent', args: [sessionID, agent] });
  }
  async switchModel(sessionID: string, model: ModelSelection): Promise<void> {
    this.calls.push({ name: 'switchModel', args: [sessionID, model] });
  }
  async listAgents(): Promise<AgentDescriptor[]> {
    return this.agents;
  }
  async listModels(): Promise<CatalogModel[]> {
    return this.models;
  }
  async defaultModel(): Promise<ModelSelection | undefined> {
    return undefined;
  }
  async listCommands(): Promise<ServerCommand[]> {
    return [];
  }
  async listPermissions(sessionID: string): Promise<PermissionPrompt[]> {
    return this.permissions.filter((permission) => permission.sessionID === sessionID);
  }
  async countForms(): Promise<number> {
    return 0;
  }
  async replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionDecision,
  ): Promise<void> {
    this.calls.push({ name: 'replyPermission', args: [sessionID, requestID, decision] });
    this.permissions = this.permissions.filter((permission) => permission.id !== requestID);
  }
  events(signal: AbortSignal): AsyncIterable<BackendEvent> {
    // Stays silent until aborted, like an idle live stream.
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<BackendEvent>>((resolve) =>
            signal.addEventListener('abort', () => resolve({ done: true, value: undefined })),
          ),
      }),
    };
  }
}
