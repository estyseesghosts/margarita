import { describe, expect, test } from 'bun:test';

import type { ExecutionMarker } from './execution-segment.ts';
import { sanitizeTerminalText } from './sanitize-text.ts';
import { cellWidth } from './text-width.ts';
import {
  type AssistantPart,
  attachBackgroundNotices,
  backgroundHint,
  boundedPreview,
  boundedTailPreview,
  cachedToolResult,
  describeTool,
  foldTranscript,
  formatToolTiming,
  groupKey,
  maxInlinePreviewRows,
  nodeIndexForTool,
  prettyJson,
  previewBudget,
  semanticPreview,
  semanticResultKind,
  type ToolCall,
  toolFileLabel,
  toolFileWindow,
  toolMetadataRowBudget,
  type TranscriptMessage,
  type TranscriptNode,
  transcriptWindowStep,
  windowNodes,
} from './transcript.ts';

function tool(id: string, name: string, status: ToolCall['status'] = 'completed'): AssistantPart {
  return {
    kind: 'tool',
    tool: {
      id,
      name,
      status,
      input: { filePath: `${id}.ts` },
      startedAt: 0,
      ...(status === 'error' ? { error: 'exit 1' } : {}),
    },
  };
}

function assistant(
  parts: AssistantPart[],
  extra: { reasoningTokens?: number } = {},
): TranscriptMessage {
  return {
    kind: 'assistant',
    id: 'm1',
    createdAt: 0,
    agent: 'build',
    model: { providerID: 'p', modelID: 'm' },
    parts,
    ...extra,
  };
}

const compact = { detailed: false, expandedGroups: new Set<string>() };
const detailed = { detailed: true, expandedGroups: new Set<string>() };

/** Two expanded running calls, so each tool is its own node for background-anchor tests. */
function foldedTwoRunningTools(): TranscriptNode[] {
  return foldTranscript(
    [user('u1', 'go'), assistant([tool('t1', 'bash', 'running'), tool('t2', 'bash', 'running')])],
    detailed,
  );
}

function kinds(nodes: TranscriptNode[]): string[] {
  return nodes.map((node) =>
    node.kind === 'tool-group' ? `group(${node.tools.length})` : node.kind,
  );
}

