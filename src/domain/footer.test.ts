import { describe, expect, test } from 'bun:test';

import { formatFooter } from './footer.ts';

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
