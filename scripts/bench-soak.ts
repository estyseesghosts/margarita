/**
 * Persistent long-session soak benchmark.
 *
 *   bun run bench:soak
 *   bun run bench:soak -- --smoke
 *   bun run bench:soak -- --sizes 1000,10000 --events 200 --json soak.json
 *
 * One controller and one mounted Solid/OpenTUI tree stay alive while thousands of synthetic
 * events arrive. Each measured sample covers event receipt -> canonical refetch/mapping ->
 * incremental projection -> one rendered frame. Samples are reported in successive windows,
 * never as a single aggregate, so growth after hours of streaming is visible.
 *
 * All fixtures are generated locally; no service, model or user transcript is contacted.
 * Wall-clock numbers are machine-specific. There are no CI thresholds: the only hard checks
 * are correctness of the rendered output, the loaded-history identity and the known-latency
 * control stage.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { testRender } from '@opentui/solid';

import { AppController } from '../src/app/controller.ts';
import { defaultConfig } from '../src/config/config.ts';
import { emptyState } from '../src/config/local-state.ts';
import { buildKeymap } from '../src/domain/keymap.ts';
import { sessionKey } from '../src/domain/server-identity.ts';
import type { SessionSummary } from '../src/domain/session.ts';
import type {
  AssistantPart,
  ProjectionStats,
  ToolCall,
  TranscriptMessage,
} from '../src/domain/transcript.ts';
import { transcriptRowBudget, windowNodeViewByRows } from '../src/domain/transcript.ts';
import { summarizeSamples } from '../src/perf/measure.ts';
import { App } from '../src/ui/app.tsx';
import { pickTheme } from '../src/ui/theme.ts';
import { FakeBackend } from '../test/fake-backend.ts';

const model = { providerID: 'soak', modelID: 'synthetic' };
const serverID = 'local';
const mainSessionID = 'ses_soak';
const altSessionID = 'ses_soak_alt';
const pagingSessionID = 'ses_soak_paging';
const width = 100;
const height = 30;
const windowSize = 60;

const args = new Set(Bun.argv.slice(2));
const smoke = args.has('--smoke');
const jsonIndex = Bun.argv.indexOf('--json');
const jsonPath = jsonIndex >= 0 ? Bun.argv[jsonIndex + 1] : undefined;
const eventsIndex = Bun.argv.indexOf('--events');
const requestedEvents = eventsIndex >= 0 ? Number(Bun.argv[eventsIndex + 1]) : undefined;
const eventCount =
  requestedEvents !== undefined && Number.isFinite(requestedEvents) && requestedEvents > 0
    ? Math.floor(requestedEvents)
    : smoke
      ? 24
      : 360;
const sizesIndex = Bun.argv.indexOf('--sizes');
const requestedSizes =
  sizesIndex >= 0
    ? (Bun.argv[sizesIndex + 1] ?? '')
        .split(',')
        .map((entry) => Number(entry.trim()))
        .filter((entry) => Number.isFinite(entry) && entry > 0)
    : [];
const historySizes =
  requestedSizes.length > 0 ? requestedSizes : smoke ? [400] : [1_000, 10_000, 50_000];

function summary(id: string, title: string): SessionSummary {
  return {
    id,
    serverID,
    projectID: 'soak',
    directory: '/work/soak',
    title,
    createdAt: 0,
    updatedAt: 1,
    archived: false,
  };
}

function toolFor(tag: string, turn: number): ToolCall {
  return {
    id: `${tag}-tool-${turn}`,
    name: 'read',
    status: 'completed',
    input: { filePath: `src/file-${turn}.ts` },
    output: Array.from({ length: 8 }, (_, row) => `line ${row}`).join('\n'),
    startedAt: turn,
    completedAt: turn + 1,
  };
}

function diffToolFor(tag: string, turn: number): ToolCall {
  return {
    id: `${tag}-diff-${turn}`,
    name: 'edit',
    status: 'completed',
    input: { path: `src/diff-${turn}.ts` },
    output: 'applied',
    diff: Array.from({ length: 400 }, (_, row) => `+line ${row}`).join('\n'),
    startedAt: turn,
    completedAt: turn + 1,
  };
}

/** Complete synthetic turns; trailing filler reaches the exact requested message count. */
function syntheticHistory(count: number, tag: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let turn = 0;
  while (messages.length + 3 <= count) {
    const created = turn * 10;
    messages.push({
      kind: 'user',
      id: `${tag}-u${turn}`,
      createdAt: created,
      text: `request ${turn}`,
      attachments: [],
    });
    const parts: AssistantPart[] = [
      {
        kind: 'text',
        text: `answer ${turn}\n${Array.from({ length: 4 }, (_, row) => `row ${row}`).join('\n')}`,
      },
    ];
    if (turn % 5 === 0) parts.push({ kind: 'tool', tool: toolFor(tag, turn) });
    if (turn % 25 === 0) parts.push({ kind: 'tool', tool: diffToolFor(tag, turn) });
    messages.push({
      kind: 'assistant',
      id: `${tag}-a${turn}`,
      createdAt: created + 1,
      completedAt: created + 2,
      agent: 'build',
      model,
      parts,
    });
    messages.push({
      kind: 'idle',
      id: `${tag}-i${turn}`,
      createdAt: created + 3,
      outcome: 'succeeded',
    });
    turn += 1;
  }
  while (messages.length < count) {
    const index = messages.length;
    messages.push({
      kind: 'note',
      id: `${tag}-n${index}`,
      createdAt: index,
      text: `filler ${index}`,
      source: 'synthetic',
    });
  }
  return messages;
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  deadlineMs = 15_000,
): Promise<void> {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(`soak: ${description} did not settle`);
}

