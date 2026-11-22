/**
 * Opt-in event-to-visible-frame benchmark (#301).
 *
 *   bun run bench:render
 *
 * Uses the real Solid/OpenTUI tree through `testRender` and a real controller over the
 * deterministic FakeBackend. All transcript content is synthetic; no service or user data is
 * contacted. Each sample measures: transcript-changed receipt -> canonical refetch + mapping
 * + incremental projection -> one rendered frame, including the 80 ms transcript coalescing
 * window in `scheduleTranscript`.
 */

import { testRender } from '@opentui/solid';

import { AppController } from '../src/app/controller.ts';
import { defaultConfig } from '../src/config/config.ts';
import { emptyState } from '../src/config/local-state.ts';
import { buildKeymap } from '../src/domain/keymap.ts';
import type { AssistantPart, TranscriptMessage } from '../src/domain/transcript.ts';
import { summarizeSamples } from '../src/perf/measure.ts';
import { App } from '../src/ui/app.tsx';
import { pickTheme } from '../src/ui/theme.ts';
import { FakeBackend } from '../test/fake-backend.ts';

const model = { providerID: 'opencode', modelID: 'longcat' };
const sessionID = 'ses_render';
const loadedMessages = 1_000;
const samplesPerSize = 30;

function turn(index: number): TranscriptMessage[] {
  const parts: AssistantPart[] = [{ kind: 'text', text: `answer ${index}` }];
  return [
    {
      kind: 'user',
      id: `u${index}`,
      createdAt: index * 10,
      text: `question ${index}`,
      attachments: [],
    },
    {
      kind: 'assistant',
      id: `a${index}`,
      createdAt: index * 10 + 1,
      completedAt: index * 10 + 2,
      agent: 'build',
      model,
      parts,
    },
  ];
}

const history = Array.from({ length: loadedMessages / 2 }, (_, index) => turn(index)).flat();

async function waitForMessage(controller: AppController, id: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const messages = controller.state.transcripts[sessionID]?.messages ?? [];
    if (messages.some((message) => message.id === id)) return;
    await Bun.sleep(1);
  }
  throw new Error(`message ${id} did not reach controller state`);
}

async function runSize(width: number, height: number): Promise<unknown> {
  const backend = new FakeBackend();
  backend.sessions = [
    {
      id: sessionID,
      serverID: 'local',
      projectID: 'p',
      directory: '/work/render',
      title: 'Render bench',
      createdAt: 0,
      updatedAt: 1,
      archived: false,
    },
  ];
  backend.messages[sessionID] = history;
  const controller = new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/render',
    version: '0.0.0',
    now: () => 100_000,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
  });
  await controller.bootstrap();
  const setup = await testRender(
    () =>
      App({
        controller,
        keymap: buildKeymap({}).keymap,
        theme: pickTheme({}),
        animate: false,
        ascii: false,
        env: {},
      }),
    { width, height },
  );

  try {
    controller.openSession(sessionID);
    const newest = history.at(-1);
    if (newest === undefined) throw new Error('render benchmark history is empty');
    await waitForMessage(controller, newest.id);
    for (let page = 0; page < Math.ceil(loadedMessages / 120) - 1; page += 1) {
      await controller.loadOlder(sessionID);
    }
    if ((controller.state.transcripts[sessionID]?.messages.length ?? 0) !== loadedMessages) {
      throw new Error('render benchmark did not load the complete history');
    }

    let serial = 0;
    const one = async (): Promise<number> => {
      serial += 1;
      const id = `stream-${serial}`;
      const start = performance.now();
      backend.messages[sessionID] = [
        ...(backend.messages[sessionID] ?? []),
        {
          kind: 'assistant',
          id,
          createdAt: 1_000_000 + serial,
          completedAt: 1_000_001 + serial,
          agent: 'build',
          model,
          parts: [{ kind: 'text', text: `streamed answer ${serial}` }],
        },
      ];
      controller.onEvents('local', [{ kind: 'transcript-changed', sessionID }], false);
      await waitForMessage(controller, id);
      await setup.renderOnce();
      return performance.now() - start;
    };

    await one();
    const samples: number[] = [];
    for (let index = 0; index < samplesPerSize; index += 1) samples.push(await one());
    const stats = summarizeSamples(samples);

    // A known 100 ms stage must be visible in the end-to-end clock, not just in a pure timer.
    const controlStart = performance.now();
    await Bun.sleep(100);
    await setup.renderOnce();
    const controlMs = performance.now() - controlStart;
    if (controlMs < 90) throw new Error(`known 100 ms stage measured only ${controlMs} ms`);

    const frame = setup.captureCharFrame();
    if (!frame.includes('streamed answer')) {
      throw new Error('rendered frame does not contain the streamed answer');
    }
    return {
      width,
      height,
      loadedMessages,
      stats,
      knownStageMs: controlMs,
      memory: process.memoryUsage(),
    };
  } finally {
    setup.renderer.destroy();
    controller.dispose();
  }
}

const results = [await runSize(80, 24), await runSize(40, 12)];
const report = {
  kind: 'margarita-render-bench' as const,
  version: 1,
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  bun: Bun.version,
  scenario: 'transcript-changed -> refetch/map/project -> rendered frame',
  samplesPerSize,
  results,
};
console.log(JSON.stringify(report, null, 2));
