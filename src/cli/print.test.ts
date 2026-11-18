import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import type { MessagePage, PromptDraft, QueuedInput } from '../adapter/backend.ts';
import type { TranscriptMessage } from '../domain/transcript.ts';
import { exitCodes, findTurn, runPrint } from './print.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const model = { providerID: 'p', modelID: 'm' };
const user = (id: string, createdAt: number, text: string): TranscriptMessage => ({
  kind: 'user',
  id,
  createdAt,
  text,
  attachments: [],
});
const assistant = (
  id: string,
  createdAt: number,
  text: string,
  error?: string,
): TranscriptMessage => ({
  kind: 'assistant',
  id,
  createdAt,
  agent: 'build',
  model,
  completedAt: createdAt + 1,
  parts: [{ kind: 'text', text }],
  ...(error === undefined ? {} : { error }),
});
const idle = (
  id: string,
  createdAt: number,
  outcome: 'succeeded' | 'failed' | 'interrupted',
): TranscriptMessage => ({ kind: 'idle', id, createdAt, outcome });

/** Backend whose history is a function of how many polls have happened since admission. */
class ScriptedBackend extends FakeBackend {
  polls = 0;
  admitted: QueuedInput | undefined;
  /** Messages visible at poll n; the admitted item's id is passed in. */
  script: (poll: number, id: string) => TranscriptMessage[] = () => [];
  /** Whether the admitted item is still in the inbox at poll n. */
  queuedAt: (poll: number) => boolean = () => false;
  activeAt: (poll: number) => boolean = () => true;
  pageLimits: number[] = [];

  override async prompt(sessionID: string, draft: PromptDraft): Promise<QueuedInput> {
    this.admitted = await super.prompt(sessionID, draft);
    return this.admitted;
  }
  override async listMessages(
    _sessionID: string,
    limit: number,
    cursor?: string,
  ): Promise<MessagePage> {
    if (cursor === undefined) this.polls += 1;
    this.pageLimits.push(limit);
    const all = this.script(this.polls, this.admitted?.id ?? '');
    const end = cursor === undefined ? all.length : Number(cursor);
    const start = Math.max(0, end - limit);
    return {
      messages: all.slice(start, end),
      ...(start > 0 ? { olderCursor: String(start) } : {}),
    };
  }
  override async listInbox(): Promise<QueuedInput[]> {
    return this.queuedAt(this.polls) && this.admitted !== undefined ? [this.admitted] : [];
  }
  override async activeSessionIDs(): Promise<Set<string>> {
    return this.activeAt(this.polls) ? new Set(['ses_1']) : new Set<string>();
  }
}

async function run(
  backend: ScriptedBackend,
  extra: { json?: boolean; signal?: AbortSignal } = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPrint({
    backend,
    directory: '/w',
    prompt: 'run tests',
    sessionID: 'ses_1',
    json: extra.json ?? false,
    write: (text) => out.push(text),
    diagnostic: (text) => err.push(text),
    signal: extra.signal ?? new AbortController().signal,
    pollMs: 1,
    startTimeoutMs: 50,
  });
  return { code, out: out.join(''), err: err.join('') };
}

describe('findTurn', () => {
  const admitted = { id: 'in_1', text: 'hi', createdAt: 10 };

  test('matches by shared id and ends at the idle marker', () => {
    const progress = findTurn(
      [
        user('in_1', 11, 'hi'),
        assistant('a1', 12, 'yo'),
        idle('i1', 13, 'succeeded'),
        user('u2', 14, 'x'),
      ],
      admitted,
    );
    expect(progress).toMatchObject({ state: 'done', outcome: 'succeeded' });
    if (progress.state === 'done') expect(progress.messages).toHaveLength(3);
  });

  test('falls back to identical text at or after admission, ignoring older twins', () => {
    const progress = findTurn(
      [
        user('old', 5, 'hi'),
        assistant('a0', 6, 'stale'),
        idle('i0', 7, 'succeeded'),
        user('new', 11, 'hi'),
      ],
      admitted,
    );
    expect(progress.state).toBe('running');
  });

  test('is pending without a matching user message', () => {
    expect(findTurn([user('other', 11, 'different')], admitted)).toEqual({ state: 'pending' });
  });

  test('a queued follow-up in the same run ends this turn before the shared idle marker', () => {
    const progress = findTurn(
      [
        user('in_1', 11, 'hi'),
        assistant('a1', 12, 'first reply'),
        user('in_2', 14, 'follow-up'),
        assistant('a2', 15, 'second reply'),
        idle('i1', 16, 'succeeded'),
      ],
      admitted,
    );
    expect(progress).toMatchObject({ state: 'done', outcome: 'succeeded' });
    if (progress.state === 'done')
      expect(progress.messages.map((m) => m.id)).toEqual(['in_1', 'a1']);
  });

  test('a following user message does not finish a reply that is still streaming', () => {
    const unfinished: TranscriptMessage = {
      kind: 'assistant',
      id: 'a1',
      createdAt: 12,
      agent: 'build',
      model,
      parts: [{ kind: 'text', text: 'partial' }],
    };
    const progress = findTurn(
      [user('in_1', 11, 'hi'), unfinished, user('in_2', 14, 'steer')],
      admitted,
    );
    expect(progress.state).toBe('running');
  });

  test('an assistant error fails the turn even when the marker says succeeded', () => {
    const progress = findTurn(
      [user('in_1', 11, 'hi'), assistant('a1', 12, '', 'boom'), idle('i1', 13, 'succeeded')],
      admitted,
    );
    expect(progress).toMatchObject({ state: 'done', outcome: 'failed', error: 'boom' });
  });
});

