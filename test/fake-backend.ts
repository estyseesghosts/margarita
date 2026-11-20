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
import { BackendError } from '../src/adapter/backend.ts';
import type { AgentDescriptor } from '../src/domain/agent-cycle.ts';
import type { BackendEvent } from '../src/domain/backend-event.ts';
import type { FileDiff } from '../src/domain/diff.ts';
import type { FormRequest, FormValue } from '../src/domain/form.ts';
import type { ModelSelection } from '../src/domain/model-ref.ts';
import type { CatalogModel } from '../src/domain/model-resolution.ts';
import type { NativeGoal } from '../src/domain/native-goal.ts';
import type { SessionSummary } from '../src/domain/session.ts';
import type { ShellJob } from '../src/domain/shell-job.ts';
import type { TranscriptMessage } from '../src/domain/transcript.ts';
import type { WorkerJob } from '../src/domain/worker.ts';

/** In-memory backend for UI and controller tests. Records every mutating call. */
export class FakeBackend implements Backend {
  /** Server identity stamped onto created sessions, like the production backend. */
  serverID = 'local';
  readonly baseUrl = 'http://fake';
  sessions: SessionSummary[] = [];
  messages: Record<string, TranscriptMessage[]> = {};
  /** Server-reported subagent jobs by parent session (#101). */
  jobs: Record<string, readonly WorkerJob[]> = {};
  shellJobs: Record<string, readonly ShellJob[]> = {};
  active = new Set<string>();
  permissions: PermissionPrompt[] = [];
  forms: FormRequest[] = [];
  /** When set, the next permission reply fails with this error (second-client races). */
  replyError: Error | undefined;
  agents: AgentDescriptor[] = [];
  models: CatalogModel[] = [];
  /** Configurable server-side file index returned by findProjectFiles. */
  remoteFiles: string[] = [];
  /** Configurable server-side directory index returned by findProjectDirectories. */
  remoteDirectories: string[] = [];
  readonly calls: { name: string; args: unknown[] }[] = [];

  /** When set, listSessions delegates here (paged/failable listing tests). */
  listSessionsHook?: (query: {
    cursor?: string;
    directory?: string;
    limit?: number;
  }) => Promise<SessionPage>;

  /** When set, createSession throws instead of creating (first-prompt admission tests). */
  createSessionError?: Error;
  /** When set, createSession delegates here (in-flight route-change tests). */
  createSessionHook?: (args: {
    directory: string;
    agent?: string;
    model?: ModelSelection;
  }) => Promise<SessionSummary>;
  /** When set, prompt throws instead of admitting (transport-failure tests). */
  promptError?: Error;

