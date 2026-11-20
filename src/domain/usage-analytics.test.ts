import { describe, expect, test } from 'bun:test';

import type { CatalogModel } from './model-resolution.ts';
import type { TokenUsage } from './session.ts';
import type { ToolCall, TranscriptMessage } from './transcript.ts';
import { projectUsage } from './usage-analytics.ts';

const usage = (input: number, output: number, extra: Partial<TokenUsage> = {}): TokenUsage => ({
  input,
  output,
  reasoning: extra.reasoning ?? 0,
  cacheRead: extra.cacheRead ?? 0,
  cacheWrite: extra.cacheWrite ?? 0,
});

const catalog: CatalogModel[] = [
  {
    providerID: 'opencode',
    modelID: 'big',
    name: 'Big',
    enabled: true,
    variants: [],
    contextLimit: 1000,
  },
  {
    providerID: 'opencode',
    modelID: 'small',
    name: 'Small',
    enabled: true,
    variants: [],
    contextLimit: 200,
  },
];

const assistant = (
  id: string,
  createdAt: number,
  modelID: string,
  tokens?: TokenUsage,
  tools: ToolCall[] = [],
  completed = true,
): TranscriptMessage => ({
  kind: 'assistant',
  id,
  createdAt,
  ...(completed ? { completedAt: createdAt + 1 } : {}),
  agent: 'build',
  model: { providerID: 'opencode', modelID },
  parts: tools.map((tool) => ({ kind: 'tool' as const, tool })),
  ...(tokens === undefined ? {} : { usage: tokens }),
});

const tool = (id: string, name: string, status: ToolCall['status'] = 'completed'): ToolCall => ({
  id,
  name,
  status,
  input: {},
  startedAt: 1,
  completedAt: 2,
});

const compaction = (
  id: string,
  createdAt: number,
  state: 'completed' | 'failed' | 'running',
): TranscriptMessage => ({
  kind: 'compaction',
  id,
  createdAt,
  state,
});

const lifetime = usage(10_000, 2_000);

function base(messages: TranscriptMessage[], overrides: Record<string, unknown> = {}) {
  return projectUsage({
    serverID: 'local',
    sessionID: 'ses_a',
    messages,
    tokens: lifetime,
    cost: 1.25,
    catalog,
    ...overrides,
  });
}

