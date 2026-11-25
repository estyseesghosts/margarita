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
  test('a configured field subset is honoured before width degradation', () => {
    expect(
      footerSegments(facts, 120, ['tokens', 'cost'])
        .map((part) => part.text)
        .join(''),
    ).toBe('42k in · 5k out · $0.38');
    expect(
      footerSegments(facts, 120, ['agent', 'state', 'tokens'])
        .map((part) => part.text)
        .join(''),
    ).toBe('build · working · 42k in · 5k out');
  });
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
  test('unknown cost is omitted, never a dash or zero (#193)', () => {
    const line = formatFooter(withoutCost, 120);
    expect(line).not.toContain('—');
    expect(line).not.toContain('$');
    expect(line.endsWith(' · ')).toBe(false);
  });
  test('a confirmed zero cost and zero tokens stay visible (#193)', () => {
    const zero = {
      ...facts,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    };
    expect(formatFooter(zero, 120)).toContain('$0');
    expect(formatFooter(zero, 120)).toContain('0 in · 0 out');
  });
  test('a fresh session shows only agent, model and state with no placeholders (#193)', () => {
    const { tokens: _tokens, cost: _unused, ...fresh } = facts;
    for (const width of [120, 60, 30, 12, 6]) {
      const line = formatFooter(fresh, width);
      expect(line.length).toBeLessThanOrEqual(width);
      expect(line).not.toContain('—');
      expect(line).not.toContain('tokens');
      expect(line).not.toContain('$');
    }
    expect(formatFooter(fresh, 120)).toBe('build · gpt-6.1-sol#high · working');
    expect(formatFooter(fresh, 20)).toBe('build · working');
    expect(footerSegments(fresh, 120).some((segment) => segment.kind === 'context')).toBe(false);
  });
  test('a missing model shows a truthful loading or unavailable state, never "default model"', () => {
    const { model: _model, tokens: _t, cost: _c, ...bare } = facts;
    expect(formatFooter({ ...bare, modelStatus: 'loading' }, 120)).toBe(
      'build · connecting… · working',
    );
    expect(formatFooter({ ...bare, modelStatus: 'unavailable' }, 120)).toContain(
      'model unavailable',
    );
    expect(formatFooter(bare, 120)).toBe('build · working');
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

  test('agent, model and context carry stable click actions (#124)', () => {
    const segments = footerSegments({ ...facts, contextOccupancy: 92 }, 120);
    expect(segments.find((segment) => segment.kind === 'agent')?.action).toBe('agent');
    expect(segments.find((segment) => segment.kind === 'model')?.action).toBe('model');
    expect(segments.find((segment) => segment.kind === 'context')?.action).toBe('context');
    expect(segments.filter((segment) => segment.kind === 'state')[0]?.action).toBeUndefined();
  });

  test('a known token count without a limit shows numeric context, never a fake percent', () => {
    const segments = footerSegments({ ...facts, contextTokens: 12_300 }, 120);
    const context = segments.find((segment) => segment.kind === 'context');
    expect(context?.text).toBe('12k ctx');
    expect(context?.action).toBe('context');
  });
});
