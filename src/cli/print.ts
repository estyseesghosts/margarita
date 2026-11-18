import type { Backend, QueuedInput } from '../adapter/backend.ts';
import type { ModelSelection } from '../domain/model-ref.ts';
import type { TranscriptMessage } from '../domain/transcript.ts';

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
  const end = rest.findIndex((m, index) => index > 0 && m.kind === 'idle');
  if (end < 0) return { state: 'running', messages: rest };
  const turn = rest.slice(0, end + 1);
  const marker = turn[end];
  const errored = turn.find((m) => m.kind === 'assistant' && m.error !== undefined);
  if (marker?.kind === 'idle' && marker.outcome !== 'succeeded') {
    const error = marker.error ?? (errored?.kind === 'assistant' ? errored.error : undefined);
    return {
      state: 'done',
      messages: turn,
      outcome: marker.outcome,
      ...(error === undefined ? {} : { error }),
    };
  }
  if (errored?.kind === 'assistant' && errored.error !== undefined) {
    return { state: 'done', messages: turn, outcome: 'failed', error: errored.error };
  }
  return { state: 'done', messages: turn, outcome: 'succeeded' };
}

const pageSize = 200;
const gracePolls = 3;
const eol = String.fromCharCode(10);

/** Pages newest-first until the page reaches back before admission or history ends. */
async function loadSince(
  backend: Backend,
  sessionID: string,
  since: number,
): Promise<TranscriptMessage[]> {
  let collected: TranscriptMessage[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await backend.listMessages(sessionID, pageSize, cursor);
    collected = [...page.messages, ...collected];
    const oldest = collected[0];
    if (page.olderCursor === undefined || (oldest !== undefined && oldest.createdAt < since)) {
      return collected;
    }
    cursor = page.olderCursor;
  }
}

/**
 * Noninteractive run: admit the prompt, then follow that admitted turn (inbox item, user
 * message, assistant reply, terminal marker) and print only its result. Session idleness is
 * never treated as completion. Interruption by the caller leaves the server session running.
 */
export async function runPrint(request: PrintRequest): Promise<number> {
  const { backend } = request;
  const sessionID =
    request.sessionID ??
    (
      await backend.createSession({
        directory: request.directory,
        ...(request.agent === undefined ? {} : { agent: request.agent }),
        ...(request.model === undefined ? {} : { model: request.model }),
      })
    ).id;
  const admitted = await backend.prompt(sessionID, { text: request.prompt, files: [] });

  const pollMs = request.pollMs ?? 500;
  const startTimeoutMs = request.startTimeoutMs ?? 120_000;
  const waitStarted = Date.now();
  // Consecutive polls that saw nothing to wait for; a short grace absorbs read-after-write lag.
  let vanished = 0;
  let inactiveWhileRunning = 0;
  for (;;) {
    if (request.signal.aborted) return exitCodes.interrupted;
    await Bun.sleep(pollMs);
    if (request.signal.aborted) return exitCodes.interrupted;

    const messages = await loadSince(backend, sessionID, admitted.createdAt);
    const progress = findTurn(messages, admitted);
    if (progress.state === 'done') return report(request, sessionID, progress);

    const active = (await backend.activeSessionIDs()).has(sessionID);
    if (progress.state === 'running') {
      inactiveWhileRunning = active ? 0 : inactiveWhileRunning + 1;
      if (inactiveWhileRunning >= gracePolls) {
        return fail(request, 'session stopped before the turn finished');
      }
      continue;
    }

    const queued = (await backend.listInbox(sessionID)).some((item) => item.id === admitted.id);
    vanished = queued ? 0 : vanished + 1;
    if (vanished >= gracePolls) {
      return fail(request, 'the prompt left the queue without starting (cancelled?)');
    }
    if (!active && Date.now() - waitStarted > startTimeoutMs) {
      return fail(request, `the prompt did not start within ${startTimeoutMs} ms`);
    }
  }
}

function fail(request: PrintRequest, reason: string): number {
  request.diagnostic(`marg: ${reason}${eol}`);
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
    const text = finalText(progress.messages);
    if (text !== '') request.write(text.endsWith(eol) ? text : `${text}${eol}`);
  }
  if (progress.outcome === 'succeeded') return exitCodes.ok;
  const detail = progress.error === undefined ? '' : `: ${progress.error}`;
  request.diagnostic(`marg: turn ${progress.outcome}${detail}${eol}`);
  return exitCodes.failed;
}

export function finalText(messages: readonly TranscriptMessage[]): string {
  const assistant = messages.findLast((message) => message.kind === 'assistant');
  if (assistant?.kind !== 'assistant') return '';
  return assistant.parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}