function transcriptOf(controller: AppController, sessionID: string) {
  return controller.state.transcripts[sessionKey({ serverID, sessionID })];
}

function messagesOf(controller: AppController, sessionID: string): readonly TranscriptMessage[] {
  return transcriptOf(controller, sessionID)?.messages ?? [];
}

function lastTextAssistant(
  messages: readonly TranscriptMessage[],
): Extract<TranscriptMessage, { kind: 'assistant' }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind !== 'assistant') continue;
    if (message.parts.some((part) => part.kind === 'text')) return message;
  }
  return undefined;
}

function lastTool(messages: readonly TranscriptMessage[]): ToolCall | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind !== 'assistant') continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part?.kind === 'tool') return part.tool;
    }
  }
  return undefined;
}

function memoryCheckpoint(): {
  heapUsedBytes: number;
  rssBytes: number;
  externalBytes: number;
  gcPauseMs: number;
} {
  const beforeGc = performance.now();
  Bun.gc(true);
  const gcPauseMs = performance.now() - beforeGc;
  const usage = process.memoryUsage();
  return {
    heapUsedBytes: usage.heapUsed,
    rssBytes: usage.rss,
    externalBytes: usage.external,
    gcPauseMs,
  };
}

type StageFixture = Readonly<{
  backend: FakeBackend;
  controller: AppController;
  setup: Awaited<ReturnType<typeof testRender>>;
  stats: ProjectionStats[];
}>;

async function createFixture(
  histories: Readonly<Record<string, TranscriptMessage[]>>,
): Promise<StageFixture> {
  const backend = new FakeBackend();
  backend.serverID = serverID;
  backend.sessions = Object.keys(histories).map((id) => summary(id, `Soak ${id}`));
  for (const [id, messages] of Object.entries(histories)) backend.messages[id] = messages;
  const controller = new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/soak',
    version: '0.0.0',
    now: () => 100_000,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
  });
  await controller.bootstrap();
  const stats: ProjectionStats[] = [];
  const setup = await testRender(
    () =>
      App({
        controller,
        keymap: buildKeymap({}).keymap,
        theme: pickTheme({}),
        animate: false,
        ascii: false,
        env: {},
        onProjectionStats: (entry) => stats.push(entry),
      }),
    { width, height },
  );
  return { backend, controller, setup, stats };
}

async function openAndLoad(
  controller: AppController,
  sessionID: string,
  expectedMessages: number,
): Promise<void> {
  controller.openSession(sessionID);
  await waitFor(() => controller.state.route.kind === 'conversation', `route ${sessionID}`);
  await waitFor(
    () => (transcriptOf(controller, sessionID)?.messages.length ?? 0) > 0,
    `first page ${sessionID}`,
  );
  for (let page = 0; page < expectedMessages + 10; page += 1) {
    const transcript = transcriptOf(controller, sessionID);
    if (transcript?.olderCursor === undefined) break;
    await controller.loadOlder(sessionID);
  }
  await waitFor(
    () => messagesOf(controller, sessionID).length === expectedMessages,
    `complete history ${sessionID} (${expectedMessages})`,
    120_000,
  );
}

