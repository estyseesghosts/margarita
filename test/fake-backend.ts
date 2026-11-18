import type {
  Backend,
  Delivery,
  DiffRange,
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
import type { FileDiff } from '../src/domain/diff.ts';
import type { FormRequest, FormValue } from '../src/domain/form.ts';
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
  forms: FormRequest[] = [];
  /** When set, the next permission reply fails with this error (second-client races). */
  replyError: Error | undefined;
  agents: AgentDescriptor[] = [];
  models: CatalogModel[] = [];
  readonly calls: { name: string; args: unknown[] }[] = [];

  /** When set, listSessions delegates here (paged/failable listing tests). */
  listSessionsHook?: (query: {
    cursor?: string;
    directory?: string;
    limit?: number;
  }) => Promise<SessionPage>;

  async listSessions(query?: {
    cursor?: string;
    directory?: string;
    limit?: number;
  }): Promise<SessionPage> {
    if (this.listSessionsHook !== undefined) return this.listSessionsHook(query ?? {});
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
  async backgroundTools(sessionID: string): Promise<void> {
    this.calls.push({ name: 'backgroundTools', args: [sessionID] });
  }
  async interrupt(sessionID: string): Promise<boolean> {
    this.calls.push({ name: 'interrupt', args: [sessionID] });
    return true;
  }
  diffs: FileDiff[] = [];
  revertFiles: FileDiff[] = [];
  /** When set, instruction writes fail (server without the experimental route). */
  instructionsUnavailable = false;
  /** When set, instruction removal fails (transport drop or permission error). */
  removeInstructionError: Error | undefined;

  async sessionDiff(sessionID: string, range: DiffRange): Promise<FileDiff[]> {
    this.calls.push({ name: 'sessionDiff', args: [sessionID, range] });
    return this.diffs;
  }
  async renameSession(sessionID: string, title: string): Promise<void> {
    this.calls.push({ name: 'renameSession', args: [sessionID, title] });
    this.sessions = this.sessions.map((session) =>
      session.id === sessionID ? { ...session, title } : session,
    );
  }
  async forkSession(sessionID: string, beforeMessageID?: string): Promise<SessionSummary> {
    this.calls.push({ name: 'forkSession', args: [sessionID, beforeMessageID] });
    const source = await this.getSession(sessionID);
    const fork: SessionSummary = { ...source, id: `${sessionID}_fork`, createdAt: 5, updatedAt: 5 };
    this.sessions.push(fork);
    return fork;
  }
  async stageRevert(sessionID: string, messageID: string): Promise<FileDiff[]> {
    this.calls.push({ name: 'stageRevert', args: [sessionID, messageID] });
    return this.revertFiles;
  }
  async commitRevert(sessionID: string): Promise<void> {
    this.calls.push({ name: 'commitRevert', args: [sessionID] });
  }
  async clearRevert(sessionID: string): Promise<void> {
    this.calls.push({ name: 'clearRevert', args: [sessionID] });
  }
  async putInstruction(sessionID: string, key: string, value: string): Promise<void> {
    this.calls.push({ name: 'putInstruction', args: [sessionID, key, value] });
    if (this.instructionsUnavailable) throw new Error('NotFound');
  }
  async removeInstruction(sessionID: string, key: string): Promise<void> {
    this.calls.push({ name: 'removeInstruction', args: [sessionID, key] });
    if (this.removeInstructionError !== undefined) throw this.removeInstructionError;
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
  async listForms(sessionID: string): Promise<FormRequest[]> {
    return this.forms.filter((form) => form.sessionID === sessionID);
  }
  async replyForm(
    sessionID: string,
    formID: string,
    answer: Record<string, FormValue>,
  ): Promise<void> {
    this.calls.push({ name: 'replyForm', args: [sessionID, formID, answer] });
    this.forms = this.forms.filter((form) => form.id !== formID);
  }
  async cancelForm(sessionID: string, formID: string): Promise<void> {
    this.calls.push({ name: 'cancelForm', args: [sessionID, formID] });
    this.forms = this.forms.filter((form) => form.id !== formID);
  }
  async replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionDecision,
  ): Promise<void> {
    this.calls.push({ name: 'replyPermission', args: [sessionID, requestID, decision] });
    const failure = this.replyError;
    this.replyError = undefined;
    if (failure !== undefined) throw failure;
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