describe('session usage analytics (#124)', () => {
  test('active context is the latest post-compaction step with that step model limit', () => {
    const result = base([
      assistant('a1', 10, 'big', usage(100, 20)),
      compaction('c1', 30, 'completed'),
      assistant('a2', 40, 'big', usage(300, 50, { cacheRead: 40, cacheWrite: 10 })),
      // A later step on a *different* model must use its own limit, not the selected one.
      assistant('a3', 50, 'small', usage(120, 30)),
    ]);
    expect(result.context.status).toBe('known');
    expect(result.context.tokens).toBe(150); // 120 + 30 for a3, not 400
    expect(result.context.limit).toBe(200); // small model's limit, not big's
    expect(result.context.occupancy).toBe(75);
    expect(result.context.model?.modelID).toBe('small');
    expect(result.context.sinceCompaction).toBe(550); // a2 (400) + a3 (150)
    expect(result.completedCompactions).toBe(1);
    expect(result.lastCompactionAt).toBe(30);
  });

  test('context drops after compaction while lifetime tokens and cost stay cumulative', () => {
    const rows = base([
      assistant('a1', 10, 'big', usage(900, 100)),
      compaction('c1', 20, 'completed'),
      assistant('a2', 30, 'big', usage(100, 20)),
    ]);
    expect(rows.context.tokens).toBe(120); // active context dropped
    expect(rows.lifetime).toEqual(lifetime); // lifetime unchanged
    expect(rows.cost).toBe(1.25);
  });

  test('a completed compaction with no following valid step is pending, not zero', () => {
    const rows = base([
      assistant('a1', 10, 'big', usage(100, 20)),
      compaction('c1', 20, 'completed'),
    ]);
    expect(rows.context.status).toBe('pending');
    expect(rows.context.tokens).toBeUndefined();
    expect(rows.context.occupancy).toBeUndefined();
  });

  test('a failed compaction does not reset context; a running one leaves it alone too', () => {
    const rows = base([
      assistant('a1', 10, 'big', usage(400, 100)),
      compaction('c1', 20, 'failed'),
      assistant('a2', 30, 'big', usage(100, 20)),
    ]);
    // The failed compaction is ignored: context stays at the latest step (a2), not reset.
    expect(rows.context.status).toBe('known');
    expect(rows.context.tokens).toBe(120);
    expect(rows.completedCompactions).toBe(0);
    expect(rows.context.sinceCompaction).toBeUndefined();
  });

  test('a staged revert excludes later steps; clearing it restores the latest step', () => {
    const messages = [
      assistant('a1', 10, 'big', usage(100, 20)),
      assistant('a2', 20, 'big', usage(200, 50)),
      assistant('a3', 30, 'big', usage(300, 60)),
    ];
    const staged = base(messages, { revertMessageID: 'a2' });
    expect(staged.context.tokens).toBe(250); // a2, a3 excluded
    const cleared = base(messages);
    expect(cleared.context.tokens).toBe(360); // a3 restored
  });

  test('a model with no known limit gives tokens without a fabricated percentage', () => {
    const rows = base([assistant('a1', 10, 'unknown-model', usage(120, 30))]);
    expect(rows.context.status).toBe('known');
    expect(rows.context.tokens).toBe(150);
    expect(rows.context.occupancy).toBeUndefined();
    expect(rows.context.limit).toBeUndefined();
  });

  test('unknown cost and missing lifetime are absent, not shown as zero', () => {
    const rows = projectUsage({
      serverID: 'local',
      sessionID: 'ses_a',
      messages: [],
      catalog,
    });
    expect(rows.cost).toBeUndefined();
    expect(rows.lifetime).toBeUndefined();
    expect(rows.context.status).toBe('unknown');
  });

  test('tool turn and category percentages use explicit, deduplicated denominators', () => {
    const messages: TranscriptMessage[] = [
      assistant('a1', 10, 'big', usage(1, 1), [tool('t1', 'read'), tool('t2', 'grep')]),
      assistant('a2', 20, 'big', usage(1, 1), [
        tool('t2', 'grep'),
        tool('t3', 'bash'),
        tool('t4', 'github_pr', 'error'),
      ]),
      assistant('a3', 30, 'big', usage(1, 1)), // completed turn, no tools
      assistant('a4', 40, 'big', undefined, [], false), // streaming, not a completed turn
    ];
    const rows = base(messages, { mcpServers: ['github'] });
    expect(rows.completedAssistantTurns).toBe(3);
    expect(rows.toolUsingTurns).toBe(2);
    expect(rows.toolTurnPercent).toBeCloseTo((2 / 3) * 100);
    expect(rows.toolCalls).toBe(4); // t2 deduplicated
    expect(rows.toolCategories.read).toBe(1);
    expect(rows.toolCategories.search).toBe(1);
    expect(rows.toolCategories.shell).toBe(1);
    expect(rows.toolCategories.mcp).toBe(1); // github_pr via configured MCP server
    expect(rows.toolCompleted).toBe(3);
    expect(rows.toolFailed).toBe(1);
    expect(rows.toolFailurePercent).toBeCloseTo(25); // 1 failed / 4 known outcomes
    expect(rows.loadedOnly).toBe(true);
  });

  test('no completed turns yields N/A ratios rather than dividing by zero', () => {
    const rows = base([assistant('a1', 10, 'big', undefined, [], false)]);
    expect(rows.toolTurnPercent).toBeUndefined();
    expect(rows.toolFailurePercent).toBeUndefined();
  });
});