describe('foldTranscript', () => {
  test('three reads fold into one group with a data-derived summary', () => {
    const nodes = foldTranscript(
      [assistant([tool('a', 'read'), tool('b', 'read'), tool('c', 'grep')])],
      compact,
    );
    expect(kinds(nodes)).toEqual(['group(3)']);
    const [group] = nodes;
    expect(group?.kind === 'tool-group' && group.summary).toBe(
      'Read 2 files, searched for 1 pattern',
    );
  });

  test('a failure splits groups and is shown expanded', () => {
    const nodes = foldTranscript(
      [
        assistant([
          tool('a', 'read'),
          tool('b', 'read'),
          tool('c', 'bash', 'error'),
          tool('d', 'read'),
          tool('e', 'read'),
        ]),
      ],
      compact,
    );
    expect(kinds(nodes)).toEqual(['group(2)', 'tool', 'group(2)']);
    const failed = nodes[1];
    expect(failed?.kind === 'tool' && failed.expanded).toBe(true);
  });

  test('every tool is recoverable from the folded nodes', () => {
    const parts = [tool('a', 'read'), tool('b', 'edit'), tool('c', 'grep'), tool('d', 'glob')];
    const nodes = foldTranscript([assistant(parts)], compact);
    const ids = nodes.flatMap((node) =>
      node.kind === 'tool-group'
        ? node.tools.map((entry) => entry.id)
        : node.kind === 'tool'
          ? [node.tool.id]
          : [],
    );
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  test('assistant text is a group boundary', () => {
    const nodes = foldTranscript(
      [
        assistant([
          tool('a', 'read'),
          tool('b', 'read'),
          { kind: 'text', text: 'Found it.' },
          tool('c', 'read'),
        ]),
      ],
      compact,
    );
    expect(kinds(nodes)).toEqual(['group(2)', 'text', 'group(1)']);
  });

  test('a large inline diff is collapsed by default and expandable via expandedDiffs', () => {
    const diffLines = ['--- a/f.ts', '+++ b/f.ts', '@@ -1,1 +1,40 @@'];
    diffLines.push(...Array.from({ length: 40 }, (_, index) => `+row${index}`));
    const editTool: ToolCall = {
      id: 'd1',
      name: 'edit',
      status: 'completed',
      input: { filePath: 'f.ts' },
      startedAt: 0,
      diff: diffLines.join('\n'),
    };
    const parts: AssistantPart[] = [{ kind: 'tool', tool: editTool }];

    const collapsed = foldTranscript([assistant(parts)], compact);
    expect(collapsed[0]).toMatchObject({ kind: 'tool', expanded: false });

    const expanded = foldTranscript([assistant(parts)], {
      detailed: false,
      expandedGroups: new Set(),
      expandedDiffs: new Set(['d1']),
    });
    expect(expanded[0]).toMatchObject({ kind: 'tool', expanded: true });
  });

  test('expanded group state is keyed by the first child ID', () => {
    const parts = [tool('a', 'read'), tool('b', 'read')];
    const key = groupKey([{ id: 'a', name: 'read', status: 'completed', input: {}, startedAt: 0 }]);
    const nodes = foldTranscript([assistant(parts)], {
      detailed: false,
      expandedGroups: new Set([key]),
    });
    expect(nodes[0]?.kind === 'tool-group' && nodes[0].expanded).toBe(true);
  });

  test('unfinished empty reasoning produces no node in compact mode', () => {
    const parts: AssistantPart[] = [
      { kind: 'reasoning', text: '', done: false },
      { kind: 'text', text: 'Answer' },
    ];
    expect(kinds(foldTranscript([assistant(parts)], compact))).toEqual(['text']);
    // Even with visible tool activity around it, nothing placeholder-like appears.
    const mixed: AssistantPart[] = [
      tool('a', 'read'),
      { kind: 'reasoning', text: '', done: false },
      tool('b', 'read'),
    ];
    expect(kinds(foldTranscript([assistant(mixed)], compact))).toEqual(['group(2)']);
  });

  test('completed empty reasoning produces no node in detailed mode either', () => {
    const parts: AssistantPart[] = [
      { kind: 'reasoning', text: '', done: false },
      { kind: 'reasoning', text: 'real thought', done: true },
    ];
    const nodes = foldTranscript([assistant(parts)], detailed);
    expect(nodes.map((node) => node.kind)).toEqual(['reasoning']);
    expect(nodes[0]).toEqual({
      kind: 'reasoning',
      key: 'm1:1',
      text: 'real thought',
      done: true,
    });
  });

  test('a running compaction renders no transcript row; terminal states render one notice', () => {
    const running = foldTranscript(
      [{ kind: 'compaction', id: 'c', createdAt: 5, state: 'running' }],
      compact,
    );
    expect(running).toEqual([]);
    expect(
      foldTranscript([{ kind: 'compaction', id: 'c', createdAt: 5, state: 'completed' }], compact),
    ).toEqual([{ kind: 'notice', key: 'c', text: 'Conversation compacted', tone: 'dim' }]);
    expect(
      foldTranscript([{ kind: 'compaction', id: 'c', createdAt: 5, state: 'failed' }], compact),
    ).toEqual([{ kind: 'notice', key: 'c', text: 'Compaction failed', tone: 'error' }]);
  });

  test('reasoning text is hidden by default and shown exactly in detailed mode', () => {
    const parts: AssistantPart[] = [
      { kind: 'reasoning', text: 'consider X', done: true },
      { kind: 'text', text: 'Answer' },
    ];
    expect(kinds(foldTranscript([assistant(parts)], compact))).toEqual(['text']);
    const nodes = foldTranscript([assistant(parts)], detailed);
    expect(nodes[0]).toEqual({ kind: 'reasoning', key: 'm1:0', text: 'consider X', done: true });
  });

  test('reasoning tokens without text are reported, never fabricated', () => {
    const nodes = foldTranscript(
      [assistant([{ kind: 'text', text: 'Answer' }], { reasoningTokens: 900 })],
      detailed,
    );
    expect(nodes.at(-1)).toEqual({
      kind: 'reasoning-unavailable',
      key: 'm1:reasoning',
      tokens: 900,
    });
    expect(
      kinds(
        foldTranscript(
          [assistant([{ kind: 'text', text: 'A' }], { reasoningTokens: 900 })],
          compact,
        ),
      ),
    ).toEqual(['text']);
  });

  test('detailed mode shows every tool individually', () => {
    const nodes = foldTranscript([assistant([tool('a', 'read'), tool('b', 'read')])], detailed);
    expect(kinds(nodes)).toEqual(['tool', 'tool']);
  });

  test('failed idle outcome is a visible error notice', () => {
    const nodes = foldTranscript(
      [{ kind: 'idle', id: 'i', createdAt: 0, outcome: 'failed', error: 'rate limited' }],
      compact,
    );
    expect(nodes).toEqual([
      { kind: 'notice', key: 'i', text: 'Run failed: rate limited', tone: 'error' },
    ]);
  });
});

describe('sanitizeTerminalText', () => {
  test('removes escape sequences, OSC clipboard writes and bidi overrides', () => {
    const hostile = 'ok\u001b[2J\u001b]52;c;ZXZpbA==\u0007 done‮!\r\nnext';
    expect(sanitizeTerminalText(hostile)).toBe('ok done!\nnext');
  });
  test('keeps tabs, newlines and unicode', () => {
    expect(sanitizeTerminalText('a\tb\nçé 🐱')).toBe('a\tb\nçé 🐱');
  });
});

function testClock(at: number): string {
  return `t${at}`;
}

describe('windowNodes', () => {
  test('keeps the newest nodes and counts the hidden ones', () => {
    const nodes = Array.from({ length: 450 }, (_, index) => index);
    const { visible, hidden } = windowNodes(nodes, transcriptWindowStep);
    expect(visible).toHaveLength(200);
    expect(visible[0]).toBe(250);
    expect(hidden).toBe(250);
    expect(windowNodes(nodes, 1000)).toEqual({ visible: nodes, hidden: 0 });
  });

  test('tool timing shows start clock and duration once complete', () => {
    const call = {
      id: 't',
      name: 'read',
      status: 'completed' as const,
      input: {},
      startedAt: 1000,
    };
    expect(formatToolTiming(call, testClock)).toBe('t1000');
    expect(formatToolTiming({ ...call, completedAt: 2234 }, testClock)).toBe('t1000 · 1.2s');
    expect(formatToolTiming({ ...call, completedAt: 61_000 }, testClock)).toBe('t1000 · 60s');
  });
});

describe('grouping across messages', () => {
  test('calls split over consecutive assistant messages form one group', () => {
    const nodes = foldTranscript(
      [
        assistant([tool('a', 'bash')]),
        assistant([tool('b', 'bash')]),
        assistant([tool('c', 'grep')]),
      ],
      compact,
    );
    expect(kinds(nodes)).toEqual(['group(3)']);
    const group = nodes[0];
    expect(group?.kind === 'tool-group' && group.summary).toBe(
      'Ran 2 shell commands, searched for 1 pattern',
    );
  });
});

/** Assistant message carrying an id (existing helper hardcodes 'm1'). */
function assistantWithId(id: string, parts: AssistantPart[]): TranscriptMessage {
  return {
    kind: 'assistant',
    id,
    createdAt: 1,
    agent: 'build',
    model: { providerID: 'p', modelID: 'm' },
    parts,
  };
}
const groupedBash = (id: string): AssistantPart => tool(id, 'bash');
const groupedEdit = (
  id: string,
  filePath = `${id}.ts`,
  status: ToolCall['status'] = 'completed',
): AssistantPart => ({
  kind: 'tool',
  tool: {
    id,
    name: 'edit',
    status,
    input: { filePath },
    startedAt: 0,
    ...(status === 'error' ? { error: 'exit 1' } : {}),
  },
});

function runFixture(): TranscriptMessage[] {
  return [
    assistantWithId('mA', [
      ...Array.from({ length: 10 }, (_, index) => groupedBash(`s${index}`)),
      { kind: 'text', text: 'Running the build.' },
      tool('read1', 'read'),
      tool('read2', 'read'),
      tool('read3', 'read'),
    ]),
    assistantWithId('mB', [
      ...Array.from({ length: 6 }, (_, index) => groupedEdit(`e${index}`, 'src/index.ts')),
      groupedBash('s10'),
    ]),
    assistantWithId('mC', [groupedEdit('eFailed', 'src/fixed.ts', 'error')]),
    assistantWithId('mD', [
      { kind: 'text', text: 'The rewrite is complete: tests are green and the diff is ready.' },
    ]),
  ];
}

describe('grouped activity (issue #23)', () => {
  test('a full run folds into a few meaningful rows; failure and final reply stay visible', () => {
    const nodes = foldTranscript(runFixture(), compact);
    // The short progress note is preserved (#167); tools still fold into groups around it.
    expect(kinds(nodes)).toEqual(['group(10)', 'text', 'group(10)', 'tool', 'text']);
    expect(nodes[0]?.kind === 'tool-group' && nodes[0].summary).toBe('Ran 10 shell commands');
    expect(nodes[2]?.kind === 'tool-group' && nodes[2].summary).toBe(
      'Read 3 files, edited 6 files, ran 1 shell command',
    );
    const allToolIds = nodes.flatMap((node) =>
      node.kind === 'tool-group' ? node.tools.map((entry) => entry.id) : [],
    );
    expect(allToolIds).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `s${index}`),
      'read1',
      'read2',
      'read3',
      ...Array.from({ length: 6 }, (_, index) => `e${index}`),
      's10',
    ]);
    const failed = nodes[3];
    expect(failed?.kind === 'tool' && failed.tool.status).toBe('error');
    expect(failed?.kind === 'tool' && failed.expanded).toBe(true);
    expect(nodes[4]?.kind).toBe('text');
    // The brief progress note now remains visible instead of folding away (#167).
    expect(
      nodes.some((node) => node.kind === 'text' && node.text.includes('Running the build')),
    ).toBe(true);
  });

  test('detailed mode shows every underlying call in transcript order', () => {
    const nodes = foldTranscript(runFixture(), detailed);
    const ids = nodes.flatMap((node) => (node.kind === 'tool' ? [node.tool.id] : []));
    expect(ids).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `s${index}`),
      'read1',
      'read2',
      'read3',
      ...Array.from({ length: 6 }, (_, index) => `e${index}`),
      's10',
      'eFailed',
    ]);
    const texts = nodes.flatMap((node) => (node.kind === 'text' ? [node.text] : []));
    expect(texts).toContain('Running the build.');
    expect(texts).toContain('The rewrite is complete: tests are green and the diff is ready.');
  });

  test('a singleton edit keeps its own inline-diff row instead of a group summary', () => {
    const nodes = foldTranscript([assistantWithId('m1', [groupedEdit('only', 'f.ts')])], compact);
    expect(nodes[0]?.kind).toBe('tool');
    expect(nodes[0]?.kind === 'tool' && nodes[0].tool.id).toBe('only');
  });

  test('grouping is deterministic across canonical re-folds of a replayed history', () => {
    const first = foldTranscript(runFixture(), compact);
    // The server re-emits identical history as fresh objects; keys and shape are stable.
    const replay = structuredClone(runFixture());
    const second = foldTranscript(replay, compact);
    expect(kinds(second)).toEqual(kinds(first));
    expect(second.map((node) => node.key)).toEqual(first.map((node) => node.key));
  });

  test('a failure is never folded into the counts of the surrounding group', () => {
    const nodes = foldTranscript(runFixture(), compact);
    const failed = nodes[3];
    expect(failed?.kind === 'tool' && failed.tool.error).toBe('exit 1');
  });
});

