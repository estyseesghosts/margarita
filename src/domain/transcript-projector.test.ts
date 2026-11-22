import { describe, expect, test } from 'bun:test';

import { type ExecutionMarker, executionMarkers } from './execution-segment.ts';
import {
  type AssistantPart,
  createTranscriptProjector,
  type FoldOptions,
  foldTranscript,
  type ToolCall,
  type TranscriptMessage,
  type TranscriptNode,
} from './transcript.ts';

function user(id: string, text = `request ${id}`): TranscriptMessage {
  return { kind: 'user', id, createdAt: 0, text, attachments: [] };
}

function toolPart(id: string, status: ToolCall['status'] = 'completed'): AssistantPart {
  return {
    kind: 'tool',
    tool: {
      id,
      name: 'read',
      status,
      input: { filePath: `${id}.ts` },
      startedAt: 0,
      ...(status === 'error' ? { error: 'exit 1' } : {}),
    },
  };
}

function assistant(id: string, parts: AssistantPart[], createdAt = 0): TranscriptMessage {
  return {
    kind: 'assistant',
    id,
    createdAt,
    agent: 'build',
    model: { providerID: 'p', modelID: 'm' },
    parts,
  };
}

function toolMessage(id: string, status: ToolCall['status'] = 'completed'): TranscriptMessage {
  return assistant(id, [toolPart(`t-${id}`, status)]);
}

function idle(id: string, outcome: 'succeeded' | 'failed' | 'interrupted'): TranscriptMessage {
  return { kind: 'idle', id, createdAt: 0, outcome };
}

function turn(
  index: number,
  options: { outcome?: 'succeeded' | 'failed' | 'interrupted' } = {},
): TranscriptMessage[] {
  return [
    user(`u${index}`),
    assistant(`a${index}`, [{ kind: 'text', text: `answer ${index}` }]),
    toolMessage(`t${index}`),
    idle(`i${index}`, options.outcome ?? 'succeeded'),
  ];
}

function history(turns: number): TranscriptMessage[] {
  return Array.from({ length: turns }, (_, index) => turn(index)).flat();
}

function markerFor(
  messages: readonly TranscriptMessage[],
  running = false,
): ReadonlyMap<string, ExecutionMarker> {
  return new Map(
    executionMarkers(messages, running).map((marker) => [marker.afterMessageId, marker]),
  );
}

const compact: FoldOptions = { detailed: false, expandedGroups: new Set() };
const detailed: FoldOptions = { detailed: true, expandedGroups: new Set() };

function project(
  projector: ReturnType<typeof createTranscriptProjector>,
  messages: readonly TranscriptMessage[],
  options: FoldOptions = compact,
  running = false,
): TranscriptNode[] {
  return projector.project(messages, { ...options, markers: markerFor(messages, running) });
}

function reference(
  messages: readonly TranscriptMessage[],
  options: FoldOptions = compact,
  running = false,
): TranscriptNode[] {
  return foldTranscript(messages, { ...options, markers: markerFor(messages, running) });
}

