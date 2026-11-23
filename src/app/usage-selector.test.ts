import { describe, expect, test } from 'bun:test';

import type { TokenUsage } from '../domain/session.ts';
import type { UsageInput } from '../domain/usage-analytics.ts';
import { UsageAnalyticsSelector } from './usage-selector.ts';

const tokens: TokenUsage = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

function input(overrides: Partial<UsageInput> = {}): UsageInput {
  return {
    serverID: 'local',
    sessionID: 'ses_a',
    messages: [],
    catalog: [],
    stale: false,
    ...overrides,
  };
}

describe('usage analytics selector (#316/#318)', () => {
  test('identical evidence reuses the exact same result object', () => {
    const selector = new UsageAnalyticsSelector();
    const first = selector.select(input({ catalog: [], mcpServers: [] }));
    const second = selector.select(input({ catalog: [], mcpServers: [] }));
    // Each input() call builds a new messages array, so a different array is new evidence.
    expect(second).not.toBe(first);

    const stable = input();
    const third = selector.select(stable);
    const fourth = selector.select(stable);
    expect(fourth).toBe(third);
  });

  test('changing transcript, tokens or cost recomputes', () => {
    const selector = new UsageAnalyticsSelector();
    const first = selector.select(input({ tokens }));
    const same = selector.select(input({ tokens }));
    expect(same).not.toBe(first); // new messages array each time

    const messages: never[] = [];
    const stable = input({ messages });
    const a = selector.select(stable);
    const b = selector.select(stable);
    expect(b).toBe(a);
    const c = selector.select(input({ messages, tokens }));
    expect(c).not.toBe(a);
    const d = selector.select(input({ messages, cost: 3 }));
    expect(d).not.toBe(c);
  });

  test('changing scope, catalog, MCP servers or staleness recomputes', () => {
    const selector = new UsageAnalyticsSelector();
    const messages: never[] = [];
    const catalog: never[] = [];
    const mcpServers: never[] = [];
    const base = selector.select(input({ messages, catalog, mcpServers }));

    expect(selector.select(input({ messages, catalog, mcpServers }))).toBe(base);
    expect(selector.select(input({ messages, catalog, mcpServers, serverID: 'remote' }))).not.toBe(
      base,
    );
    expect(selector.select(input({ messages, catalog, mcpServers, sessionID: 'ses_b' }))).not.toBe(
      base,
    );
    expect(selector.select(input({ messages, catalog: [], mcpServers, stale: true }))).not.toBe(
      base,
    );
  });
});