const withMcp = (servers: readonly string[]) => ({
  ...compact,
  mcpServers: servers,
});
const mcp = (
  id: string,
  name: string,
  status: ToolCall['status'] = 'completed',
): AssistantPart => ({
  kind: 'tool',
  tool: {
    id,
    name,
    status,
    input: { issue: '7' },
    startedAt: 0,
    ...(status === 'error' ? { error: 'rate limited' } : {}),
  },
});
function summaryOf(nodes: TranscriptNode[]): string | undefined {
  const group = nodes.find((node) => node.kind === 'tool-group');
  return group?.kind === 'tool-group' ? group.summary : undefined;
}

function runningTool(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
  startedAt = 10,
): ToolCall {
  return { id, name, status: 'running', input, startedAt };
}

function toolPart(entry: ToolCall): AssistantPart {
  return { kind: 'tool', tool: entry };
}

describe('MCP activity in compact groups (issue #74)', () => {
  test('a mixed fixture names reads, MCP calls and shell commands together', () => {
    const parts: AssistantPart[] = [
      tool('r1', 'read'),
      tool('r2', 'read'),
      ...Array.from({ length: 4 }, (_, index) => mcp(`l${index}`, 'lotus_get_issue')),
      tool('s1', 'bash'),
      tool('s2', 'bash'),
    ];
    const nodes = foldTranscript([assistant(parts)], withMcp(['lotus']));
    expect(kinds(nodes)).toEqual(['group(8)']);
    expect(summaryOf(nodes)).toBe('Read 2 files, called lotus 4 times, ran 2 shell commands');
    // No MCP call was mislabeled as a shell command, and every call stays recoverable.
    const group = nodes[0];
    expect(group?.kind === 'tool-group' && group.tools.map((entry) => entry.id)).toEqual([
      'r1',
      'r2',
      'l0',
      'l1',
      'l2',
      'l3',
      's1',
      's2',
    ]);
  });

  test('two MCP servers stay distinguishable and single calls read singular', () => {
    const nodes = foldTranscript(
      [
        assistant([
          mcp('l1', 'lotus_get_issue'),
          mcp('s1', 'sentry_list_issues'),
          mcp('s2', 'sentry_list_issues'),
        ]),
      ],
      withMcp(['lotus', 'sentry']),
    );
    expect(summaryOf(nodes)).toBe('Called lotus 1 time, called sentry 2 times');
  });

  test('an unrecognized tool is external, never attributed to a configured server', () => {
    const nodes = foldTranscript([assistant([mcp('x1', 'mystery_do_thing')])], withMcp(['lotus']));
    expect(kinds(nodes)).toEqual(['group(1)']);
    const summary = foldTranscript(
      [assistant([tool('r1', 'read'), mcp('x1', 'mystery_do_thing')])],
      withMcp(['lotus']),
    );
    expect(summaryOf(summary)).toBe('Read 1 file, called 1 external tool');
  });

  test('servers with a shared prefix cannot steal each other’s calls', () => {
    const nodes = foldTranscript(
      [assistant([mcp('a1', 'a_do'), mcp('b1', 'a_b_do'), mcp('b2', 'a_b_run')])],
      withMcp(['a', 'a_b']),
    );
    expect(summaryOf(nodes)).toBe('Called a 1 time, called a_b 2 times');
  });

  test('a failed MCP call stays visible instead of folding into success counts', () => {
    const nodes = foldTranscript(
      [assistant([mcp('l1', 'lotus_get_issue'), mcp('l2', 'lotus_get_issue', 'error')])],
      withMcp(['lotus']),
    );
    // The successful call forms a one-call group; the failure is its own visible row.
    expect(kinds(nodes)).toEqual(['group(1)', 'tool']);
    const failed = nodes[1];
    expect(failed?.kind === 'tool' && failed.tool.status).toBe('error');
    expect(failed?.kind === 'tool' && failed.expanded).toBe(true);
  });

  test('running MCP calls stay in the group, and expanded rows name the server', () => {
    const parts = [mcp('l1', 'lotus_get_issue', 'running'), mcp('l2', 'lotus_get_issue')];
    const nodes = foldTranscript([assistant(parts)], withMcp(['lotus']));
    expect(nodes[0]?.kind === 'tool-group' && nodes[0].running).toBe(true);
    expect(summaryOf(nodes)).toBe('Called lotus 2 times');
  });

  test('MCP calls are shown individually in detailed mode with server identity', () => {
    const nodes = foldTranscript([assistant([mcp('l1', 'lotus_get_issue')])], {
      ...detailed,
      mcpServers: ['lotus'],
    });
    expect(nodes.map((node) => node.kind)).toEqual(['tool']);
    const call = nodes[0];
    expect(call?.kind === 'tool' ? describeTool(call.tool, ['lotus']) : undefined).toBe(
      'lotus: get_issue',
    );
  });
});