describe('runPrint', () => {
  test('waits through delayed admission instead of trusting an idle session', async () => {
    const backend = new ScriptedBackend();
    const history = [
      user('prev', 1, 'earlier'),
      assistant('pa', 2, 'old reply'),
      idle('pi', 3, 'succeeded'),
    ];
    backend.activeAt = (poll) => poll > 3;
    backend.queuedAt = (poll) => poll <= 3;
    backend.script = (poll, id) =>
      poll < 4
        ? history
        : [
            ...history,
            user(id, 20, 'run tests'),
            assistant('a1', 21, 'all green'),
            idle('i1', 22, 'succeeded'),
          ];
    const result = await run(backend);
    expect(result.code).toBe(exitCodes.ok);
    expect(result.out).toBe('all green\n');
    expect(result.err).toBe('');
  });

  test('prints only the submitted turn amid preexisting queued work', async () => {
    const backend = new ScriptedBackend();
    backend.script = (_poll, id) => [
      user('q0', 1, 'other work'),
      assistant('a0', 2, 'other result'),
      idle('i0', 3, 'succeeded'),
      user(id, 20, 'run tests'),
      assistant('a1', 21, 'mine'),
      idle('i1', 22, 'succeeded'),
      user('q2', 30, 'later work'),
      assistant('a2', 31, 'later result'),
    ];
    expect((await run(backend)).out).toBe('mine\n');
  });

  test('pages past 200 messages to find the turn', async () => {
    const backend = new ScriptedBackend();
    backend.script = (_poll, id) => [
      user(id, 20, 'run tests'),
      assistant('a1', 21, 'deep'),
      idle('i1', 22, 'succeeded'),
      ...Array.from({ length: 450 }, (_, n) => assistant(`f${n}`, 100 + n, 'filler')),
    ];
    const result = await run(backend);
    expect(result.code).toBe(exitCodes.ok);
    expect(result.out).toBe('deep\n');
    expect(backend.pageLimits.length).toBeGreaterThan(1);
  });

  test('a failed turn exits 1 and still prints the turn', async () => {
    const backend = new ScriptedBackend();
    backend.script = (_poll, id) => [
      user(id, 20, 'run tests'),
      assistant('a1', 21, 'partial', 'rate limited'),
      idle('i1', 22, 'failed'),
    ];
    const result = await run(backend);
    expect(result.code).toBe(exitCodes.failed);
    expect(result.out).toBe('partial\n');
    expect(result.err).toContain('rate limited');
  });

  test('an interrupted turn is not a success', async () => {
    const backend = new ScriptedBackend();
    backend.script = (_poll, id) => [user(id, 20, 'run tests'), idle('i1', 22, 'interrupted')];
    const result = await run(backend);
    expect(result.code).toBe(exitCodes.failed);
    expect(result.err).toContain('interrupted');
  });

  test('a prompt cancelled out of the queue fails instead of hanging', async () => {
    const backend = new ScriptedBackend();
    backend.script = () => [user('prev', 1, 'earlier'), idle('pi', 3, 'succeeded')];
    const result = await run(backend);
    expect(result.code).toBe(exitCodes.failed);
    expect(result.out).toBe('');
    expect(result.err).toContain('left the queue');
  });

  test('a queued prompt that never starts on an idle session times out', async () => {
    const backend = new ScriptedBackend();
    backend.queuedAt = () => true;
    backend.activeAt = () => false;
    const result = await run(backend);
    expect(result.code).toBe(exitCodes.failed);
    expect(result.err).toContain('did not start');
  });

  test('a session that stops mid-turn fails', async () => {
    const backend = new ScriptedBackend();
    backend.activeAt = () => false;
    backend.script = (_poll, id) => [user(id, 20, 'run tests'), assistant('a1', 21, 'half')];
    const result = await run(backend);
    expect(result.code).toBe(exitCodes.failed);
    expect(result.err).toContain('stopped');
  });

  test('--json emits only this turn as NDJSON', async () => {
    const backend = new ScriptedBackend();
    backend.script = (_poll, id) => [
      user('q0', 1, 'other'),
      idle('i0', 2, 'succeeded'),
      user(id, 20, 'run tests'),
      assistant('a1', 21, 'ok'),
      idle('i1', 22, 'succeeded'),
    ];
    const result = await run(backend, { json: true });
    const ids = result.out
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line))
      .map((entry) =>
        isRecord(entry) && isRecord(entry['message']) ? entry['message']['id'] : null,
      );
    expect(ids).toEqual(['in_1', 'a1', 'i1']);
  });

  test('transport errors surface instead of being swallowed', async () => {
    const backend = new ScriptedBackend();
    backend.script = () => {
      throw new Error('network down');
    };
    const failure = await run(backend).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('network down');
  });

  test('caller abort exits 130 without interrupting the session', async () => {
    const backend = new ScriptedBackend();
    const abort = new AbortController();
    abort.abort();
    const result = await run(backend, { signal: abort.signal });
    expect(result.code).toBe(exitCodes.interrupted);
    expect(backend.calls.some((call) => call.name === 'interrupt')).toBe(false);
  });
});
