import type { Backend } from '../../src/adapter/backend.ts';
import type { TranscriptMessage } from '../../src/domain/transcript.ts';

/** Polls `read` until it returns a value, failing with `what` after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** Every message of a session, oldest first, following the cursor to the start. */
export async function allMessages(
  backend: Backend,
  sessionID: string,
): Promise<TranscriptMessage[]> {
  let collected: TranscriptMessage[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await backend.listMessages(sessionID, 100, cursor);
    collected = [...page.messages, ...collected];
    if (page.olderCursor === undefined) return collected;
    cursor = page.olderCursor;
  }
}

/** Waits until `count` idle markers exist in the session and returns the full history. */
export async function waitForIdleMarkers(
  backend: Backend,
  sessionID: string,
  count: number,
): Promise<TranscriptMessage[]> {
  return waitFor(`${count} idle marker(s)`, async () => {
    const messages = await allMessages(backend, sessionID);
    return messages.filter((message) => message.kind === 'idle').length >= count
      ? messages
      : undefined;
  });
}

export function assistantText(message: TranscriptMessage | undefined): string {
  if (message?.kind !== 'assistant') return '';
  return message.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
}
