import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { toModelSelection } from '../adapter/wire-mapping.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState, type LocalState, mergeState, parseState } from '../config/local-state.ts';
import { isRecord } from '../domain/backend-event.ts';
import { composerFrom } from '../domain/composer.ts';
import type { ModelSelection } from '../domain/model-ref.ts';
import { sameModel } from '../domain/model-ref.ts';
import type { CatalogModel } from '../domain/model-resolution.ts';
import { isModelAvailable } from '../domain/model-resolution.ts';
import type { SessionSummary } from '../domain/session.ts';
import { AppController } from './controller.ts';

const fast: ModelSelection = { providerID: 'free', modelID: 'fast', variant: 'low' };
const paid: ModelSelection = { providerID: 'paid', modelID: 'big' };
const catalog: CatalogModel[] = [
  { providerID: 'free', modelID: 'fast', name: 'Fast', enabled: true, variants: ['low', 'high'] },
  { providerID: 'paid', modelID: 'big', name: 'Big', enabled: true, variants: [] },
];

function session(id: string, serverID = 'local'): SessionSummary {
  return {
    id,
    serverID,
    projectID: 'p',
    directory: '/work',
    createdAt: 0,
    updatedAt: 1,
    archived: false,
  };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await Promise.resolve();
}

type Fixture = Awaited<ReturnType<typeof boot>>;

async function boot(
  options: {
    state?: LocalState;
    setup?: (backend: FakeBackend) => void;
    save?: (state: LocalState) => Promise<LocalState | void>;
  } = {},
) {
  const backend = new FakeBackend();
  backend.models = catalog;
  backend.serverDefaultModel = paid;
  options.setup?.(backend);
  const saved: LocalState[] = [];
  const controller = new AppController({
    backend,
    config: defaultConfig,
    localState: options.state ?? emptyState,
    platform: 'linux',
    cwd: '/work',
    version: 'test',
    now: () => 1000,
    saveLocalState: async (state) => {
      saved.push(state);
      const merged = await options.save?.(state);
      return { state: merged ?? state };
    },
    listFiles: async () => [],
    requestExit: () => {},
  });
  await controller.bootstrap();
  controller.startNewSession('/work');
  await flush();
  return { backend, controller, saved };
}

function lastSaved(fixture: Fixture): LocalState {
  const state = fixture.saved.at(-1);
  if (state === undefined) throw new Error('nothing was saved');
  return state;
}

async function send(fixture: Fixture, text: string): Promise<void> {
  fixture.controller.setComposer(composerFrom(text));
  await fixture.controller.submit();
  await flush();
}

function createdModel(backend: FakeBackend): ModelSelection | undefined {
  const call = backend.calls.find((entry) => entry.name === 'createSession');
  const args = call?.args[0];
  if (typeof args !== 'object' || args === null || !('model' in args)) return undefined;
  const { model } = args;
  return isRecord(model) &&
    typeof model['providerID'] === 'string' &&
    typeof model['modelID'] === 'string'
    ? {
        providerID: model['providerID'],
        modelID: model['modelID'],
        ...(typeof model['variant'] === 'string' ? { variant: model['variant'] } : {}),
      }
    : undefined;
}

