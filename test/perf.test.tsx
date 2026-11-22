import { afterEach, describe, expect, test } from 'bun:test';

import { testRender } from '@opentui/solid';

import { AppController, mergeLatest } from '../src/app/controller.ts';
import { defaultConfig } from '../src/config/config.ts';
import { emptyState } from '../src/config/local-state.ts';
import { buildKeymap } from '../src/domain/keymap.ts';
import { sanitizeTerminalText } from '../src/domain/sanitize-text.ts';
import {
  foldTranscript,
  type TranscriptMessage,
  transcriptWindowStep,
  windowNodes,
} from '../src/domain/transcript.ts';
import { App } from '../src/ui/app.tsx';
import { pickTheme } from '../src/ui/theme.ts';
import { FakeBackend } from './fake-backend.ts';

/**
 * Performance budgets (docs/15, milestone 4). Budgets are deliberately loose (CI
 * machines vary); they catch accidental quadratic work, not micro-regressions.
 */

const model = { providerID: 'opencode', modelID: 'longcat' };

function turn(index: number): TranscriptMessage[] {
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
      parts: [
        {
          kind: 'tool',
          tool: {
            id: `t${index}`,
            name: 'read',
            status: 'completed',
            input: { filePath: `src/file${index}.ts` },
            output: 'x'.repeat(200),
            startedAt: index * 10,
            completedAt: index * 10 + 1,
          },
        },
        { kind: 'text', text: `answer ${index}` },
      ],
    },
  ];
}

const tenThousand = Array.from({ length: 5000 }, (_, index) => turn(index)).flat();

function elapsed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

describe('performance', () => {
  test('folding 10k messages stays well under a frame budget per update', () => {
    expect(tenThousand).toHaveLength(10_000);
    const options = { detailed: false, expandedGroups: new Set<string>() };
    foldTranscript(tenThousand, options);
    const ms = elapsed(() => foldTranscript(tenThousand, options));
    expect(ms).toBeLessThan(250);
    const nodes = foldTranscript(tenThousand, options);
    expect(windowNodes(nodes, transcriptWindowStep).visible).toHaveLength(transcriptWindowStep);
  });

  test('sanitizing 5 MB of tool stdout is linear', () => {
    const line = 'ok \u001b[31mred\u001b[0m \u0007 tab\there\n';
    const output = line.repeat(Math.ceil(5_000_000 / line.length));
    let clean = '';
    const ms = elapsed(() => {
      clean = sanitizeTerminalText(output);
    });
    expect(clean).not.toContain('\u001b');
    expect(ms).toBeLessThan(1500);
  });

  test('reconnect merge over 10k cached messages has no duplicates', () => {
    const page = tenThousand.slice(-120);
    let merged: TranscriptMessage[] = [];
    const ms = elapsed(() => {
      merged = mergeLatest(tenThousand, page);
    });
    expect(merged).toHaveLength(10_000);
    expect(new Set(merged.map((message) => message.id)).size).toBe(10_000);
    // A page from a gap after a dropped stream still dedupes by ID.
    const shifted = [...tenThousand.slice(-100), ...turn(9999)];
    expect(mergeLatest(tenThousand, shifted)).toHaveLength(10_002);
    expect(ms).toBeLessThan(100);
  });

  test('attaching a 10k-message session renders only the window', async () => {
    const backend = new FakeBackend();
    backend.sessions = [
      {
        id: 'ses_big',
        projectID: 'p',
        directory: '/work/big',
        title: 'Huge',
        createdAt: 0,
        updatedAt: 1,
        archived: false,
      },
    ];
    const controller = new AppController({
      backend,
      config: defaultConfig,
      localState: emptyState,
      platform: 'linux',
      cwd: '/work/big',
      version: '0.0.0',
      now: () => 100_000,
      saveLocalState: async () => {},
      listFiles: async () => [],
      requestExit: () => {},
    });
    await controller.bootstrap();
    // Seed the cache as if every page had been fetched already.
    backend.messages['ses_big'] = tenThousand;
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
      { width: 100, height: 30 },
    );
    destroy = () => {
      setup.renderer.destroy();
      controller.dispose();
    };
    controller.openSession('ses_big');
    await Bun.sleep(30);
    // The 90 paging calls are setup, not the measured frame budget below. On slower
    // machines they can take close to 30s by themselves, so the harness timeout is
    // generous while `firstFrame` and `steady` keep their strict budgets.
    for (let page = 0; page < 90; page += 1) await controller.loadOlder('ses_big');
    expect(controller.state.transcripts['ses_big']?.messages).toHaveLength(10_000);
    const start = performance.now();
    await setup.renderOnce();
    const firstFrame = performance.now() - start;
    expect(setup.captureCharFrame()).toContain('answer 4999');
    expect(firstFrame).toBeLessThan(4000);
    const steady = performance.now();
    await setup.renderOnce();
    expect(performance.now() - steady).toBeLessThan(200);
  }, 60_000);
});