/**
 * Navigation latency on the same live controller (#353): Ctrl+Up/Down, Enter expansion and
 * focus reveal. Projection counters are captured around each phase so a refold caused by
 * pure navigation would be visible instead of hidden inside wall-clock noise.
 */
async function navigationReport(fixture: StageFixture, sessionID: string) {
  const { controller, setup } = fixture;
  const items = controller.collapsibleItems();
  controller.presentationFor(sessionID);
  const before = controller.presentationStatsOf(sessionID);

  const focusSamples: number[] = [];
  for (let index = 0; index < 10 && items.length > 0; index += 1) {
    const started = performance.now();
    controller.moveGroupFocus(1);
    await setup.renderOnce();
    focusSamples.push(performance.now() - started);
  }
  const afterFocus = controller.presentationStatsOf(sessionID);

  const expansionSamples: number[] = [];
  if (items.length > 0) {
    for (let index = 0; index < 4; index += 1) {
      const started = performance.now();
      controller.toggleFocusedGroup();
      await setup.renderOnce();
      controller.toggleFocusedGroup();
      await setup.renderOnce();
      expansionSamples.push(performance.now() - started);
    }
  }
  const afterExpansion = controller.presentationStatsOf(sessionID);

  const target = items[0];
  const revealStarted = performance.now();
  const revealed =
    target === undefined ? false : controller.ensureTranscriptNodeVisible(sessionID, target.key);
  await setup.renderOnce();
  const revealMs = performance.now() - revealStarted;
  const afterReveal = controller.presentationStatsOf(sessionID);

  return {
    collapsibleItems: items.length,
    focus: summarizeSamples(focusSamples),
    expansion: summarizeSamples(expansionSamples),
    focusReveal: {
      target: target?.key ?? null,
      revealed,
      elapsedMs: revealMs,
    },
    focusRefolds:
      before === undefined || afterFocus === undefined
        ? null
        : afterFocus.messagesFolded - before.messagesFolded,
    revealRefolds:
      afterExpansion === undefined || afterReveal === undefined
        ? null
        : afterReveal.messagesFolded - afterExpansion.messagesFolded,
  };
}

/** One measured event: mutate the fixture, announce it, wait for commit, paint one frame. */
type EventKind =
  | 'append'
  | 'stream'
  | 'tool-status'
  | 'large-response'
  | 'large-diff'
  | 'many-tools'
  | 'background-confirmation';

