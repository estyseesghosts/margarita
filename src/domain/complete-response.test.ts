import { describe, expect, test } from 'bun:test';

import { completeResponses, lastCompleteResponse } from './complete-response.ts';
import type { AssistantPart, ToolCall, TranscriptMessage } from './transcript.ts';

const model = { providerID: 'opencode', modelID: 'longcat' };

function user(id: string, text: string, createdAt: number): TranscriptMessage {
  return { kind: 'user', id, createdAt, text, attachments: [] };
}

function assistant(
  id: string,
  createdAt: number,
  parts: readonly AssistantPart[],
): TranscriptMessage {
  return { kind: 'assistant', id, createdAt, agent: 'build', model, parts };
}

function idle(id: string, createdAt: number, outcome: 'succeeded' | 'failed' | 'interrupted') {
  return { kind: 'idle' as const, id, createdAt, outcome };
}

function tool(id: string, name: string): ToolCall {
  return { id, name, status: 'completed', input: {}, startedAt: 0, output: 'tool output' };
}

describe('complete agent responses (#issue 5)', () => {
  test('one execution spans multiple assistant messages, tool calls and steering prompts', () => {
    const messages: TranscriptMessage[] = [
      user('u1', 'explain the renderer', 0),
      assistant('a1', 1, [
        { kind: 'text', text: 'First paragraph with `code`.' },
        { kind: 'tool', tool: tool('t1', 'read') },
      ]),
      user('u2', 'and the wrapping?', 2),
      assistant('a2', 3, [
        { kind: 'reasoning', text: 'hidden reasoning', done: true },
        { kind: 'tool', tool: tool('t2', 'grep') },
        { kind: 'text', text: '```ts\nconst x = 1;\n  return x;\n```' },
      ]),
      { kind: 'compaction', id: 'c1', createdAt: 4, state: 'completed' },
      { kind: 'note', id: 'n1', createdAt: 5, text: 'decoration', source: 'synthetic' },
      idle('i1', 6, 'succeeded'),
    ];
    const [response] = completeResponses(messages);
    expect(response?.text).toBe(
      'First paragraph with `code`.\n\n```ts\nconst x = 1;\n  return x;\n```',
    );
    expect(response?.prompt).toBe('explain the renderer');
    expect(response?.completedAt).toBe(6);
    expect(response?.text).not.toContain('hidden reasoning');
    expect(response?.text).not.toContain('tool output');
  });

  test('a running execution is not complete; the previous response is selected', () => {
    const messages: TranscriptMessage[] = [
      user('u1', 'first', 0),
      assistant('a1', 1, [{ kind: 'text', text: 'first answer' }]),
      idle('i1', 2, 'succeeded'),
      user('u2', 'second', 3),
      assistant('a2', 4, [{ kind: 'text', text: 'still streaming' }]),
    ];
    expect(completeResponses(messages).map((response) => response.text)).toEqual(['first answer']);
    const last = lastCompleteResponse(messages);
    expect(last.ok).toBe(true);
    if (!last.ok) throw new Error('expected a response');
    expect(last.response.text).toBe('first answer');
    expect(last.incompleteTail).toBe(true);
  });

  test('failed and interrupted executions never count as complete responses', () => {
    for (const outcome of ['failed', 'interrupted'] as const) {
      const messages: TranscriptMessage[] = [
        user('u1', 'first', 0),
        assistant('a1', 1, [{ kind: 'text', text: 'good answer' }]),
        idle('i1', 2, 'succeeded'),
        user('u2', 'try again', 3),
        assistant('a2', 4, [{ kind: 'text', text: 'half an answer' }]),
        idle('i2', 5, outcome),
      ];
      const last = lastCompleteResponse(messages);
      expect(last.ok).toBe(true);
      if (!last.ok) throw new Error('expected a response');
      expect(last.response.text).toBe('good answer');
      expect(last.incompleteTail).toBe(true);
    }
  });

  test('an assistant-only tail cannot prove the start of its execution', () => {
    const messages: TranscriptMessage[] = [
      assistant('a1', 0, [{ kind: 'text', text: 'orphaned tail' }]),
      idle('i1', 1, 'succeeded'),
    ];
    expect(completeResponses(messages)).toEqual([]);
    expect(lastCompleteResponse(messages)).toEqual({ ok: false, reason: 'none' });
    expect(lastCompleteResponse(messages, { historyIncomplete: true })).toEqual({
      ok: false,
      reason: 'history-incomplete',
    });
  });

  test('an execution without public assistant text is not a response', () => {
    const messages: TranscriptMessage[] = [
      user('u1', 'status', 0),
      assistant('a1', 1, [
        { kind: 'reasoning', text: 'only reasoning', done: true },
        { kind: 'tool', tool: tool('t1', 'read') },
      ]),
      idle('i1', 2, 'succeeded'),
    ];
    expect(completeResponses(messages)).toEqual([]);
  });

  test('all complete responses are returned in order with para graph breaks preserved', () => {
    const messages: TranscriptMessage[] = [
      user('u1', 'one', 0),
      assistant('a1', 1, [{ kind: 'text', text: 'answer one\n' }]),
      assistant('a2', 2, [{ kind: 'text', text: '\nsecond step  \n' }]),
      idle('i1', 3, 'succeeded'),
      user('u2', 'two', 4),
      assistant('a3', 5, [{ kind: 'text', text: 'answer two' }]),
      idle('i2', 6, 'succeeded'),
    ];
    const responses = completeResponses(messages);
    expect(responses.map((response) => response.text)).toEqual([
      'answer one\n\n\nsecond step  \n',
      'answer two',
    ]);
    expect(responses.map((response) => response.id)).toEqual(['u1', 'u2']);
  });
});
