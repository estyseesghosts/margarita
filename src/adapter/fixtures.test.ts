import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import type {
  FormInfo,
  PermissionRequest,
  SessionInboxInfo,
  SessionInfo,
  SessionMessageInfo,
} from '@opencode/client';

import type { TranscriptMessage } from '../domain/transcript.ts';
import {
  toFormRequest,
  toPermissionPrompt,
  toQueuedInput,
  toSessionSummary,
  toTranscriptMessage,
} from './wire-mapping.ts';

/**
 * Mapper regression tests over real, sanitized OpenCode 2.3.0 responses recorded from a
 * disposable service (`bun run capture:fixtures`). They pin the wire shapes the adapter
 * actually receives, which hand-written fakes cannot.
 */
const fixtureDir = join(import.meta.dir, '..', '..', 'test', 'fixtures', 'opencode-2.3.0');

/**
 * The fixtures were recorded straight from the SDK client, so they already have the SDK's
 * response types; this only restores the type information lost by reading JSON from disk.
 * The mappers under test are the runtime validation.
 */
async function fixture<T>(name: string): Promise<T> {
  const json: unknown = await Bun.file(join(fixtureDir, `${name}.json`)).json();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- recorded SDK response, see above
  return json as T;
}

async function messages(name: string): Promise<TranscriptMessage[]> {
  const page = await fixture<{ data: SessionMessageInfo[] }>(name);
  return page.data
    .map((message) => toTranscriptMessage(message))
    .filter((message) => message !== undefined)
    .toReversed();
}

function assistantTools(list: readonly TranscriptMessage[]) {
  return list.flatMap((message) =>
    message.kind === 'assistant' ? message.parts.filter((part) => part.kind === 'tool') : [],
  );
}

describe('OpenCode 2.3.0 fixtures', () => {
  test('session maps to a summary rooted at the workspace', async () => {
    const summary = toSessionSummary(await fixture<SessionInfo>('session'));
    expect(summary.id).toMatch(/^ses_fixture/);
    expect(summary.directory).toBe('/workspace');
  });

  test('a simple turn is user, assistant text, idle', async () => {
    const list = await messages('messages-simple');
    expect(list.map((message) => message.kind)).toEqual(['user', 'assistant', 'idle']);
    const reply = list[1];
    expect(reply?.kind === 'assistant' && reply.parts).toEqual([
      { kind: 'text', text: 'ok: first' },
    ]);
    expect(list[2]).toMatchObject({ kind: 'idle', outcome: 'succeeded' });
  });

  test('a tool turn keeps the call, its input and its output', async () => {
    const tools = assistantTools(await messages('messages-tool'));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      kind: 'tool',
      tool: {
        name: 'shell',
        status: 'completed',
        input: { command: 'echo captured' },
      },
    });
    expect(tools[0]?.kind === 'tool' && tools[0].tool.output).toContain('captured');
  });

  test('the queued inbox item shares its ID with the user message it becomes', async () => {
    const inbox = (await fixture<SessionInboxInfo[]>('inbox-queued')).map(toQueuedInput);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: 'user', delivery: 'queue', text: 'queued follow-up' });
    const list = await messages('messages-queued');
    const delivered = list.find(
      (message) => message.kind === 'user' && message.id === inbox[0]?.id,
    );
    expect(delivered).toMatchObject({ kind: 'user', text: 'queued follow-up' });
    // One idle marker closes the whole run, not each turn (the print-mode turn boundary).
    expect(list.map((message) => message.kind)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'idle',
    ]);
  });

  test('a permission request names the action, resources and the pattern always would save', async () => {
    const [ask] = (await fixture<PermissionRequest[]>('permission-ask')).map(toPermissionPrompt);
    expect(ask).toMatchObject({
      action: 'shell',
      resources: ['echo captured'],
      save: ['echo *'],
    });
  });

  test('an agent question maps to a choice field with its options', async () => {
    const [form] = (await fixture<FormInfo[]>('form-ask')).map(toFormRequest);
    expect(form?.fields).toHaveLength(1);
    const field = form?.fields[0];
    expect(field).toMatchObject({ kind: 'choice', key: 'q0', title: 'Pick' });
    expect(field?.kind === 'choice' && field.options.map((option) => option.value)).toEqual([
      'alpha',
      'beta',
    ]);
  });
});