const child = (
  parentID: string,
  index: number,
  name: string,
  status: ToolCall['status'] = 'completed',
) => ({ id: `${parentID}:${index}`, parentID, index, name, status });

const code = (
  id: string,
  children: ReturnType<typeof child>[] | undefined,
  status: ToolCall['status'] = 'completed',
): AssistantPart => ({
  kind: 'tool',
  tool: {
    id,
    name: 'execute',
    status,
    input: { code: 'await lotus.step_frame()' },
    startedAt: 0,
    ...(children === undefined ? {} : { children }),
  },
});

describe('Code Mode child activity (#217)', () => {
  test('four nested Lotus calls count as Lotus, not as a shell command', () => {
    const nodes = foldTranscript(
      [
        assistant([
          code(
            'exec',
            Array.from({ length: 4 }, (_, index) => child('exec', index, 'lotus.step_frame')),
          ),
        ]),
      ],
      withMcp(['lotus']),
    );
    expect(kinds(nodes)).toEqual(['group(1)']);
    expect(summaryOf(nodes)).toBe('Called lotus 4 times');
  });

  test('mixed direct and nested activity counts each operation once', () => {
    const nodes = foldTranscript(
      [
        assistant([
          tool('r1', 'read'),
          mcp('d1', 'lotus_get_issue'),
          code('exec', [
            child('exec', 0, 'lotus.step_frame'),
            child('exec', 1, 'read'),
            child('exec', 2, 'bash'),
          ]),
          tool('s1', 'bash'),
        ]),
      ],
      withMcp(['lotus']),
    );
    expect(summaryOf(nodes)).toBe('Read 2 files, called lotus 2 times, ran 2 shell commands');
  });

  test('a failed child never folds out of sight, even when the parent completed', () => {
    const nodes = foldTranscript(
      [assistant([code('exec', [child('exec', 0, 'lotus.fail', 'error')])])],
      withMcp(['lotus']),
    );
    expect(kinds(nodes)).toEqual(['tool']);
    const entry = nodes[0];
    expect(entry?.kind === 'tool' && entry.category).toBe('code');
    expect(entry?.kind === 'tool' && entry.expanded).toBe(true);
  });

  test('compact live activity follows the running nested operation', () => {
    const nodes = foldTranscript(
      [
        assistant([
          code(
            'exec',
            [
              child('exec', 0, 'lotus.step_frame', 'completed'),
              child('exec', 1, 'lotus.get_issue', 'running'),
            ],
            'running',
          ),
        ]),
      ],
      withMcp(['lotus']),
    );
    const group = nodes[0];
    expect(group?.kind === 'tool-group' && group.live?.text).toBe('lotus: get_issue');
    expect(group?.kind === 'tool-group' && group.live?.shell).toBe(false);
  });
});

