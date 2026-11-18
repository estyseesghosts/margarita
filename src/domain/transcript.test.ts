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

  test('expanded group state is keyed by the first child ID', () => {
    const parts = [tool('a', 'read'), tool('b', 'read')];
    const key = groupKey([{ id: 'a', name: 'read', status: 'completed', input: {}, startedAt: 0 }]);
    const nodes = foldTranscript([assistant(parts)], {
      detailed: false,
      expandedGroups: new Set([key]),
    });
    expect(nodes[0]?.kind === 'tool-group' && nodes[0].expanded).toBe(true);
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