  /** When set, listAgents delegates here (catalog scoping/generation tests). */
  listAgentsHook?: () => Promise<AgentDescriptor[]>;

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
    if (session === undefined) {
      throw new BackendError('not-found', 'session.get', `No session ${sessionID}.`);
    }
    return session;
  }
  async createSession(args: {
    directory: string;
    agent?: string;
    model?: ModelSelection;
  }): Promise<SessionSummary> {
    this.calls.push({ name: 'createSession', args: [args] });
    if (this.createSessionHook !== undefined) return this.createSessionHook(args);
    if (this.createSessionError !== undefined) throw this.createSessionError;
    const session: SessionSummary = {
      id: `ses_${this.sessions.length + 1}`,
      serverID: this.serverID,
      projectID: 'p',
      directory: args.directory,
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      ...(args.agent === undefined ? {} : { agent: args.agent }),
      ...(args.model === undefined ? {} : { model: args.model }),
    };
    this.sessions.push(session);
    return session;
  }
  async activeSessionIDs(): Promise<Set<string>> {
    return new Set(this.active);
  }
  async listSubagentJobs(sessionID: string): Promise<readonly WorkerJob[]> {
    this.calls.push({ name: 'listSubagentJobs', args: [sessionID] });
    return this.jobs[sessionID] ?? [];
  }
  async listShellJobs(sessionID: string): Promise<readonly ShellJob[]> {
    this.calls.push({ name: 'listShellJobs', args: [sessionID] });
    return this.shellJobs[sessionID] ?? [];
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
      hasEarlier: start > 0,
    };
  }
  /** In-memory inbox; Margarita treats FIFO order as server order. */
  inbox: QueuedInput[] = [];
  /** Session each inbox item was enqueued for; items assigned directly default to ses_a. */
  inboxSession: Record<string, string> = {};
  /** When set, the next prompt/admission returns an item with this failure (test may override). */
  async listInbox(sessionID: string): Promise<QueuedInput[]> {
    this.calls.push({ name: 'listInbox', args: [sessionID] });
    return this.inbox
      .filter((item) => (this.inboxSession[item.id] ?? 'ses_a') === sessionID)
      .map((item) => ({ ...item }));
  }
  async cancelQueued(sessionID: string, inboxID: string): Promise<void> {
    this.calls.push({ name: 'cancelQueued', args: [sessionID, inboxID] });
    if (!this.inbox.some((item) => item.id === inboxID)) {
      throw new BackendError(
        'not-found',
        'session.inbox.cancel',
        `item ${inboxID} is not queued anymore`,
      );
    }
    this.inbox = this.inbox.filter((item) => item.id !== inboxID);
    delete this.inboxSession[inboxID];
  }
  async changeDelivery(sessionID: string, inboxID: string, delivery: Delivery): Promise<void> {
    this.calls.push({ name: 'changeDelivery', args: [sessionID, inboxID, delivery] });
    const index = this.inbox.findIndex((entry) => entry.id === inboxID);
    if (index < 0) {
      throw new BackendError(
        'not-found',
        'session.inbox.delivery-change',
        `item ${inboxID} is not queued anymore`,
      );
    }
    this.inbox[index] = { ...this.inbox[index]!, delivery };
  }
  async prompt(sessionID: string, draft: PromptDraft): Promise<QueuedInput> {
    this.calls.push({ name: 'prompt', args: [sessionID, draft] });
    if (this.promptError !== undefined) throw this.promptError;
    const delivery = draft.delivery ?? 'queue';
    const item: QueuedInput = {
      id: `in_${this.inbox.length + 1}`,
      kind: 'user',
      delivery,
      text: draft.text,
      createdAt: this.inbox.length + 1,
    };
    this.inbox.push(item);
    this.inboxSession[item.id] = sessionID;
    return { ...item };
  }
  /** When set, compactSession fails with this error (transport failure injection). */
  compactError: Error | undefined;
  /**
   * Native v2 compaction emulator: registers a pending `kind: 'compaction'` inbox item,
   * like OpenCode's inbox does while the summary is being produced.
   */
  async compactSession(sessionID: string, requestID?: string): Promise<void> {
    this.calls.push({
      name: 'compactSession',
      args: [sessionID, ...(requestID === undefined ? [] : [requestID])],
    });
    if (this.compactError !== undefined) throw this.compactError;
    const item: QueuedInput = {
      id: `in_${this.inbox.length + 1}`,
      kind: 'compaction',
      delivery: 'queue',
      text: '',
      createdAt: this.inbox.length + 1,
    };
    this.inbox.push(item);
    this.inboxSession[item.id] = sessionID;
  }
  /** Native opencode.goal plugin emulator: session-scoped goals, updated by goal commands. */
  goals: Record<string, NativeGoal | undefined> = {};
  private goalSequence = 0;
  async getGoal(sessionID: string, directory?: string): Promise<NativeGoal | null> {
    this.calls.push({
      name: 'getGoal',
      args: directory === undefined ? [sessionID] : [sessionID, directory],
    });
    return this.goals[sessionID] ?? null;
  }
  async runCommand(sessionID: string, name: string, text: string): Promise<void> {
    this.calls.push({ name: 'runCommand', args: [sessionID, name, text] });
    if (name !== 'goal') return;
    const args = text.trim();
    const lower = args.toLowerCase();
    const current = this.goals[sessionID];
    if (args === '') return; // Status read; the plugin answers out-of-band.
    if (lower === 'pause') {
      if (current?.status !== 'active')
        throw new BackendError('conflict', 'session.command', 'No active goal to pause.');
      this.goals[sessionID] = {
        ...current,
        status: 'paused',
        reason: 'Paused by the user',
      };
      return;
    }
    if (lower === 'resume') {
      if (current?.status !== 'paused')
        throw new BackendError('conflict', 'session.command', 'No paused goal to resume.');
      this.goals[sessionID] = {
        ...current,
        status: 'active',
        rounds: 1,
      };
      return;
    }
    if (lower === 'clear') {
      if (current === undefined)
        throw new BackendError('conflict', 'session.command', 'No goal is set.');
      delete this.goals[sessionID];
      return;
    }
    this.goalSequence += 1;
    this.goals[sessionID] = {
      id: `goal_${this.goalSequence}`,
      objective: args,
      status: 'active',
      rounds: 0,
      maxRounds: 50,
    };
  }
  async runShell(sessionID: string, command: string): Promise<void> {
    this.calls.push({ name: 'runShell', args: [sessionID, command] });
  }
  async backgroundTools(sessionID: string): Promise<void> {
    this.calls.push({ name: 'backgroundTools', args: [sessionID] });
  }
  async interrupt(sessionID: string): Promise<boolean> {
    this.calls.push({ name: 'interrupt', args: [sessionID] });
    // The goal plugin pauses an active goal on a user interrupt ('Stopped by the user').
    const current = this.goals[sessionID];
    if (current?.status === 'active') {
      this.goals[sessionID] = {
        ...current,
        status: 'paused',
        reason: 'Stopped by the user',
      };
    }
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
  private setRevertState(sessionID: string, revert: SessionSummary['revert']): void {
    const session = this.sessions.find((entry) => entry.id === sessionID);
    if (session === undefined) return;
    const { revert: _revert, ...rest } = session;
    const next = revert === undefined ? rest : { ...rest, revert };
    this.sessions.splice(this.sessions.indexOf(session), 1, next);
  }
  async stageRevert(sessionID: string, messageID: string): Promise<FileDiff[]> {
    this.calls.push({ name: 'stageRevert', args: [sessionID, messageID] });
    this.setRevertState(sessionID, { messageID, files: [...this.revertFiles] });
    return this.revertFiles;
  }
  private clearRevertState(sessionID: string): void {
    this.setRevertState(sessionID, undefined);
  }
  async commitRevert(sessionID: string): Promise<void> {
    this.calls.push({ name: 'commitRevert', args: [sessionID] });
    this.clearRevertState(sessionID);
  }
  async clearRevert(sessionID: string): Promise<void> {
    this.calls.push({ name: 'clearRevert', args: [sessionID] });
    this.clearRevertState(sessionID);
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
    this.sessions = this.sessions.map((session) =>
      session.id === sessionID ? { ...session, model } : session,
    );
  }
  async listAgents(): Promise<AgentDescriptor[]> {
    if (this.listAgentsHook !== undefined) return this.listAgentsHook();
    return this.agents;
  }
  async listModels(): Promise<CatalogModel[]> {
    return this.models;
  }
  async defaultModel(): Promise<ModelSelection | undefined> {
    return undefined;
  }
  /** Configurable server-side command catalog returned by listCommands. */
  serverCommands: ServerCommand[] = [];
  async listCommands(): Promise<ServerCommand[]> {
    return this.serverCommands.map((command) => ({ ...command }));
  }
  /** Configurable MCP server names returned by listMcpServers. */
  mcpServers: string[] = [];
  async listMcpServers(): Promise<string[]> {
    return [...this.mcpServers];
  }
  /** Configurable server-side file index: match is a lowercase substring test. */
  async findProjectFiles(directory: string, query: string): Promise<string[]> {
    this.calls.push({ name: 'findProjectFiles', args: [directory, query] });
    const needle = query.toLowerCase().replaceAll('\\', '/');
    return this.remoteFiles.filter((path) => path.toLowerCase().includes(needle)).slice(0, 50);
  }
  async findProjectDirectories(directory: string, query: string): Promise<string[]> {
    this.calls.push({ name: 'findProjectDirectories', args: [directory, query] });
    const needle = query.toLowerCase().replaceAll('\\', '/');
    return this.remoteDirectories
      .filter((path) => path.toLowerCase().includes(needle))
      .slice(0, 50);
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
  /** When set, replaces the default silent event subscription (wire-stream tests). */
  eventsHook?: (signal: AbortSignal) => AsyncIterable<BackendEvent>;

  events(signal: AbortSignal): AsyncIterable<BackendEvent> {
    if (this.eventsHook !== undefined) return this.eventsHook(signal);
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
