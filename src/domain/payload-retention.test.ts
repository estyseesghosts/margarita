import { describe, expect, test } from 'bun:test';

import {
  hasRetainedPayload,
  payloadLimits,
  retainedPayload,
  retainPayload,
} from './payload-retention.ts';
import { cachedToolResult, type ToolCall } from './transcript.ts';

function tool(diff: string): ToolCall {
  return {
    id: 'tool-1',
    name: 'edit',
    status: 'completed',
    input: { path: 'src/large.ts' },
    diff,
    startedAt: 1,
    completedAt: 2,
  };
}

describe('large payload retention (#356)', () => {
  test('small payloads stay unchanged and are not stored', () => {
    const owner = {};
    expect(retainPayload(owner, 'hello', payloadLimits.text)).toBe('hello');
    expect(hasRetainedPayload(owner)).toBe(false);
  });

  test('1 MB prose, reasoning and a multi-MB diff keep one bounded preview', () => {
    const prose = 'word '.repeat(200_000);
    const reasoning = 'reason '.repeat(140_000);
    const diff = '+line\n'.repeat(300_000);
    for (const [kind, full, limit] of [
      ['prose', prose, payloadLimits.text],
      ['reasoning', reasoning, payloadLimits.text],
      ['diff', diff, payloadLimits.diff],
    ] as const) {
      const owner = {};
      const preview = retainPayload(owner, full, limit);
      expect(preview.length).toBeLessThan(full.length);
      expect(preview).toContain('characters retained');
      expect(retainedPayload(owner, preview)).toBe(full);
      expect(hasRetainedPayload(owner)).toBe(true);
      // The preview must not claim the server truncated the source.
      expect(preview).not.toContain('server');
      expect(kind.length).toBeGreaterThan(0);
    }
  });

  test('Unicode and very long lines round-trip exactly', () => {
    const owner = {};
    const full = `${'😀e\u0301'.repeat(100_000)}\n${'x'.repeat(200_000)}`;
    const preview = retainPayload(owner, full, 1_000);
    expect(retainedPayload(owner, preview)).toBe(full);
  });

  test('cached tool results expose the full retained diff', () => {
    const full = `+${'line\n'.repeat(500_000)}`;
    const projection = { ...tool(''), diff: '' };
    projection.diff = retainPayload(projection, full, payloadLimits.diff);
    expect(cachedToolResult(projection).diff).toBe(full);
  });

  test('a shallow copy does not share the retained source', () => {
    const owner = {};
    const full = 'x'.repeat(100_000);
    const preview = retainPayload(owner, full, 1_000);
    expect(retainedPayload({ ...owner }, preview)).toBe(preview);
    expect(hasRetainedPayload({ ...owner })).toBe(false);
  });
});
