import { describe, expect, test } from 'bun:test';

import { copyableFromMessages } from './copyable.ts';
import type { AssistantPart, TranscriptMessage } from './transcript.ts';

const assistant = (parts: readonly AssistantPart[]): TranscriptMessage => ({
  kind: 'assistant',
  id: 'm1',
  createdAt: 1,
  agent: 'build',
  model: { providerID: 'p', modelID: 'm' },
  parts,
});

describe('copyable text projection (#105)', () => {
  test('copies exact tool output, diff and error with no UI prefixes', () => {
    const messages = [
      assistant([
        {
          kind: 'tool',
          tool: {
            id: 't1',
            name: 'shell',
            status: 'error',
            input: {},
            startedAt: 0,
            output: 'first\nsecond\nthird',
            diff: '--- a/f.ts\n+++ b/f.ts',
            error: 'exit 1',
          },
        },
      ]),
    ];
    const items = copyableFromMessages(messages);
    expect(items.map((item) => item.kind)).toEqual(['output', 'diff', 'error']);
    expect(items[0]?.text).toBe('first\nsecond\nthird');
    expect(items[1]?.text).toBe('--- a/f.ts\n+++ b/f.ts');
    expect(items[2]?.text).toBe('exit 1');
  });

  test('sanitizes terminal escapes without changing code or newlines', () => {
    const messages = [
      assistant([
        {
          kind: 'text',
          text: 'Here:\n```ts\nconst x = "\u001b]52;c;AAAA\u0007";\nconsole.log(x)\n```',
        },
      ]),
    ];
    const [item] = copyableFromMessages(messages);
    expect(item?.kind).toBe('code');
    expect(item?.text).toBe('const x = "";\nconsole.log(x)\n');
  });

  test('reports frontend caps and server truncation distinctly', () => {
    const messages = [
      assistant([
        {
          kind: 'tool',
          tool: {
            id: 'front',
            name: 'read',
            status: 'completed',
            input: {},
            startedAt: 0,
            output: 'short',
            outputTruncated: 'frontend',
          },
        },
        {
          kind: 'tool',
          tool: {
            id: 'srv',
            name: 'read',
            status: 'completed',
            input: {},
            startedAt: 0,
            output: 'partial',
            outputTruncated: 'server',
          },
        },
      ]),
    ];
    const items = copyableFromMessages(messages);
    expect(items[0]?.truncation).toBe('frontend');
    expect(items[0]?.label).toContain('UI cap');
    expect(items[1]?.truncation).toBe('server');
    expect(items[1]?.label).toContain('server truncated');
  });

  test('complete responses are an additional picker category (#issue 5)', () => {
    const messages: TranscriptMessage[] = [
      {
        kind: 'user',
        id: 'u1',
        createdAt: 0,
        text: 'show me the code',
        attachments: [],
      },
      assistant([{ kind: 'text', text: 'Here:\n```ts\nconst x = 1;\n```' }]),
      { kind: 'idle', id: 'i1', createdAt: 2, outcome: 'succeeded' },
    ];
    const items = copyableFromMessages(messages);
    expect(items.map((item) => item.kind)).toEqual(['code', 'response']);
    const response = items[1];
    expect(response?.text).toBe('Here:\n```ts\nconst x = 1;\n```');
    expect(response?.truncation).toBe('none');
    expect(response?.label).toContain('Response · Here:');
  });
});