describe('live action beneath a collapsed group (issue #75)', () => {
  test('a running shell command is the live line while collapsed', () => {
    const nodes = foldTranscript(
      [
        assistant([
          toolPart({ ...runningTool('h', 'read', { path: 'src/a.ts' }, 1), status: 'completed' }),
          toolPart({ ...runningTool('h2', 'read', { path: 'src/b.ts' }, 2), status: 'completed' }),
          toolPart(
            runningTool('s', 'shell', { command: 'tail -8 /var/log/platinum.log\nmore args' }),
          ),
        ]),
      ],
      compact,
    );
    const group = nodes[0];
    expect(group?.kind === 'tool-group' && group.expanded).toBe(false);
    expect(group?.kind === 'tool-group' && group.live?.text).toBe(
      '$ tail -8 /var/log/platinum.log',
    );
  });

  test('an MCP call names its server and operation', () => {
    const nodes = foldTranscript(
      [assistant([toolPart(runningTool('l', 'lotus_get_issue', { id: 4 }))])],
      { ...compact, mcpServers: ['lotus'] },
    );
    expect(nodes[0]?.kind === 'tool-group' && nodes[0].live?.text).toBe('lotus: get_issue');
  });

  test('the live line follows the most recently started call, not the last seen', () => {
    const nodes = foldTranscript(
      [
        assistant([
          toolPart(runningTool('slow', 'read', { path: 'src/slow.ts' }, 5)),
          toolPart(runningTool('new', 'shell', { command: 'bun test' }, 9)),
        ]),
      ],
      compact,
    );
    expect(nodes[0]?.kind === 'tool-group' && nodes[0].live?.text).toBe('$ bun test');
  });

  test('a finished call leaves no stale live line on historical groups', () => {
    const nodes = foldTranscript(
      [
        assistant([
          toolPart({
            ...runningTool('s', 'shell', { command: 'bun test' }),
            status: 'completed',
            completedAt: 20,
          }),
          { kind: 'text', text: 'The tests are green.' },
        ]),
      ],
      compact,
    );
    expect(nodes[0]?.kind === 'tool-group' && nodes[0].live).toBeUndefined();
  });

  test('a failing call is not presented as currently running', () => {
    const nodes = foldTranscript(
      [
        assistant([
          toolPart({
            ...runningTool('f', 'shell', { command: 'false' }),
            status: 'error',
            error: 'exit 1',
          }),
        ]),
      ],
      compact,
    );
    expect(nodes[0]?.kind).toBe('tool');
  });

  test('the live line is sanitized to a single row', () => {
    const nodes = foldTranscript(
      [assistant([toolPart(runningTool('s', 'shell', { command: 'echo \u001b[2Jhi\nsecond' }))])],
      compact,
    );
    const live = nodes[0]?.kind === 'tool-group' ? nodes[0].live : undefined;
    expect(live?.text.includes('\n')).toBe(false);
    expect(live?.text.startsWith('$ echo ')).toBe(true);
  });
});

function hintRunning(
  id: string,
  name: string,
  startedAt: number,
  input: Record<string, unknown> = {},
): ToolCall {
  return { id, name, status: 'running', input, startedAt };
}

function liveOf(startedAt: number) {
  const nodes = foldTranscript(
    [assistant([toolPart(hintRunning('s', 'shell', startedAt, { command: 'bun test' }))])],
    compact,
  );
  return nodes[0]?.kind === 'tool-group' ? nodes[0].live : undefined;
}

function liveOfExternal(name: string, input: Record<string, unknown> = {}) {
  const nodes = foldTranscript([assistant([toolPart(runningTool('x', name, input, 1))])], compact);
  return nodes[0]?.kind === 'tool-group' ? nodes[0].live : undefined;
}

describe('unknown external tools are named in the live line (issue #114)', () => {
  test('an executing external tool with empty input shows its name, not just Calling', () => {
    const live = liveOfExternal('weather_get_forecast');
    expect(live?.text).toBe('weather_get_forecast');
    expect(live?.text).not.toBe('Calling');
  });

  test('an external tool with arguments shows a short safe name and target', () => {
    const live = liveOfExternal('weather_get_forecast', { query: 'London' });
    expect(live?.text).toBe('weather_get_forecast London');
  });

  test('terminal escape sequences are stripped from the external tool name', () => {
    const live = liveOfExternal('weather\u001b[2J_get_forecast');
    expect(live?.text).toBe('weather_get_forecast');
  });

  test('a newline in the external tool name is clipped to the first line', () => {
    const live = liveOfExternal('weather_get\nforecast');
    expect(live?.text).toBe('weather_get');
  });

  test('a very long external tool name is clamped with an ellipsis', () => {
    const live = liveOfExternal('x'.repeat(200));
    expect(live?.text).toBe('x'.repeat(47) + '…');
  });

  test('a long argument is truncated and does not leak the full payload', () => {
    const live = liveOfExternal('weather_get_forecast', {
      query: 'a'.repeat(200),
    });
    expect(live?.text).toBe(`weather_get_forecast ${'a'.repeat(47)}…`);
  });

  test('a recognized MCP call still names its server and operation', () => {
    const nodes = foldTranscript(
      [assistant([toolPart(runningTool('l', 'lotus_get_issue', { id: 4 }))])],
      { ...compact, mcpServers: ['lotus'] },
    );
    expect(nodes[0]?.kind === 'tool-group' && nodes[0].live?.text).toBe('lotus: get_issue');
  });
});

describe('background hint after a long running shell command (issue #76)', () => {
  test('the hint appears only after strictly more than 10 seconds', () => {
    expect(backgroundHint(liveOf(1000), 10_000)).toBe(false); // 9.0s
    expect(backgroundHint(liveOf(1000), 10_999)).toBe(false); // 9.999s
    expect(backgroundHint(liveOf(1000), 11_000)).toBe(false); // exactly 10.0s
    expect(backgroundHint(liveOf(1000), 11_001)).toBe(true); // 10.001s
  });

  test('a long MCP, read or reasoning phase never inherits the shell hint', () => {
    const mcpGroup = foldTranscript(
      [assistant([toolPart(hintRunning('l', 'lotus_get_issue', 1))])],
      { ...compact, mcpServers: ['lotus'] },
    );
    const mcpLive = mcpGroup[0]?.kind === 'tool-group' ? mcpGroup[0].live : undefined;
    expect(backgroundHint(mcpLive, 60_000)).toBe(false);

    const readGroup = foldTranscript(
      [assistant([toolPart(hintRunning('r', 'read', 1, { path: 'src/a.ts' }))])],
      compact,
    );
    const readLive = readGroup[0]?.kind === 'tool-group' ? readGroup[0].live : undefined;
    expect(backgroundHint(readLive, 60_000)).toBe(false);
  });

  test('a completed shell call never earns the hint, however long it is shown', () => {
    const nodes = foldTranscript(
      [
        assistant([
          toolPart({
            id: 's',
            name: 'shell',
            status: 'completed',
            input: { command: 'bun test' },
            startedAt: 1,
            completedAt: 90_000,
          }),
        ]),
      ],
      compact,
    );
    const live = nodes[0]?.kind === 'tool-group' ? nodes[0].live : undefined;
    expect(live).toBeUndefined();
    expect(backgroundHint(live, 90_000)).toBe(false);
  });

  test('the live call carries its own start, so the hint times the call not the turn', () => {
    const nodes = foldTranscript(
      [assistant([toolPart(hintRunning('s', 'shell', 42_000, { command: 'tail -f log' }))])],
      compact,
    );
    const live = nodes[0]?.kind === 'tool-group' ? nodes[0].live : undefined;
    expect(live?.startedAt).toBe(42_000);
    // A long turn (e.g. 60s of reads) followed by a fresh shell call shows no hint.
    expect(backgroundHint(live, 45_000)).toBe(false);
  });
});

