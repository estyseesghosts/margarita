import type { Backend, QueuedInput } from '../adapter/backend.ts';
import type { ModelSelection } from '../domain/model-ref.ts';
import type { TranscriptMessage } from '../domain/transcript.ts';
import { strings } from '../i18n/index.ts';

export type PrintRequest = Readonly<{
  backend: Backend;
  directory: string;
  prompt: string;
  sessionID?: string;
  agent?: string;
  model?: ModelSelection;
  json: boolean;
  write: (text: string) => void;
  signal: AbortSignal;
  pollMs?: number;
  /** Longest an admitted prompt may stay unstarted while the session is idle. */
  startTimeoutMs?: number;
  /** Human-facing diagnostics (stderr). */
  diagnostic: (text: string) => void;
}>;

/** Exit codes from docs/07. */
export const exitCodes = {
  ok: 0,
  failed: 1,
  usage: 2,
  unavailable: 3,
  unauthorized: 4,
  modelUnavailable: 5,
  notFound: 6,
  interrupted: 130,
} as const;

/** Where the submitted turn stands, derived only from that turn's own messages. */
export type TurnProgress =
  | { state: 'pending' }
  | { state: 'running'; messages: readonly TranscriptMessage[] }
  | {
      state: 'done';
      messages: readonly TranscriptMessage[];
      outcome: 'succeeded' | 'failed' | 'interrupted';
      error?: string;
    };

/**
 * Locates the turn for an admitted prompt. The inbox item shares its ID with the user
 * message it becomes; when the server doesn't preserve that, the first identical user
 * message created at or after admission is used. Never infers anything from session idleness.
 */
export function findTurn(
  messages: readonly TranscriptMessage[],
  admitted: Pick<QueuedInput, 'id' | 'text' | 'createdAt'>,
): TurnProgress {
  let start = messages.findIndex((m) => m.kind === 'user' && m.id === admitted.id);
  if (start < 0) {
    start = messages.findIndex(
      (m) => m.kind === 'user' && m.createdAt >= admitted.createdAt && m.text === admitted.text,
    );
  }
  if (start < 0) return { state: 'pending' };
  const rest = messages.slice(start);
  // The server writes one idle marker per run, so a queued follow-up lands in the same run:
  // this turn ends at the next user message or at the idle marker, whichever comes first.
  const end = rest.findIndex((m, index) => index > 0 && (m.kind === 'idle' || m.kind === 'user'));
  const closer = end < 0 ? undefined : rest[end];
  if (closer === undefined) return { state: 'running', messages: rest };
  const turn = rest.slice(0, closer.kind === 'idle' ? end + 1 : end);
  const lastAssistant = turn.findLast((m) => m.kind === 'assistant');
  const errored = turn.find((m) => m.kind === 'assistant' && m.error !== undefined);
  const error = errored?.kind === 'assistant' ? errored.error : undefined;
  if (closer.kind === 'idle' && closer.outcome !== 'succeeded') {
    const detail = closer.error ?? error;
    return {
      state: 'done',
      messages: turn,
      outcome: closer.outcome,
      ...(detail === undefined ? {} : { error: detail }),
    };
  }
  if (error !== undefined) return { state: 'done', messages: turn, outcome: 'failed', error };
  // A following user message only proves this turn ended once its reply has completed.
  if (
    closer.kind === 'user' &&
    !(lastAssistant?.kind === 'assistant' && lastAssistant.completedAt !== undefined)
  ) {
    return { state: 'running', messages: turn };
  }
  return { state: 'done', messages: turn, outcome: 'succeeded' };
}

const pageSize = 100;
const gracePolls = 3;
/** Every this many polls the whole turn is re-read from the server, to pick up edits to old messages. */
const reconcileEvery = 120;
const eol = String.fromCharCode(10);

/** One human diagnostic line, with the single `marg:` prefix policy applied in one place. */
function marg(text: string): string {
  return `${strings.cli.prefix}: ${text}${eol}`;
}

/**
 * Keeps the messages from admission onward. A normal poll reads only the newest page and
 * merges it by ID into the cache; older pages are fetched only until they overlap what is
 * already known (first poll: until admission), so traffic per poll stays bounded as the turn
 * grows. A periodic full reload reconciles edits to older messages.
 */
class TurnReader {
  private known = new Map<string, TranscriptMessage>();
  private polls = 0;

  constructor(
    private readonly backend: Backend,
    private readonly sessionID: string,
    private readonly since: number,
  ) {}

  async read(): Promise<TranscriptMessage[]> {
    this.polls += 1;
    const full = this.known.size === 0 || this.polls % reconcileEvery === 0;
    let cursor: string | undefined;
    let collected: TranscriptMessage[] = [];
    for (;;) {
      const page = await this.backend.listMessages(this.sessionID, pageSize, cursor);
      collected = [...page.messages, ...collected];
      const oldest = collected[0];
      const reachedAdmission = oldest !== undefined && oldest.createdAt < this.since;
      const overlapsKnown = !full && collected.some((m) => this.known.has(m.id));
      if (page.olderCursor === undefined || reachedAdmission || overlapsKnown) break;
      cursor = page.olderCursor;
    }
    if (full) this.known = new Map();
    for (const message of collected) this.known.set(message.id, message);
    return [...this.known.values()];
  }
}

