import { describe, expect, test } from 'bun:test';

import { footerSegments, formatFooter } from './footer.ts';

const facts = {
  agent: 'build',
  model: { providerID: 'openai', modelID: 'gpt-6.1-sol', variant: 'high' },
  state: 'working',
  tokens: { input: 42_000, output: 5_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0.38,
  queued: 0,
  stale: false,
};

describe('formatFooter', () => {
  test('the agent is shown without a shortcut at common terminal widths', () => {
    expect(formatFooter(facts, 40)).toBe('build · high · working · 47k · $0.38');
    for (const width of [80, 100, 120]) {
      expect(formatFooter(facts, width)).toBe(
        'build · gpt-6.1-sol#high · working · 42k in · 5k out · $0.38',
      );
    }
  });
  test('narrow terminals keep tokens and spend', () => {
    for (const width of [60, 40, 30, 20, 12]) {
      const line = formatFooter(facts, width);
      expect(line.length).toBeLessThanOrEqual(width);
      expect(line).toContain('$0.38');
    }
    expect(formatFooter(facts, 40)).toBe('build · high · working · 47k · $0.38');
  });
  const { cost: _cost, ...withoutCost } = facts;
  test('unknown cost is a dash, not zero', () => {
    expect(formatFooter(withoutCost, 120)).toContain('· —');
  });
  test('stale values are marked', () => {
    expect(formatFooter({ ...facts, stale: true }, 120)).toContain('~$0.38');
  });
  test('queued inputs are shown when there is room', () => {
    expect(formatFooter({ ...facts, queued: 2 }, 120)).toContain('2 queued');
  });
});

describe('footerSegments', () => {
  test('segments reconstruct the formatted line and carry semantic kinds', () => {
    const segments = footerSegments(facts, 120);
    expect(segments.map((segment) => segment.text).join('')).toBe(formatFooter(facts, 120));
    expect(segments.find((segment) => segment.kind === 'agent')?.text).toBe('build');
    expect(segments.find((segment) => segment.kind === 'model')?.text).toBe('gpt-6.1-sol#high');
    expect(segments.filter((segment) => segment.kind === 'separator').length).toBeGreaterThan(0);
  });

  test('context occupancy is a distinct segment only when supplied', () => {
    expect(footerSegments(facts, 120).some((segment) => segment.kind === 'context')).toBe(false);
    const withContext = footerSegments({ ...facts, contextOccupancy: 92 }, 120);
    expect(withContext.find((segment) => segment.kind === 'context')?.text).toBe('92% context');
  });
});