const user = (id: string, text: string): TranscriptMessage => ({
  kind: 'user',
  id,
  createdAt: 0,
  text,
  attachments: [],
});
const reply = (id: string, ...texts: string[]): TranscriptMessage => ({
  ...assistant(texts.map((text): AssistantPart => ({ kind: 'text', text }))),
  id,
});
const texts = (nodes: TranscriptNode[]) =>
  nodes.flatMap((node) => (node.kind === 'text' ? [node.text] : []));
const visibleText = (messages: readonly TranscriptMessage[]) =>
  foldTranscript(messages, compact).flatMap((node) =>
    node.kind === 'text' ? [{ key: node.key, text: node.text }] : [],
  );

describe('foldTranscript answers across turns', () => {
  test('every completed turn keeps its short answer in compact mode', () => {
    const nodes = foldTranscript(
      [
        user('u1', 'Did the tests pass?'),
        reply('a1', 'Yes, 42 tests passed.'),
        user('u2', 'Check the README.'),
        reply('a2', 'One link is broken.'),
        user('u3', 'Fixed?'),
        reply('a3', 'Yes'),
      ],
      compact,
    );
    expect(texts(nodes)).toEqual(['Yes, 42 tests passed.', 'One link is broken.', 'Yes']);
  });

  test('progress notes before a turn’s final message stay visible (#167)', () => {
    const nodes = foldTranscript(
      [user('u1', 'go'), reply('a1', 'Looking now.'), reply('a2', 'Done.'), user('u2', 'more')],
      compact,
    );
    expect(texts(nodes)).toEqual(['Looking now.', 'Done.']);
  });

  test('queued follow-ups sharing one run each keep their answer', () => {
    const nodes = foldTranscript(
      [user('u1', 'one'), reply('a1', 'First.'), user('u2', 'two'), reply('a2', 'Second.')],
      compact,
    );
    expect(texts(nodes)).toEqual(['First.', 'Second.']);
  });
});

describe('background confirmation anchoring (#135)', () => {
  test('nodeIndexForTool finds the exact call, never a last-matching fallback', () => {
    const nodes = foldedTwoRunningTools();
    expect(nodeIndexForTool(nodes, 't1')).toBe(nodes.findIndex((node) => node.key === 't1'));
    expect(nodeIndexForTool(nodes, 't2')).toBe(nodes.findIndex((node) => node.key === 't2'));
    expect(nodeIndexForTool(nodes, 'missing')).toBeUndefined();
  });

  test('a confirmation attaches directly beneath its own tool', () => {
    const folded = foldedTwoRunningTools();
    const first = attachBackgroundNotices(folded, [{ toolID: 't1', text: 'Moved to background' }]);
    const firstKeys = first.map((node) => node.key);
    expect(firstKeys.indexOf('background:t1')).toBe(firstKeys.indexOf('t1') + 1);
    expect(firstKeys.indexOf('t2')).toBeGreaterThan(firstKeys.indexOf('background:t1'));

    const second = attachBackgroundNotices(folded, [{ toolID: 't2', text: 'Moved to background' }]);
    const secondKeys = second.map((node) => node.key);
    expect(secondKeys.indexOf('background:t2')).toBe(secondKeys.indexOf('t2') + 1);
    expect(secondKeys.indexOf('background:t2')).toBeGreaterThan(secondKeys.indexOf('t1'));
  });

  test('multiple concurrent calls get distinct notices with stable keys', () => {
    const annotated = attachBackgroundNotices(foldedTwoRunningTools(), [
      { toolID: 't1', text: 'Moved to background' },
      { toolID: 't2', text: 'Moved to background' },
    ]);
    const notices = annotated.filter((node) => node.kind === 'notice');
    expect(notices).toHaveLength(2);
    expect(new Set(notices.map((node) => node.key)).size).toBe(2);
  });

  test('a tool outside this window shows no notice instead of a wrong one', () => {
    const folded = foldedTwoRunningTools();
    expect(attachBackgroundNotices(folded, [{ toolID: 'gone', text: 'x' }])).toEqual([...folded]);
  });

  test('a folded group owns a confirmation for any call inside it', () => {
    const folded = foldTranscript(
      [user('u1', 'go'), assistant([tool('t1', 'bash', 'running'), tool('t2', 'bash', 'running')])],
      compact,
    );
    const groupIndex = folded.findIndex((node) => node.kind === 'tool-group');
    expect(groupIndex).toBeGreaterThanOrEqual(0);
    const annotated = attachBackgroundNotices(folded, [
      { toolID: 't2', text: 'Moved to background' },
    ]);
    expect(annotated[groupIndex + 1]?.kind).toBe('notice');
  });
});

