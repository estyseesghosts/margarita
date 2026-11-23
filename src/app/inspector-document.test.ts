import { describe, expect, test } from 'bun:test';

import type { ToolResultPayload } from '../domain/transcript.ts';
import { InspectorDocumentCache } from './inspector-document.ts';

function payload(text: string): ToolResultPayload {
  return { files: [], completeness: 'complete', text };
}

describe('inspector document cache (#315)', () => {
  test('reuses the document while the payload reference is unchanged', () => {
    const cache = new InspectorDocumentCache();
    const document = payload('same');
    const first = cache.get(document);
    expect(cache.get(document)).toBe(first);
  });

  test('rebuilds when the payload changes', () => {
    const cache = new InspectorDocumentCache();
    const first = cache.get(payload('one'));
    const second = cache.get(payload('two'));
    expect(second).not.toBe(first);
  });

  test('an absent payload materializes an empty document', () => {
    const cache = new InspectorDocumentCache();
    const empty = cache.get(undefined);
    expect(cache.get(undefined)).toBe(empty);
    expect(empty).toBeDefined();
  });
});
