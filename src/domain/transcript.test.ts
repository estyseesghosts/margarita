import { describe, expect, test } from 'bun:test';

import { sanitizeTerminalText } from './sanitize-text.ts';
import {
  type AssistantPart,
  foldTranscript,
  formatToolTiming,
  groupKey,
  type ToolCall,
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
    expect(kinds(nodes)).toEqual(['group(20)', 'tool', 'text']);
    const group = nodes[0];
    expect(group?.kind === 'tool-group' && group.summary).toBe(
      'Ran 11 shell commands, read 3 files, edited 6 files',
    );
    expect(group?.kind === 'tool-group' && group.tools.map((entry) => entry.id)).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `s${index}`),
      'read1',
      'read2',
      'read3',
      ...Array.from({ length: 6 }, (_, index) => `e${index}`),
      's10',
    ]);
    const failed = nodes[1];
    expect(failed?.kind === 'tool' && failed.tool.status).toBe('error');
    expect(failed?.kind === 'tool' && failed.expanded).toBe(true);
    expect(nodes[2]?.kind).toBe('text');
    // The brief progress chatter folds away; it is not rendered as its own row.
    expect(
      nodes.some((node) => node.kind === 'text' && node.text.includes('Running the build')),
    ).toBe(false);
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
    const failed = nodes[1];
    expect(failed?.kind === 'tool' && failed.tool.error).toBe('exit 1');
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

  test('progress notes before a turn’s final message still fold', () => {
    const nodes = foldTranscript(
      [user('u1', 'go'), reply('a1', 'Looking now.'), reply('a2', 'Done.'), user('u2', 'more')],
      compact,
    );
    expect(texts(nodes)).toEqual(['Done.']);
  });

  test('queued follow-ups sharing one run each keep their answer', () => {
    const nodes = foldTranscript(
      [user('u1', 'one'), reply('a1', 'First.'), user('u2', 'two'), reply('a2', 'Second.')],
      compact,
    );
    expect(texts(nodes)).toEqual(['First.', 'Second.']);
  });
});
