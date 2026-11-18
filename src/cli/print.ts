import type { Backend } from '../adapter/backend.ts';
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

/**
 * Noninteractive run: admit the prompt, wait until the server reports the session
 * idle, then print the final assistant text (or NDJSON messages with `--json`).
 * Interruption by the caller leaves the server session running.
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
  const before = await backend.listMessages(sessionID, 1);
  const lastSeen = before.messages.at(-1)?.id;
  await backend.prompt(sessionID, { text: request.prompt, files: [] });

  const pollMs = request.pollMs ?? 500;
  // Polling `session.active` keeps print mode independent of the live-only event stream.
  for (;;) {
    if (request.signal.aborted) return exitCodes.interrupted;
    await Bun.sleep(pollMs);
    const active = await backend.activeSessionIDs();
    if (!active.has(sessionID)) break;
  }

  const page = await backend.listMessages(sessionID, 200);
  const start = page.messages.findIndex((message) => message.id === lastSeen);
  const fresh = page.messages.slice(start + 1);
  if (request.json) {
    for (const message of fresh) request.write(`${JSON.stringify({ sessionID, message })}\n`);
  } else {
    const text = finalText(fresh);
    if (text !== '') request.write(text.endsWith('\n') ? text : `${text}\n`);
  }
  const failed = fresh.some(
    (message) =>
      (message.kind === 'assistant' && message.error !== undefined) ||
      (message.kind === 'idle' && message.outcome === 'failed'),
  );
  return failed ? exitCodes.failed : exitCodes.ok;
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
