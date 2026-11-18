import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import { composerFrom } from '../domain/composer.ts';
import { AppController } from './controller.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeController(listFiles: (root: string) => Promise<string[]>) {
  return new AppController({
    backend: new FakeBackend(),
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles,
    requestExit: () => {},
  });
}

async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await Bun.sleep(0);
}

describe('@file completion', () => {
  test('shows only the latest query when requests resolve out of order', async () => {
    const scan = deferred<string[]>();
    const controller = makeController(() => scan.promise);

    controller.setComposer(composerFrom('@src/a'));
    controller.setComposer(composerFrom('@docs'));
    scan.resolve(['src/a.ts', 'docs/b.md']);
    await flush();

    expect(controller.state.completion).toEqual({
      kind: 'file',
      items: [{ label: '@docs/b.md', detail: '', insert: '@docs/b.md ' }],
      index: 0,
      start: 0,
    });
    controller.dispose();
  });

  test('launches at most one traversal per directory while typing', async () => {
    const scan = deferred<string[]>();
    let traversals = 0;
    const controller = makeController(() => {
      traversals += 1;
      return scan.promise;
    });

    controller.setComposer(composerFrom('@a'));
    controller.setComposer(composerFrom('@ab'));
    controller.setComposer(composerFrom('@abc'));
    scan.resolve(['abc-one.ts', 'abc-two.ts']);
    await flush();

    expect(traversals).toBe(1);
    expect(controller.state.completion?.items.map((item) => item.label)).toEqual([
      '@abc-one.ts',
      '@abc-two.ts',
    ]);
    controller.dispose();
  });

  test('a project switch mid-scan cannot inject completions from the old project', async () => {
    const scan = deferred<string[]>();
    const controller = makeController(() => scan.promise);

    controller.setComposer(composerFrom('@a'));
    controller.startNewSession('/elsewhere');
    scan.resolve(['old-project-file.ts']);
    await flush();

    expect(controller.state.completion).toBeUndefined();
    controller.dispose();
  });
});
