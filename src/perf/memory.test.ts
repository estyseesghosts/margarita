import { describe, expect, test } from 'bun:test';

import type { TranscriptMessage } from '../domain/transcript.ts';
import { approximateMessageBytes, approximateTranscriptBytes } from './memory.ts';

const user = (id: string, text: string): TranscriptMessage => ({
  kind: 'user',
  id,
  createdAt: 1,
  text,
  attachments: [],
});

describe('approximate retained transcript bytes (#289)', () => {
  test('counts UTF-16 payload and structural overhead deterministically', () => {
    const message = user('u1', 'abcd');
    const retained = approximateMessageBytes(message);
    expect(retained.text).toBe(12); // `u1` plus `abcd`, UTF-16
    expect(retained.structure).toBeGreaterThan(0);
    expect(retained.total).toBe(retained.text + retained.structure);
    expect(approximateMessageBytes(message)).toBe(retained);
  });

  test('large tool output dominates the estimate and is not double counted', () => {
    const output = 'x'.repeat(64_000);
    const message: TranscriptMessage = {
      kind: 'assistant',
      id: 'a1',
      createdAt: 1,
      agent: 'build',
      model: { providerID: 'p', modelID: 'm' },
      parts: [
        { kind: 'text', text: 'small' },
        {
          kind: 'tool',
          tool: {
            id: 't1',
            name: 'read',
            status: 'completed',
            input: { filePath: 'src/a.ts' },
            output,
            startedAt: 1,
          },
        },
      ],
    };
    const retained = approximateMessageBytes(message);
    expect(retained.text).toBeGreaterThanOrEqual(output.length * 2);
    const transcript = approximateTranscriptBytes([message]);
    expect(transcript.total).toBe(retained.total);
    expect(transcript.text).toBe(retained.text);
  });

  test('code-mode children and file references add to retained bytes', () => {
    const base: TranscriptMessage = {
      kind: 'assistant',
      id: 'a1',
      createdAt: 1,
      agent: 'build',
      model: { providerID: 'p', modelID: 'm' },
      parts: [
        {
          kind: 'tool',
          tool: {
            id: 't1',
            name: 'execute',
            status: 'completed',
            input: {},
            startedAt: 1,
          },
        },
      ],
    };
    const withChildren: TranscriptMessage = {
      ...base,
      parts: [
        {
          kind: 'tool',
          tool: {
            id: 't1',
            name: 'execute',
            status: 'completed',
            input: {},
            startedAt: 1,
            children: [
              {
                id: 't1:0',
                parentID: 't1',
                index: 0,
                name: 'lotus.get_issue',
                status: 'completed',
                output: 'child output',
              },
            ],
            files: [{ name: 'a.png', mime: 'image/png', uri: 'file:///a.png' }],
          },
        },
      ],
    };
    expect(approximateMessageBytes(withChildren).total).toBeGreaterThan(
      approximateMessageBytes(base).total,
    );
  });
});