async function runEvent(
  fixture: StageFixture,
  sessionID: string,
  serial: number,
  kind: EventKind,
): Promise<{ elapsedMs: number; stats: ProjectionStats | undefined }> {
  const { backend, controller, setup, stats } = fixture;
  const messages = backend.messages[sessionID];
  if (messages === undefined) throw new Error(`soak: no fixture for ${sessionID}`);
  const marker = `soak-marker-${serial}`;
  let settled: () => boolean;

  stats.length = 0;
  const start = performance.now();
  switch (kind) {
    case 'append': {
      const id = `soak-a${serial}`;
      messages.push({
        kind: 'assistant',
        id,
        createdAt: 10_000_000 + serial,
        completedAt: 10_000_001 + serial,
        agent: 'build',
        model,
        parts: [{ kind: 'text', text: marker }],
      });
      settled = () => messagesOf(controller, sessionID).at(-1)?.id === id;
      break;
    }
    case 'stream': {
      const target = lastTextAssistant(messagesOf(controller, sessionID));
      if (target === undefined) throw new Error('soak: no assistant message to stream');
      const index = messages.findIndex((message) => message.id === target.id);
      const source = messages[index];
      if (source?.kind !== 'assistant') throw new Error('soak: stream target vanished');
      const parts = source.parts.map((part) =>
        part.kind === 'text' ? { ...part, text: `${part.text} ${marker}` } : part,
      );
      messages[index] = { ...source, parts };
      settled = () => {
        // The streamed turn is still the newest text response; scanning backward from the
        // tail keeps settlement O(1) instead of searching the whole loaded history.
        const current = lastTextAssistant(messagesOf(controller, sessionID));
        return (
          current?.kind === 'assistant' &&
          current.parts.some((part) => part.kind === 'text' && part.text.includes(marker))
        );
      };
      break;
    }
    case 'tool-status': {
      const tool = lastTool(messagesOf(controller, sessionID));
      if (tool === undefined) throw new Error('soak: no tool to stream');
      const nextStatus: ToolCall['status'] = tool.status === 'running' ? 'completed' : 'running';
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.kind !== 'assistant') continue;
        const partIndex = message.parts.findIndex(
          (part) => part.kind === 'tool' && part.tool.id === tool.id,
        );
        if (partIndex < 0) continue;
        const parts = message.parts.map((part, current) =>
          current === partIndex && part.kind === 'tool'
            ? { ...part, tool: { ...part.tool, status: nextStatus } }
            : part,
        );
        messages[index] = { ...message, parts };
        break;
      }
      settled = () => lastTool(messagesOf(controller, sessionID))?.status === nextStatus;
      break;
    }
    case 'large-response': {
      const id = `soak-large${serial}`;
      messages.push({
        kind: 'assistant',
        id,
        createdAt: 10_000_000 + serial,
        completedAt: 10_000_001 + serial,
        agent: 'build',
        model,
        parts: [{ kind: 'text', text: `${marker}\n${'x'.repeat(256 * 1024)}` }],
      });
      settled = () => messagesOf(controller, sessionID).at(-1)?.id === id;
      break;
    }
    case 'large-diff': {
      const id = `soak-diff${serial}`;
      const tool: ToolCall = {
        id: `${id}-tool`,
        name: 'edit',
        status: 'completed',
        input: { path: `src/large-${serial}.ts` },
        output: 'applied',
        diff: Array.from({ length: 6_000 }, (_, row) => `+line ${row} ${marker}`).join('\n'),
        startedAt: serial,
        completedAt: serial + 1,
      };
      messages.push({
        kind: 'assistant',
        id,
        createdAt: 10_000_000 + serial,
        completedAt: 10_000_001 + serial,
        agent: 'build',
        model,
        parts: [{ kind: 'tool', tool }],
      });
      settled = () => messagesOf(controller, sessionID).at(-1)?.id === id;
      break;
    }
    case 'many-tools': {
      const id = `soak-tools${serial}`;
      const parts: AssistantPart[] = Array.from({ length: 24 }, (_, index) => ({
        kind: 'tool' as const,
        tool: {
          id: `${id}-${index}`,
          name: 'read',
          status: 'completed' as const,
          input: { filePath: `src/many-${index}.ts` },
          output: `result ${index}`,
          startedAt: serial,
          completedAt: serial + 1,
        },
      }));
      messages.push({
        kind: 'assistant',
        id,
        createdAt: 10_000_000 + serial,
        completedAt: 10_000_001 + serial,
        agent: 'build',
        model,
        parts,
      });
      settled = () => messagesOf(controller, sessionID).at(-1)?.id === id;
      break;
    }
    case 'background-confirmation': {
      // Mark the newest tool running so the session has an active call to background.
      let marked = false;
      for (let index = messages.length - 1; index >= 0 && !marked; index -= 1) {
        const message = messages[index];
        if (message?.kind !== 'assistant') continue;
        const partIndex = message.parts.findIndex((part) => part.kind === 'tool');
        if (partIndex < 0) continue;
        const parts: AssistantPart[] = message.parts.map((part, current) => {
          if (current !== partIndex || part.kind !== 'tool') return part;
          const tool: ToolCall = { ...part.tool, status: 'running' };
          return { ...part, tool };
        });
        messages[index] = { ...message, parts };
        marked = true;
      }
      if (!marked) throw new Error('soak: no tool to background');
      // The transcript-changed announcement refetches and recomputes execution markers, which
      // flips state.running; only then may the tool be backgrounded.
      controller.onEvents(serverID, [{ kind: 'transcript-changed', sessionID }], false);
      await waitFor(
        () => controller.state.running[sessionKey({ serverID, sessionID })] === true,
        'running marker',
      );
      void controller.backgroundTools();
      settled = () => {
        const backgrounded = controller.state.backgrounded[sessionKey({ serverID, sessionID })];
        return backgrounded !== undefined && backgrounded.length > 0;
      };
      break;
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`soak: unknown event ${String(exhaustive)}`);
    }
  }

  controller.onEvents(serverID, [{ kind: 'transcript-changed', sessionID }], false);
  await waitFor(settled, `event ${kind} ${serial}`);
  await setup.renderOnce();
  const elapsedMs = performance.now() - start;
  // Keyed by transcript identity so a route/session switch cannot collect another session's
  // counters. The callback only runs for the mounted transcript, which is this session here.
  const last = stats.at(-1);
  return { elapsedMs, stats: last };
}