describe('new-session model selection (#189, #191, #192)', () => {
  test('a fresh install shows and sends the concrete server default', async () => {
    const fixture = await boot();
    expect(fixture.controller.modelFor('local', '/work')).toEqual({ model: paid });
    await send(fixture, 'hello');
    expect(createdModel(fixture.backend)).toEqual(paid);
  });

  test('the last confirmed model is restored after restart and is what gets sent', async () => {
    const first = await boot();
    await first.controller.setModel(fast);
    // An unsent draft selection is not "used" yet.
    expect(first.saved.some((state) => state.lastModels !== undefined)).toBe(false);
    await send(first, 'hello');
    expect(createdModel(first.backend)).toEqual(fast);
    const persisted = lastSaved(first);
    expect(Object.values(persisted.lastModels ?? {})).toEqual([fast]);

    const second = await boot({ state: persisted });
    expect(second.controller.modelFor('local', '/work')).toEqual({ model: fast });
    await send(second, 'again');
    expect(createdModel(second.backend)).toEqual(fast);
  });

  test('a stale remembered model falls back to the displayed server default', async () => {
    const stale = { providerID: 'gone', modelID: 'old' };
    const state: LocalState = { ...emptyState, lastModels: { 'local|/work': stale } };
    const fixture = await boot({ state });
    expect(fixture.controller.modelFor('local', '/work')).toEqual({ model: paid });
    await send(fixture, 'hello');
    expect(createdModel(fixture.backend)).toEqual(paid);
  });

  test('remembered models never leak to another host with the same model IDs', async () => {
    const state: LocalState = { ...emptyState, lastModels: { 'srv_1|/work': fast } };
    const fixture = await boot({ state });
    expect(fixture.controller.modelFor('local', '/work')).toEqual({ model: paid });
  });

  test('before the catalog is verified the model is loading, never "default"', async () => {
    const backend = new FakeBackend();
    backend.models = catalog;
    const gate = Promise.withResolvers<CatalogModel[]>();
    backend.listModels = () => gate.promise;
    const controller = new AppController({
      backend,
      config: defaultConfig,
      localState: emptyState,
      platform: 'linux',
      cwd: '/work',
      version: 'test',
      now: () => 1000,
      saveLocalState: async () => {},
      listFiles: async () => [],
      requestExit: () => {},
    });
    const booting = controller.bootstrap();
    await flush();
    expect(controller.modelFor('local', '/work')).toEqual({ status: 'loading' });
    gate.resolve(catalog);
    await booting;
  });
});

async function inSession() {
  const fixture = await boot({
    setup: (backend) => {
      backend.sessions = [session('ses_a')];
    },
  });
  fixture.controller.openSession('ses_a', 'local');
  await flush();
  return fixture;
}

describe('recent models only record confirmed use (#191)', () => {
  test('a rejected switch records nothing', async () => {
    const fixture = await inSession();
    fixture.backend.switchModelError = new Error('provider refused');
    await fixture.controller.setModel(fast);
    expect(fixture.controller.state.recentModels).toEqual([]);
    expect(fixture.controller.state.lastModels).toEqual({});
    expect(fixture.saved.some((state) => state.recentModels.length > 0)).toBe(false);
  });

  test('a mismatched confirmation records nothing', async () => {
    const fixture = await inSession();
    fixture.backend.getSession = async () => ({ ...session('ses_a'), model: paid });
    await fixture.controller.setModel(fast);
    expect(fixture.controller.state.recentModels).toEqual([]);
    expect(fixture.controller.state.lastModels).toEqual({});
  });

  test('a confirmed switch records the exact provider, model and variant', async () => {
    const fixture = await inSession();
    await fixture.controller.setModel(fast);
    expect(fixture.controller.state.recentModels).toEqual([fast]);
    expect(Object.values(fixture.controller.state.lastModels)).toEqual([fast]);
  });

  test('a superseded switch is not recorded', async () => {
    const fixture = await inSession();
    const gate = Promise.withResolvers<void>();
    const real = fixture.backend.switchModel.bind(fixture.backend);
    let first = true;
    fixture.backend.switchModel = async (id, model) => {
      if (first) {
        first = false;
        await gate.promise;
      }
      await real(id, model);
    };
    const older = fixture.controller.setModel(fast);
    await flush();
    const newer = fixture.controller.setModel(paid);
    gate.resolve();
    await Promise.all([older, newer]);
    expect(fixture.controller.state.recentModels.map((model) => model.modelID)).not.toContain(
      'fast',
    );
  });
});