/** A temporal snapshot sequence: folding is re-run after every canonical change (#168). */
describe('foldTranscript visible-text temporal invariant (#167, #168)', () => {
  test('short prose survives later reasoning, tool start, tool completion and run idle', () => {
    const prose = 'Found the cause. Checking the fix.';
    const u1 = user('u1', 'Investigate this');
    const a1 = assistantWithId('a1', [{ kind: 'text', text: prose }]);
    const reasoningStarted = assistantWithId('a2', [
      { kind: 'reasoning', text: '', done: false },
      tool('tool1', 'read', 'running'),
    ]);
    const toolCompleted = assistantWithId('a2', [
      { kind: 'reasoning', text: '', done: false },
      tool('tool1', 'read', 'completed'),
    ]);
    const idle: TranscriptMessage = {
      kind: 'idle',
      id: 'idle1',
      createdAt: 0,
      outcome: 'succeeded',
    };

    expect(visibleText([u1, a1])).toEqual([{ key: 'a1:0', text: prose }]);
    expect(visibleText([u1, a1, reasoningStarted])).toEqual([{ key: 'a1:0', text: prose }]);
    expect(visibleText([u1, a1, toolCompleted])).toEqual([{ key: 'a1:0', text: prose }]);
    expect(visibleText([u1, a1, toolCompleted, idle])).toEqual([{ key: 'a1:0', text: prose }]);
  });

  test('no length or newline discontinuity: 1, 80, 81 chars, multiline, multiple parts', () => {
    for (const sample of ['x', 'a'.repeat(80), 'b'.repeat(81), 'line one\nline two']) {
      const nodes = foldTranscript(
        [
          user('u1', 'go'),
          assistantWithId('a1', [{ kind: 'text', text: sample }]),
          assistantWithId('a2', [tool('t1', 'bash', 'running')]),
        ],
        compact,
      );
      expect(texts(nodes)).toContain(sample);
    }
    const parts = foldTranscript(
      [
        assistantWithId('a1', [
          { kind: 'text', text: 'one.' },
          { kind: 'text', text: 'two.' },
        ]),
      ],
      compact,
    );
    expect(texts(parts)).toEqual(['one.', 'two.']);
  });

  test('preserving text does not ungroup tools or reveal hidden reasoning', () => {
    const nodes = foldTranscript(
      [
        assistantWithId('a1', [
          { kind: 'text', text: 'Working.' },
          { kind: 'reasoning', text: 'secret chain of thought', done: true },
          tool('t1', 'read'),
          tool('t2', 'read'),
        ]),
      ],
      compact,
    );
    expect(texts(nodes)).toEqual(['Working.']);
    expect(kinds(nodes)).toEqual(['text', 'group(2)']);
    expect(nodes.some((node) => node.kind === 'reasoning')).toBe(false);
  });

  test('compact and detailed modes agree on visible prose; a fresh turn and reload agree', () => {
    const messages: TranscriptMessage[] = [
      user('u1', 'go'),
      assistantWithId('a1', [{ kind: 'text', text: 'Short.' }]),
      assistantWithId('a2', [tool('t1', 'read')]),
      user('u2', 'again'),
      assistantWithId('a3', [{ kind: 'text', text: 'Done.' }]),
    ];
    const compactTexts = texts(foldTranscript(messages, compact));
    expect(compactTexts).toEqual(['Short.', 'Done.']);
    // Reload/reconnect derives nodes from the same canonical messages, not cache state.
    expect(texts(foldTranscript([...messages], compact))).toEqual(compactTexts);
    expect(texts(foldTranscript(messages, detailed))).toEqual(compactTexts);
  });
});