function eventKind(index: number): EventKind {
  switch (index % 18) {
    case 0:
      return 'large-response';
    case 1:
      return 'large-diff';
    case 2:
      return 'many-tools';
    case 3:
    case 8:
      return 'tool-status';
    case 4:
    case 9:
    case 13:
      return 'stream';
    case 17:
      return 'background-confirmation';
    default:
      return 'append';
  }
}

type WindowReport = Readonly<{
  index: number;
  samples: number;
  latency: ReturnType<typeof summarizeSamples>;
  projector: {
    messagesFolded: number;
    messagesReprocessed: number;
    prefixNodesReused: number;
    maxMessagesFolded: number;
  };
  render: {
    mountedNodes: number;
    estimatedRows: number;
    hiddenNodes: number;
  };
  memory: ReturnType<typeof memoryCheckpoint>;
}>;

async function historyStage(loadedMessages: number) {
  const main = syntheticHistory(loadedMessages, `h${loadedMessages}`);
  // Small enough to arrive in the first transcript page, so a switch measures the route and
  // paint path rather than a deliberate older-history walk.
  const alt = syntheticHistory(Math.min(60, loadedMessages), `alt${loadedMessages}`);
  const paging = syntheticHistory(Math.min(5_000, loadedMessages), `page${loadedMessages}`);
  const fixture = await createFixture({
    [mainSessionID]: main,
    [altSessionID]: alt,
    [pagingSessionID]: paging,
  });
  const { backend, controller, setup, stats } = fixture;
  try {
    await openAndLoad(controller, mainSessionID, main.length);
    if (messagesOf(controller, mainSessionID).length !== main.length) {
      throw new Error(
        `soak: loaded ${messagesOf(controller, mainSessionID).length}/${main.length}`,
      );
    }

    // Warm up without contributing to the reported windows.
    await runEvent(fixture, mainSessionID, 0, 'append');
    await runEvent(fixture, mainSessionID, 1, 'stream');

    const samples: number[] = [];
    const windows: WindowReport[] = [];
    let folded = 0;
    let reprocessed = 0;
    let reused = 0;
    let maxFolded = 0;
    let windowStart = 0;
    let serial = 2;

    for (let index = 0; index < eventCount; index += 1) {
      const kind = eventKind(index);
      const sample = await runEvent(fixture, mainSessionID, serial++, kind);
      samples.push(sample.elapsedMs);
      if (sample.stats !== undefined) {
        folded += sample.stats.messagesFolded;
        reprocessed += sample.stats.messagesReprocessed;
        reused += sample.stats.prefixNodesReused;
        maxFolded = Math.max(maxFolded, sample.stats.messagesFolded);
      }
      if (samples.length - windowStart >= windowSize || index === eventCount - 1) {
        const windowSamples = samples.slice(windowStart);
        windows.push({
          index: windows.length,
          samples: windowSamples.length,
          latency: summarizeSamples(windowSamples),
          projector: {
            messagesFolded: folded,
            messagesReprocessed: reprocessed,
            prefixNodesReused: reused,
            maxMessagesFolded: maxFolded,
          },
          render: (() => {
            const view = controller.presentationFor(mainSessionID);
            const windowed = windowNodeViewByRows(view, {
              nodeLimit: controller.transcriptWindow(mainSessionID),
              rowBudget: transcriptRowBudget,
              width,
            });
            return {
              mountedNodes: windowed.visible.length,
              estimatedRows: windowed.estimatedRows,
              hiddenNodes: windowed.hidden,
            };
          })(),
          memory: memoryCheckpoint(),
        });
        windowStart = samples.length;
        folded = 0;
        reprocessed = 0;
        reused = 0;
        maxFolded = 0;
      }
    }

    // A real burst: one announcement covers 100 appended messages.
    const burstStart = performance.now();
    const burstBase = backend.messages[mainSessionID]?.length ?? 0;
    for (let index = 0; index < 100; index += 1) {
      backend.messages[mainSessionID]?.push({
        kind: 'assistant',
        id: `soak-burst-${index}`,
        createdAt: 20_000_000 + index,
        completedAt: 20_000_001 + index,
        agent: 'build',
        model,
        parts: [{ kind: 'text', text: `burst ${index}` }],
      });
    }
    controller.onEvents(
      serverID,
      [{ kind: 'transcript-changed', sessionID: mainSessionID }],
      false,
    );
    await waitFor(
      () => messagesOf(controller, mainSessionID).at(-1)?.id === 'soak-burst-99',
      '100-event burst',
    );
    if ((backend.messages[mainSessionID]?.length ?? 0) !== burstBase + 100) {
      throw new Error('soak: burst fixture did not append exactly 100 messages');
    }
    await setup.renderOnce();
    const burstMs = performance.now() - burstStart;
    const burstStats = stats.at(-1);

    // Expansion/collapse: local disclosure must not lose the live tail or the mounted frame.
    const expansionSamples: number[] = [];
    const tool = lastTool(backend.messages[mainSessionID] ?? []);
    if (tool !== undefined) {
      for (let index = 0; index < 6; index += 1) {
        const start = performance.now();
        controller.toggleToolExpanded(tool.id);
        await setup.renderOnce();
        controller.toggleToolExpanded(tool.id);
        await setup.renderOnce();
        expansionSamples.push(performance.now() - start);
      }
      for (let index = 0; index < 4; index += 1) {
        const start = performance.now();
        controller.toggleDiffExpanded(tool.id);
        await setup.renderOnce();
        controller.toggleDiffExpanded(tool.id);
        await setup.renderOnce();
        expansionSamples.push(performance.now() - start);
      }
    }

    // Session switching keeps the same controller and renderer; no fixture rebuild.
    const switchSamples: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const awayStart = performance.now();
      controller.openSession(altSessionID);
      await waitFor(
        () => transcriptOf(controller, altSessionID)?.messages.length === alt.length,
        'alternate session',
      );
      await setup.renderOnce();
      switchSamples.push(performance.now() - awayStart);

      const backStart = performance.now();
      controller.openSession(mainSessionID);
      await waitFor(
        () => messagesOf(controller, mainSessionID).length >= main.length,
        'return to main session',
      );
      await setup.renderOnce();
      switchSamples.push(performance.now() - backStart);
    }

    // Pagination during streaming: keep prepending older history while live events land.
    const pagingInitial = transcriptOf(controller, pagingSessionID)?.messages.length ?? 0;
    controller.openSession(pagingSessionID);
    await waitFor(
      () => (transcriptOf(controller, pagingSessionID)?.messages.length ?? 0) >= pagingInitial,
      'paging session open',
    );
    await setup.renderOnce();
    const pagingSamples: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      const start = performance.now();
      if (index % 4 === 0) void controller.loadOlder(pagingSessionID);
      backend.messages[pagingSessionID]?.push({
        kind: 'assistant',
        id: `soak-page-${index}`,
        createdAt: 30_000_000 + index,
        completedAt: 30_000_001 + index,
        agent: 'build',
        model,
        parts: [{ kind: 'text', text: `paging ${index}` }],
      });
      controller.onEvents(
        serverID,
        [{ kind: 'transcript-changed', sessionID: pagingSessionID }],
        false,
      );
      await waitFor(
        () => messagesOf(controller, pagingSessionID).at(-1)?.id === `soak-page-${index}`,
        `paging event ${index}`,
      );
      await setup.renderOnce();
      pagingSamples.push(performance.now() - start);
    }
    await controller.loadOlder(pagingSessionID);
    const pagingLoaded = transcriptOf(controller, pagingSessionID)?.messages.length ?? 0;
    if (pagingLoaded <= pagingInitial) {
      throw new Error('soak: pagination-during-streaming loaded no older history');
    }

    // Deterministic render assertion: return to the main session and append a unique marker.
    controller.openSession(mainSessionID);
    await waitFor(
      () => messagesOf(controller, mainSessionID).length >= main.length,
      'return before final frame',
    );
    const final = await runEvent(fixture, mainSessionID, 900_000, 'append');
    const frame = setup.captureCharFrame();
    if (!frame.includes('soak-marker-900000')) {
      throw new Error('soak: final rendered frame does not contain the appended marker');
    }
    if (final.stats === undefined) {
      throw new Error('soak: projector produced no statistics for the final event');
    }
    const controllerCount = messagesOf(controller, mainSessionID).length;
    const backendCount = backend.messages[mainSessionID]?.length ?? 0;
    if (controllerCount !== backendCount) {
      throw new Error(`soak: controller retained ${controllerCount}/${backendCount} messages`);
    }

    // A known 100 ms stage must appear in the same end-to-end clock.
    const controlStart = performance.now();
    await Bun.sleep(100);
    await setup.renderOnce();
    const controlledLatencyMs = performance.now() - controlStart;
    if (controlledLatencyMs < 90) {
      throw new Error(
        `soak: known 100 ms stage measured only ${controlledLatencyMs.toFixed(1)} ms`,
      );
    }

    const navigation = await navigationReport(fixture, mainSessionID);

    return {
      loadedMessages,
      events: eventCount,
      windows,
      navigation,
      burst: {
        messages: 100,
        elapsedMs: burstMs,
        projector: burstStats ?? null,
      },
      expansion: summarizeSamples(expansionSamples),
      sessionSwitch: summarizeSamples(switchSamples),
      paginationDuringStreaming: {
        initialMessages: pagingInitial,
        loadedMessages: pagingLoaded,
        latency: summarizeSamples(pagingSamples),
      },
      controlledLatencyMs,
      finalFrameContainsMarker: true,
      controllerMessages: controllerCount,
      backendMessages: backendCount,
    };
  } finally {
    setup.renderer.destroy();
    controller.dispose();
  }
}