/**
 * Noninteractive run: admit the prompt, then follow that admitted turn (inbox item, user
 * message, assistant reply, terminal marker) and print only its result. Session idleness is
 * never treated as completion. Interruption by the caller leaves the server session running.
 */
export async function runPrint(request: PrintRequest): Promise<number> {
  const { backend } = request;
  // Never create a session or submit a billable prompt when cancellation is already known.
  if (request.signal.aborted) return exitCodes.interrupted;

  let sessionID = request.sessionID;
  if (sessionID === undefined) {
    const created = await backend.createSession({
      directory: request.directory,
      ...(request.agent === undefined ? {} : { agent: request.agent }),
      ...(request.model === undefined ? {} : { model: request.model }),
    });
    if (request.signal.aborted) {
      request.diagnostic(marg(strings.cli.print.cancelledCreatingSession(created.id)));
      return exitCodes.interrupted;
    }
    sessionID = created.id;
  }
  // Last check immediately before admission — the billable boundary (#151).
  if (request.signal.aborted) return exitCodes.interrupted;

  let admitted: QueuedInput;
  try {
    admitted = await backend.prompt(sessionID, { text: request.prompt, files: [] });
  } catch (error) {
    if (request.signal.aborted) {
      request.diagnostic(marg(strings.cli.print.cancelledSubmitting(sessionID, String(error))));
      return exitCodes.interrupted;
    }
    throw error;
  }
  // Past admission the server owns the turn: report the ambiguity honestly instead of
  // implying nothing started or submitting again. The CLI never interrupts it here.
  if (request.signal.aborted) {
    request.diagnostic(marg(strings.cli.print.cancelledAfterSubmit(sessionID)));
    return exitCodes.interrupted;
  }

  const pollMs = request.pollMs ?? 500;
  const startTimeoutMs = request.startTimeoutMs ?? 120_000;
  const waitStarted = Date.now();
  // Consecutive polls that saw nothing to wait for; a short grace absorbs read-after-write lag.
  let vanished = 0;
  let inactiveWhileRunning = 0;
  const reader = new TurnReader(backend, sessionID, admitted.createdAt);
  for (;;) {
    if (request.signal.aborted) return exitCodes.interrupted;
    await Bun.sleep(pollMs);
    if (request.signal.aborted) return exitCodes.interrupted;

    const messages = await reader.read();
    const progress = findTurn(messages, admitted);
    if (progress.state === 'done') return report(request, sessionID, progress);

    const active = (await backend.activeSessionIDs()).has(sessionID);
    if (progress.state === 'running') {
      inactiveWhileRunning = active ? 0 : inactiveWhileRunning + 1;
      if (inactiveWhileRunning >= gracePolls) {
        // e.g. a declined permission ends the run with an errored reply and no idle marker.
        const stopped = progress.messages.findLast((m) => m.kind === 'assistant');
        const cause = stopped?.kind === 'assistant' ? stopped.error : undefined;
        return fail(request, strings.cli.print.sessionStopped(cause));
      }
      continue;
    }

    const queued = (await backend.listInbox(sessionID)).some((item) => item.id === admitted.id);
    vanished = queued ? 0 : vanished + 1;
    if (vanished >= gracePolls) {
      return fail(request, strings.cli.print.promptLeftQueue);
    }
    if (!active && Date.now() - waitStarted > startTimeoutMs) {
      return fail(request, strings.cli.print.promptDidNotStart(startTimeoutMs));
    }
  }
}

function fail(request: PrintRequest, reason: string): number {
  request.diagnostic(marg(reason));
  return exitCodes.failed;
}

function report(
  request: PrintRequest,
  sessionID: string,
  progress: Extract<TurnProgress, { state: 'done' }>,
): number {
  if (request.json) {
    for (const message of progress.messages) {
      request.write(`${JSON.stringify({ sessionID, message })}${eol}`);
    }
  } else {
    request.write(stdoutText(finalText(progress.messages)));
  }
  if (progress.outcome === 'succeeded') return exitCodes.ok;
  const detail = progress.error === undefined ? '' : `: ${progress.error}`;
  request.diagnostic(marg(strings.cli.print.turnFinished(progress.outcome, detail)));
  return exitCodes.failed;
}

/**
 * Exact assistant text from the final reply. Indentation, blank lines and trailing whitespace
 * are preserved verbatim so redirected `--print` output matches the server text (#158).
 */
export function finalText(messages: readonly TranscriptMessage[]): string {
  const assistant = messages.findLast((message) => message.kind === 'assistant');
  if (assistant?.kind !== 'assistant') return '';
  return assistant.parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('\n');
}

/**
 * Stdout contract: write the exact text, adding at most one line terminator when it does not
 * already end in one. Never trims, rewrites line endings, or doubles an existing newline.
 */
export function stdoutText(text: string): string {
  if (text === '' || text.endsWith('\n') || text.endsWith('\r')) return text;
  return `${text}${eol}`;
}