describe('incremental transcript projector (#283)', () => {
  test('matches the full reference fold across every message kind and mode', () => {
    const messages: TranscriptMessage[] = [
      user('u0'),
      assistant('a0', [
        { kind: 'text', text: 'Prose with a `code` span.' },
        { kind: 'reasoning', text: 'thinking', done: true },
        toolPart('t0'),
        toolPart('t1'),
      ]),
      { kind: 'note', id: 'n0', createdAt: 0, text: 'a note', source: 'synthetic' },
      { kind: 'shell', id: 's0', createdAt: 0, command: 'pwd', status: 'exited', output: '/tmp' },
      { kind: 'agent-switched', id: 'g0', createdAt: 0, agent: 'plan' },
      { kind: 'model-switched', id: 'm0', createdAt: 0, model: { providerID: 'p', modelID: 'm' } },
      idle('i0', 'failed'),
      user('u1'),
      assistant('a1', [{ kind: 'text', text: 'Step interrupted' }]),
      idle('i1', 'interrupted'),
      { kind: 'compaction', id: 'c0', createdAt: 0, state: 'completed' },
      ...turn(2),
    ];

    for (const options of [compact, detailed]) {
      for (const running of [false, true]) {
        const projector = createTranscriptProjector();
        expect(project(projector, messages, options, running)).toEqual(
          reference(messages, options, running),
        );
      }
    }
  });

  test('a refetched page with equal content reuses nodes; content edits do not', () => {
    const projector = createTranscriptProjector();
    const first = history(4);
    const nodes = project(projector, first);
    const refetched = first.map((message) => structuredClone(message));
    const reused = project(projector, refetched);
    expect(reused).toEqual(nodes);
    expect(projector.lastStats()?.messagesFolded).toBe(0);
    expect(projector.lastStats()?.messagesReused).toBe(first.length);
    expect(reused[0]).toBe(nodes[0]);

    // Same IDs and timestamps, same-length text: only content equality can tell.
    const edited = refetched.map((message, index) =>
      index === 0 && message.kind === 'user'
        ? { ...message, text: message.text.replace('request', 'REQUEST') }
        : message,
    );
    const updated = project(projector, edited);
    expect(updated).toEqual(reference(edited));
    expect(updated).not.toBe(reused);
    expect(projector.lastStats()?.messagesFolded).toBe(1);
  });

  test('a tail append reuses the unchanged prefix and folds only new messages', () => {
    const projector = createTranscriptProjector();
    const first = history(3);
    expect(project(projector, first)).toEqual(reference(first));
    expect(projector.lastStats()?.messagesFolded).toBe(first.length);

    const appended = [...first, ...turn(3)];
    const nodes = project(projector, appended);
    expect(nodes).toEqual(reference(appended));
    const stats = projector.lastStats();
    expect(stats?.messagesFolded).toBe(4);
    expect(stats?.messagesReused).toBe(first.length);
    expect(stats?.messagesReprocessed).toBe(4);
    expect(stats?.prefixNodesReused).toBeGreaterThan(0);
  });

  test('replacing one tail message refolds only its own turn', () => {
    const projector = createTranscriptProjector();
    const first = history(40);
    project(projector, first);
    const before = project(projector, first);

    const updated = [
      ...first.slice(0, -2),
      assistant('t39', [toolPart('t-t39', 'running')]),
      first.at(-1) ?? idle('i39', 'succeeded'),
    ];
    const nodes = project(projector, updated);
    expect(nodes).toEqual(reference(updated));
    const stats = projector.lastStats();
    expect(stats?.messagesReprocessed).toBe(4); // user, assistant, tool, idle of turn 39
    expect(stats?.messagesReused).toBe(updated.length - 1);

    // Nodes before the affected turn are the same objects, not merely equal.
    const prefix = stats?.prefixNodesReused ?? 0;
    expect(prefix).toBeGreaterThan(0);
    for (let index = 0; index < prefix; index += 1) {
      expect(nodes[index]).toBe(before[index]);
    }
  });

  test('a non-tail replacement, deletion and reorder stay equal to the reference', () => {
    const projector = createTranscriptProjector();
    const first = history(12);
    const initial = project(projector, first);

    const replaced = [...first];
    replaced[10] = assistant('a2', [{ kind: 'text', text: 'edited older answer' }]);
    expect(project(projector, replaced)).toEqual(reference(replaced));

    const deleted = first.filter((message) => message.id !== 'a5');
    expect(project(projector, deleted)).toEqual(reference(deleted));

    const reordered = [...first];
    const left = reordered[4];
    const right = reordered[5];
    if (left !== undefined && right !== undefined) {
      reordered[4] = right;
      reordered[5] = left;
    }
    expect(project(projector, reordered)).toEqual(reference(reordered));

    // Returning to the original history must resurrect the original node identities.
    const back = project(projector, first);
    expect(back).toEqual(initial);
    expect(back[0]).toBe(initial[0]);
  });

  test('prepending an older page preserves pagination-visible order and content', () => {
    const projector = createTranscriptProjector();
    const recent = history(6);
    project(projector, recent);
    const older = history(4).map((message) => ({ ...message, id: `old-${message.id}` }));
    const prepended = [...older, ...recent];
    expect(project(projector, prepended)).toEqual(reference(prepended));
  });

  test('a marker phase change updates that turn without rebuilding earlier markers', () => {
    const projector = createTranscriptProjector();
    const messages = history(5);
    const running = project(projector, messages, compact, true);
    const completed = project(projector, messages, compact, false);
    expect(completed).toEqual(reference(messages, compact, false));

    const runningMarker = running.find((node) => node.kind === 'execution');
    const completedMarker = completed.find((node) => node.kind === 'execution');
    expect(runningMarker).toBeDefined();
    expect(completedMarker).toBeDefined();

    const earlier = completed.filter((node) => node.kind === 'execution').slice(0, 3);
    for (const node of earlier) {
      expect(running.find((candidate) => candidate.key === node.key)).toBe(node);
    }
  });

  test('detailed mode, expanded groups and diff expansion recompute coherently', () => {
    const projector = createTranscriptProjector();
    const messages: TranscriptMessage[] = [
      user('u0'),
      assistant('a0', [toolPart('t0'), toolPart('t1')]),
      assistant('a1', [toolPart('t2')]),
      idle('i0', 'succeeded'),
    ];
    project(projector, messages);

    const expanded = {
      detailed: false,
      expandedGroups: new Set(['group:t0']),
      expandedDiffs: new Set(['t1']),
    };
    expect(project(projector, messages, expanded)).toEqual(reference(messages, expanded));
    expect(project(projector, messages, detailed)).toEqual(reference(messages, detailed));

    // Returning to compact must not leak the detailed or expanded derivation.
    expect(project(projector, messages)).toEqual(reference(messages));
  });

  test('seeded random update sequences never diverge from the full fold', () => {
    let seed = 0x5f3759df;
    const random = (limit: number): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % limit;
    };
    const projector = createTranscriptProjector();
    let messages: TranscriptMessage[] = history(8);

    for (let step = 0; step < 80; step += 1) {
      const operation = random(5);
      if (operation === 0) {
        messages = [...messages, ...turn(100 + step)];
      } else if (operation === 1 && messages.length > 0) {
        const index = random(messages.length);
        const target = messages[index];
        if (target !== undefined) {
          const replacement =
            target.kind === 'assistant'
              ? assistant(target.id, [
                  { kind: 'text', text: `edited at ${step}` },
                  toolPart(`random-${step}`, random(2) === 0 ? 'completed' : 'error'),
                ])
              : target;
          const next = [...messages];
          next[index] = replacement;
          messages = next;
        }
      } else if (operation === 2 && messages.length > 2) {
        messages = messages.filter((_, index) => index !== random(messages.length));
      } else if (operation === 3 && messages.length > 1) {
        const index = random(messages.length - 1);
        const next = [...messages];
        const left = next[index];
        const right = next[index + 1];
        if (left !== undefined && right !== undefined) {
          next[index] = right;
          next[index + 1] = left;
        }
        messages = next;
      } else if (operation === 4) {
        messages = messages.slice(random(messages.length + 1));
      }

      const running = random(2) === 0;
      const nodes = project(projector, messages, compact, running);
      expect(nodes).toEqual(reference(messages, compact, running));
    }
  });
});