const results: Awaited<ReturnType<typeof historyStage>>[] = [];
for (const size of historySizes) results.push(await historyStage(size));

function gitRevision(): string {
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD']);
    return result.stdout.toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

const openTuiPackage = await Bun.file('node_modules/@opentui/core/package.json')
  .json()
  .catch(() => ({ version: 'unknown' }));
const report = {
  kind: 'margarita-soak' as const,
  version: 1,
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  bun: Bun.version,
  versions: {
    bun: Bun.version,
    openTui: typeof openTuiPackage.version === 'string' ? openTuiPackage.version : 'unknown',
  },
  gitRevision: gitRevision(),
  dimensions: `${width}x${height}`,
  windowSize,
  smoke,
  results,
  method: {
    latency: 'transcript-changed -> canonical refetch/mapping -> projector -> renderOnce',
    memory:
      'process.memoryUsage after a forced Bun.gc(true); gcPauseMs is the forced full-GC upper bound, not a natural incremental pause',
    projector:
      'counters from the mounted Transcript projector; production leaves the observation hook unset',
  },
  unavailable: [
    'natural incremental GC pause (Bun exposes no GC observer here; forced full GC is reported instead)',
    'native OpenTUI retained memory and cell counters (@opentui/core 0.9.2 exposes no stable API)',
    'dropped-frame count (not exposed by the test renderer)',
  ],
};

if (jsonPath !== undefined) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

console.log(
  JSON.stringify(
    {
      kind: report.kind,
      platform: report.platform,
      bun: report.bun,
      smoke: report.smoke,
      results: results.map((entry) => ({
        loadedMessages: entry.loadedMessages,
        windows: entry.windows.map((window) => ({
          samples: window.samples,
          p50Ms: Number(window.latency.p50Ms.toFixed(3)),
          p95Ms: Number(window.latency.p95Ms.toFixed(3)),
          p99Ms: Number(window.latency.p99Ms.toFixed(3)),
        })),
        navigation: {
          focusP50Ms: Number(entry.navigation.focus.p50Ms.toFixed(3)),
          expansionP50Ms: Number(entry.navigation.expansion.p50Ms.toFixed(3)),
          focusRevealMs: Number(entry.navigation.focusReveal.elapsedMs.toFixed(3)),
          focusRefolds: entry.navigation.focusRefolds,
          revealRefolds: entry.navigation.revealRefolds,
        },
      })),
    },
    null,
    2,
  ),
);