describe('/model default (#190)', () => {
  test('pin, restart, create: the pinned model wins over last used and is sent', async () => {
    const first = await boot();
    await first.controller.setModel(fast);
    await send(first, '/model default set');
    expect(Object.values(lastSaved(first).pinnedModels ?? {})).toEqual([fast]);
    expect(first.backend.calls.some((call) => call.name === 'prompt')).toBe(false);

    const state: LocalState = {
      ...lastSaved(first),
      lastModels: { 'local|/work': paid },
    };
    const second = await boot({ state });
    expect(second.controller.modelFor('local', '/work')).toEqual({ model: fast });
    await send(second, 'go');
    expect(createdModel(second.backend)).toEqual(fast);
    // Changing the active model never mutates the pin.
    expect(second.controller.state.pinnedModels['user']).toEqual(fast);
  });

  test('clear restores automatic selection', async () => {
    const state: LocalState = { ...emptyState, pinnedModels: { user: fast } };
    const fixture = await boot({ state });
    await send(fixture, '/model default clear');
    expect(fixture.controller.modelFor('local', '/work')).toEqual({ model: paid });
    expect(lastSaved(fixture).pinnedModels).toEqual({});
  });

  test('adopts pins another process wrote during the save (#273)', async () => {
    const foreign: LocalState = {
      ...emptyState,
      pinnedModels: { 'project:other|/elsewhere': paid },
      pinnedModelOps: {
        'project:other|/elsewhere': {
          revision: 3,
          model: paid,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
    };
    const fixture = await boot({ save: async (state) => mergeState(state, foreign) });
    await fixture.controller.setModel(fast);
    await send(fixture, '/model default set');
    expect(fixture.controller.state.pinnedModels).toEqual({
      'project:other|/elsewhere': paid,
      user: fast,
    });
  });

  test('a pinned model missing from the catalog blocks instead of switching silently', async () => {
    const gone = { providerID: 'gone', modelID: 'x' };
    const state: LocalState = { ...emptyState, pinnedModels: { user: gone } };
    const fixture = await boot({ state });
    expect(fixture.controller.modelFor('local', '/work')).toEqual({ status: 'unavailable' });
    await send(fixture, 'hello');
    expect(fixture.backend.calls.some((call) => call.name === 'createSession')).toBe(false);
    expect(fixture.controller.state.notice?.text).toContain('No prompt sent');
  });

  test('bad syntax is reported and never reaches the agent', async () => {
    const fixture = await boot();
    await send(fixture, '/model default frobnicate');
    expect(fixture.controller.state.notice?.text).toContain('Usage: /model default');
    expect(fixture.backend.calls.some((call) => call.name === 'createSession')).toBe(false);
  });

  test('a project pin overrides the user pin for that project only', async () => {
    const fixture = await boot();
    await fixture.controller.setModel(fast);
    await send(fixture, '/model default set project');
    expect(Object.keys(fixture.controller.state.pinnedModels)).toEqual(['project:local|/work']);
    expect(fixture.controller.modelFor('local', '/work')).toEqual({ model: fast });
  });
});

/** The server reports `variant: "default"` for every session model it stores. */
function reportDefault(backend: FakeBackend): void {
  const real = backend.getSession.bind(backend);
  backend.getSession = async (id) => {
    const found = await real(id);
    return found.model === undefined
      ? found
      : { ...found, model: { ...found.model, variant: 'default' } };
  };
}

function count(backend: FakeBackend, name: string): number {
  return backend.calls.filter((call) => call.name === name).length;
}

describe('omitted variant and server "default" are the same selection (#206)', () => {
  const liquid: ModelSelection = { providerID: 'openrouter', modelID: 'liquid/lfm-3-1.7b:free' };
  const liquidCatalog: CatalogModel[] = [
    { ...liquid, name: 'LFM', enabled: true, variants: [] },
    ...catalog,
  ];

  test('the first prompt is sent once, without a spurious switchModel', async () => {
    const fixture = await boot({
      setup: (backend) => {
        backend.models = liquidCatalog;
        reportDefault(backend);
      },
    });
    await fixture.controller.setModel(liquid);
    await send(fixture, 'hello');
    expect(count(fixture.backend, 'createSession')).toBe(1);
    expect(count(fixture.backend, 'switchModel')).toBe(0);
    expect(count(fixture.backend, 'prompt')).toBe(1);
    expect(createdModel(fixture.backend)).toEqual(liquid);
    expect(fixture.controller.state.lastModels['local|/work']).toEqual(liquid);
  });

  test('an existing session confirms omitted vs default in both directions', async () => {
    const fixture = await boot({
      setup: (backend) => {
        backend.models = liquidCatalog;
        backend.sessions = [session('ses_a')];
        reportDefault(backend);
      },
    });
    fixture.controller.openSession('ses_a', 'local');
    await flush();
    await fixture.controller.setModel(liquid);
    expect(fixture.controller.state.recentModels).toEqual([liquid]);
    // Inverse: explicitly requested #default, server reports it omitted.
    const second = await boot({
      setup: (backend) => {
        backend.models = liquidCatalog;
        backend.sessions = [session('ses_a')];
      },
    });
    second.controller.openSession('ses_a', 'local');
    await flush();
    await second.controller.setModel({ ...liquid, variant: 'default' });
    expect(second.controller.state.recentModels).toEqual([liquid]);
    second.controller.setComposer(composerFrom('go'));
    await second.controller.submit();
    await flush();
    expect(count(second.backend, 'prompt')).toBe(1);
  });

  test('a real mismatch still blocks: other effort, model or provider', async () => {
    for (const reported of [
      { ...liquid, variant: 'default' },
      { providerID: 'openrouter', modelID: 'other' },
      { providerID: 'elsewhere', modelID: liquid.modelID },
    ]) {
      const fixture = await boot({
        setup: (backend) => {
          backend.models = [
            { ...liquid, name: 'LFM', enabled: true, variants: ['high'] },
            ...catalog,
          ];
          backend.sessions = [session('ses_a')];
          const real = backend.getSession.bind(backend);
          backend.getSession = async (id) => ({ ...(await real(id)), model: reported });
        },
      });
      fixture.controller.openSession('ses_a', 'local');
      await flush();
      await fixture.controller.setModel({ ...liquid, variant: 'high' });
      expect(fixture.controller.state.recentModels).toEqual([]);
      fixture.controller.setComposer(composerFrom('do not send'));
      await fixture.controller.submit();
      await flush();
      expect(count(fixture.backend, 'prompt')).toBe(0);
    }
  });

  test('a new-session confirmation mismatch never dispatches the prompt', async () => {
    const fixture = await boot({
      setup: (backend) => {
        backend.models = [
          { ...liquid, name: 'LFM', enabled: true, variants: ['high'] },
          ...catalog,
        ];
        const real = backend.getSession.bind(backend);
        backend.getSession = async (id) => ({
          ...(await real(id)),
          model: { ...liquid, variant: 'default' },
        });
      },
    });
    await fixture.controller.setModel({ ...liquid, variant: 'high' });
    await send(fixture, 'hello');
    expect(count(fixture.backend, 'prompt')).toBe(0);
    expect(fixture.controller.state.notice?.text).toContain('not confirmed');
  });

  test('a stored #default is available for a model with no listed variants and normalizes on load', async () => {
    const state = parseState({
      schemaVersion: 1,
      history: {},
      recentModels: [{ ...liquid, variant: 'default' }],
      pinnedModels: { user: { ...liquid, variant: 'default' } },
      lastModels: { 'local|/work': { ...liquid, variant: 'default' } },
    });
    expect(state.recentModels).toEqual([liquid]);
    expect(state.pinnedModels).toEqual({ user: liquid });
    const fixture = await boot({
      state,
      setup: (backend) => {
        backend.models = liquidCatalog;
      },
    });
    expect(fixture.controller.modelFor('local', '/work')).toEqual({ model: liquid });
    expect(isModelAvailable(liquidCatalog, { ...liquid, variant: 'default' })).toBe(true);
    expect(isModelAvailable(liquidCatalog, { ...liquid, variant: 'high' })).toBe(false);
  });

  test('semantic comparison and the wire mapper agree', () => {
    expect(sameModel(liquid, { ...liquid, variant: 'default' })).toBe(true);
    expect(sameModel({ ...liquid, variant: 'default' }, liquid)).toBe(true);
    expect(sameModel({ ...liquid, variant: 'high' }, { ...liquid, variant: 'default' })).toBe(
      false,
    );
    expect(sameModel(liquid, { ...liquid, modelID: 'x' })).toBe(false);
    expect(
      toModelSelection({ id: liquid.modelID, providerID: liquid.providerID, variant: 'default' }),
    ).toEqual(liquid);
    expect(
      toModelSelection({ id: liquid.modelID, providerID: liquid.providerID, variant: 'high' }),
    ).toEqual({ ...liquid, variant: 'high' });
  });
});