const previewLines = (count: number, prefix = 'line'): string =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`).join('\n');

describe('bounded preview policy (#219, #220)', () => {
  test('detailed budgets are materially larger than compact and both stay bounded', () => {
    for (const kind of ['output', 'shell', 'diff', 'code', 'reasoning'] as const) {
      const compactBudget = previewBudget(kind, false);
      const detailedBudget = previewBudget(kind, true);
      expect(detailedBudget).toBeGreaterThan(compactBudget);
      expect(detailedBudget).toBeLessThanOrEqual(maxInlinePreviewRows);
      expect(previewBudget(kind, false, true)).toBe(maxInlinePreviewRows);
    }
  });

  test('a 200-line log shows more rows in detailed mode, never all 200 inline', () => {
    const text = previewLines(200);
    const compactView = boundedPreview(text, previewBudget('output', false), 80);
    const detailedView = boundedPreview(text, previewBudget('output', true), 80);
    expect(compactView.text.split('\n')).toHaveLength(12);
    expect(detailedView.text.split('\n')).toHaveLength(48);
    expect(compactView.hiddenRows).toBe(188);
    expect(detailedView.hiddenRows).toBe(152);
    expect(detailedView.text).not.toContain('line199');
  });

  test('wrapped lines consume multiple rendered rows', () => {
    const text = `${'x'.repeat(160)}\nshort`;
    const bounded = boundedPreview(text, 4, 40);
    expect(bounded.text).toBe('x'.repeat(160));
    expect(bounded.hiddenRows).toBe(1);
  });

  test('an overlong single line is clipped to compact, detailed and expanded budgets (#228)', () => {
    const ascii = 'x'.repeat(100_000);
    for (const budget of [previewBudget('output', false), previewBudget('output', true), 100]) {
      const bounded = boundedPreview(ascii, budget, 80);
      expect(cellWidth(bounded.text)).toBeLessThanOrEqual(budget * 80);
      expect(bounded.text.endsWith('…')).toBe(true);
      expect(bounded.hiddenRows).toBeGreaterThan(0);
    }
    expect(boundedPreview(ascii, 0, 80)).toEqual({ text: '', hiddenRows: 1250 });
  });

  test('wide text and tabs never exceed the row budget or split a grapheme', () => {
    const wide = boundedPreview('日'.repeat(5000), 2, 10);
    expect(cellWidth(wide.text)).toBeLessThanOrEqual(20);
    expect(wide.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);

    const tabs = boundedPreview('\t'.repeat(5000), 2, 10);
    expect(cellWidth(tabs.text)).toBeLessThanOrEqual(20);
  });

  test('a huge final error keeps its diagnosis inside the tail budget (#228)', () => {
    const text = `${'x'.repeat(100_000)}error: cannot find module`;
    const bounded = boundedTailPreview(text, 4, 40);
    expect(bounded.text.endsWith('error: cannot find module')).toBe(true);
    expect(bounded.text.startsWith('…')).toBe(true);
    expect(cellWidth(bounded.text)).toBeLessThanOrEqual(160);
    expect(bounded.hiddenRows).toBeGreaterThan(0);
  });

  test('tail preview keeps the diagnosis and counts the hidden head', () => {
    const text = `${previewLines(50)}\nerror: cannot find module`;
    const bounded = boundedTailPreview(text, 6, 80);
    expect(bounded.text).toContain('error: cannot find module');
    expect(bounded.text.split('\n')).toHaveLength(6);
    expect(bounded.hiddenRows).toBe(45);
  });

  test('pretty JSON reformats valid objects and leaves invalid text alone', () => {
    expect(prettyJson('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
    expect(prettyJson('not json')).toBeUndefined();
    expect(prettyJson('42')).toBeUndefined();
  });

  test('semantic previews pretty-print JSON but keep the source untouched', () => {
    const call: ToolCall = {
      id: 't1',
      name: 'readMcpResource',
      status: 'completed',
      input: {},
      output: '{"name":"resource","size":2}',
      startedAt: 0,
    };
    expect(semanticResultKind(call)).toBe('json');
    expect(semanticPreview(call).text).toContain('\n  "name": "resource"');
    expect(call.output).toBe('{"name":"resource","size":2}');
  });
});

describe('tool metadata budgets (#277)', () => {
  test('compact, detailed and expanded metadata budgets are ordered and bounded', () => {
    for (const kind of ['error', 'files'] as const) {
      const compactRows = toolMetadataRowBudget(kind, false);
      const detailedRows = toolMetadataRowBudget(kind, true);
      const expandedRows = toolMetadataRowBudget(kind, true, true);
      expect(compactRows).toBeGreaterThan(0);
      expect(detailedRows).toBeGreaterThan(compactRows);
      expect(expandedRows).toBeGreaterThan(detailedRows);
      expect(expandedRows).toBeLessThanOrEqual(48);
    }
  });

  test('file windows keep the first rows and report the exact hidden count', () => {
    const files = Array.from({ length: 1000 }, (_, index) => ({ name: `f${index}.ts` }));
    expect(toolFileWindow(files, 4)).toEqual({ visible: files.slice(0, 4), hidden: 996 });
    expect(toolFileWindow(files.slice(0, 2), 4)).toEqual({
      visible: files.slice(0, 2),
      hidden: 0,
    });
    expect(toolFileWindow(files, 0)).toEqual({ visible: [], hidden: 1000 });
  });

  test('file labels stay on one logical line and keep the full path', () => {
    expect(
      toolFileLabel({
        name: 'report\u001b[31m.pdf',
        mime: 'application/pdf',
        size: 2048,
        uri: 'file:///tmp/a\nb.pdf',
      }),
    ).toBe('report.pdf · application/pdf · 2.0 kB · file:///tmp/a b.pdf');
  });

  test('cached payloads retain every file and the script failure', () => {
    const files = Array.from({ length: 1000 }, (_, index) => ({ name: `f${index}.ts` }));
    const payload = cachedToolResult({
      id: 't1',
      name: 'execute',
      status: 'completed',
      input: {},
      files,
      executionError: 'script failed\nat line 2',
      startedAt: 0,
    });
    expect(payload.files).toHaveLength(1000);
    expect(payload.executionError).toBe('script failed\nat line 2');
  });

  test('a 10k-line and 200k-cell script error fits a compact physical-row budget', () => {
    const text = `${previewLines(10_000, 'error row ')}\n${'x'.repeat(200_000)}tail diagnosis`;
    const bounded = boundedTailPreview(text, toolMetadataRowBudget('error', false), 40);
    expect(bounded.text.split('\n').length).toBeLessThanOrEqual(4);
    expect(cellWidth(bounded.text)).toBeLessThanOrEqual(4 * 40);
    expect(bounded.text.endsWith('tail diagnosis')).toBe(true);
    expect(bounded.hiddenRows).toBeGreaterThan(0);
  });
});

const interruptionMarker = (id: string, afterMessageId: string): ExecutionMarker => ({
  id,
  afterMessageId,
  phase: 'interrupted',
  startedAt: 0,
  completedAt: 1500,
  durationMs: 1500,
});
const interruptedIdle = (id: string): TranscriptMessage => ({
  kind: 'idle',
  id,
  createdAt: 1500,
  outcome: 'interrupted',
});

describe('interruption consolidation (#207)', () => {
  test('one timed marker replaces the banner text and idle notice', () => {
    const messages: TranscriptMessage[] = [
      user('u1', 'go'),
      { ...assistant([{ kind: 'text', text: 'Step interrupted' }]), id: 'a1' },
      interruptedIdle('i1'),
    ];
    const markers = new Map([['i1', interruptionMarker('u1', 'i1')]]);
    const nodes = foldTranscript(messages, { ...compact, markers });

    expect(nodes.filter((node) => node.kind === 'execution')).toHaveLength(1);
    expect(
      nodes.some(
        (node) =>
          (node.kind === 'text' || node.kind === 'notice') && /interrupted/i.test(node.text),
      ),
    ).toBe(false);
    expect(nodes.find((node) => node.kind === 'execution')).toMatchObject({
      segment: { phase: 'interrupted', durationMs: 1500 },
    });
  });

  test('consecutive interrupted steps keep one marker each', () => {
    const messages: TranscriptMessage[] = [
      user('u1', 'first'),
      { ...assistant([{ kind: 'text', text: 'Interrupted' }]), id: 'a1' },
      interruptedIdle('i1'),
      user('u2', 'second'),
      { ...assistant([{ kind: 'text', text: '**Step interrupted.**' }]), id: 'a2' },
      interruptedIdle('i2'),
    ];
    const nodes = foldTranscript(messages, {
      ...compact,
      markers: new Map([
        ['i1', interruptionMarker('u1', 'i1')],
        ['i2', interruptionMarker('u2', 'i2')],
      ]),
    });
    expect(kinds(nodes)).toEqual(['user', 'execution', 'user', 'execution']);
  });

  test('detail prose after the banner is preserved', () => {
    const messages: TranscriptMessage[] = [
      user('u1', 'go'),
      {
        ...assistant([{ kind: 'text', text: 'Step interrupted: the provider timed out.' }]),
        id: 'a1',
      },
      interruptedIdle('i1'),
    ];
    const nodes = foldTranscript(messages, {
      ...compact,
      markers: new Map([['i1', interruptionMarker('u1', 'i1')]]),
    });
    expect(
      nodes.some(
        (node) => node.kind === 'text' && node.text === 'Step interrupted: the provider timed out.',
      ),
    ).toBe(true);
  });

  test('without a marker the idle notice remains the only status row', () => {
    const messages: TranscriptMessage[] = [
      user('u1', 'go'),
      { ...assistant([{ kind: 'text', text: 'Step interrupted' }]), id: 'a1' },
      interruptedIdle('i1'),
    ];
    const nodes = foldTranscript(messages, compact);
    expect(kinds(nodes)).toEqual(['user', 'text', 'notice']);
    expect(nodes.some((node) => node.kind === 'notice' && node.text === 'Interrupted')).toBe(true);
  });
});
