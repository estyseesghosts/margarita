import { describe, expect, test } from 'bun:test';

import { formatModelRef, parseModelRef } from './model-ref.ts';
import { type CatalogModel, resolveEffectiveModel, resolveModel } from './model-resolution.ts';

const catalog: CatalogModel[] = [
  {
    providerID: 'openai',
    modelID: 'gpt-6.1-sol',
    name: 'Sol',
    enabled: true,
    variants: ['low', 'high'],
  },
  { providerID: 'azure', modelID: 'gpt-6.1-sol', name: 'Sol', enabled: true, variants: [] },
  {
    providerID: 'opencode',
    modelID: 'longcat-2.5-free',
    name: 'LongCat',
    enabled: true,
    variants: [],
  },
  {
    providerID: 'commandcode',
    modelID: 'thinkingmachines/inkling-2-small:free',
    name: 'Inkling',
    enabled: true,
    variants: ['default'],
  },
];

describe('parseModelRef', () => {
  test('parses provider, model and variant', () => {
    expect(parseModelRef('openai/gpt-6.1-sol#high')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-6.1-sol',
      variant: 'high',
    });
  });
  test('treats only the first segment as provider', () => {
    expect(parseModelRef('commandcode/thinkingmachines/inkling-2-small:free')).toEqual({
      providerID: 'commandcode',
      modelID: 'thinkingmachines/inkling-2-small:free',
    });
  });
  test('rejects empty pieces', () => {
    expect(parseModelRef('openai/')).toBeUndefined();
    expect(parseModelRef('x#')).toBeUndefined();
    expect(parseModelRef('')).toBeUndefined();
  });
  test('formats provider/model#variant', () => {
    expect(formatModelRef({ providerID: 'a', modelID: 'b/c', variant: 'v' })).toBe('a/b/c#v');
  });
});

describe('resolveModel', () => {
  test('no flags means server default', () => {
    expect(resolveModel({}, catalog)).toEqual({ kind: 'default' });
  });
  test('separate flags resolve to a full selection', () => {
    expect(
      resolveModel({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' }, catalog),
    ).toEqual({
      kind: 'resolved',
      model: { providerID: 'openai', modelID: 'gpt-6.1-sol', variant: 'high' },
    });
  });
  test('provider mismatch fails before anything else', () => {
    expect(resolveModel({ provider: 'azure', model: 'openai/gpt-6.1-sol' }, catalog).kind).toBe(
      'error',
    );
  });
  test('effort contradicting the pinned variant fails', () => {
    expect(resolveModel({ model: 'openai/gpt-6.1-sol#high', effort: 'low' }, catalog).kind).toBe(
      'error',
    );
  });
  test('ambiguous model across providers fails listing providers', () => {
    expect(resolveModel({ model: 'gpt-6.1-sol' }, catalog)).toEqual({
      kind: 'error',
      message: expect.stringContaining('openai, azure'),
    });
  });
  test('unknown variant lists available variants', () => {
    expect(resolveModel({ model: 'openai/gpt-6.1-sol', effort: 'max' }, catalog)).toEqual({
      kind: 'error',
      message: expect.stringContaining('low, high'),
    });
  });
  test('unique bare model resolves', () => {
    expect(resolveModel({ model: 'longcat-2.5-free' }, catalog)).toEqual({
      kind: 'resolved',
      model: { providerID: 'opencode', modelID: 'longcat-2.5-free' },
    });
  });
  test('slash-containing model id resolves with --provider', () => {
    expect(
      resolveModel(
        { provider: 'commandcode', model: 'thinkingmachines/inkling-2-small:free' },
        catalog,
      ),
    ).toEqual({
      kind: 'resolved',
      model: { providerID: 'commandcode', modelID: 'thinkingmachines/inkling-2-small:free' },
    });
  });
  test('fully qualified slash-containing model id resolves', () => {
    expect(
      resolveModel({ model: 'commandcode/thinkingmachines/inkling-2-small:free#default' }, catalog),
    ).toEqual({
      kind: 'resolved',
      model: {
        providerID: 'commandcode',
        modelID: 'thinkingmachines/inkling-2-small:free',
        variant: 'default',
      },
    });
  });
  test('effort without model is an error', () => {
    expect(resolveModel({ effort: 'high' }, catalog).kind).toBe('error');
  });
  test('unknown model is an error', () => {
    expect(resolveModel({ model: 'nope' }, catalog).kind).toBe('error');
  });
});

describe('resolveEffectiveModel (#189)', () => {
  const models: CatalogModel[] = [
    { providerID: 'a', modelID: 'm1', name: 'M1', enabled: true, variants: ['high'] },
    { providerID: 'a', modelID: 'm2', name: 'M2', enabled: true, variants: [] },
    { providerID: 'b', modelID: 'off', name: 'Off', enabled: false, variants: [] },
  ];
  const m1 = { providerID: 'a', modelID: 'm1', variant: 'high' };
  const m2 = { providerID: 'a', modelID: 'm2' };
  const gone = { providerID: 'z', modelID: 'gone' };
  const base = { catalogReady: true, catalog: models };

  test('loading until the scoped catalog is verified', () => {
    expect(resolveEffectiveModel({ ...base, catalogReady: false, lastUsed: m1 })).toEqual({
      kind: 'loading',
    });
  });

  test('precedence: selection, pinned project, pinned user, last used, server default', () => {
    const all = {
      ...base,
      selection: m2,
      pinnedProject: m1,
      pinnedUser: { providerID: 'a', modelID: 'm1' },
      lastUsed: m1,
      serverDefault: m2,
    };
    expect(resolveEffectiveModel(all)).toEqual({ kind: 'model', model: m2, source: 'selection' });
    const { selection: _s, ...noSelection } = all;
    expect(resolveEffectiveModel(noSelection)).toMatchObject({ source: 'pinned-project' });
    const { pinnedProject: _p, ...noProject } = noSelection;
    expect(resolveEffectiveModel(noProject)).toMatchObject({ source: 'pinned-user' });
    const { pinnedUser: _u, ...noUser } = noProject;
    expect(resolveEffectiveModel(noUser)).toMatchObject({ source: 'last-used', model: m1 });
    const { lastUsed: _l, ...onlyDefault } = noUser;
    expect(resolveEffectiveModel(onlyDefault)).toMatchObject({
      source: 'server-default',
      model: m2,
    });
    expect(resolveEffectiveModel(base)).toEqual({ kind: 'none' });
  });

  test('an unavailable pin or selection blocks instead of falling through', () => {
    for (const key of ['selection', 'pinnedProject', 'pinnedUser'] as const) {
      const result = resolveEffectiveModel({
        ...base,
        [key]: gone,
        lastUsed: m1,
        serverDefault: m2,
      });
      expect(result.kind).toBe('blocked');
    }
    expect(
      resolveEffectiveModel({
        ...base,
        pinnedUser: { providerID: 'a', modelID: 'm1', variant: 'x' },
      }).kind,
    ).toBe('blocked');
    expect(
      resolveEffectiveModel({ ...base, pinnedUser: { providerID: 'b', modelID: 'off' } }).kind,
    ).toBe('blocked');
  });

  test('a stale remembered model is skipped in favour of the visible server default', () => {
    expect(resolveEffectiveModel({ ...base, lastUsed: gone, serverDefault: m2 })).toEqual({
      kind: 'model',
      model: m2,
      source: 'server-default',
    });
    expect(resolveEffectiveModel({ ...base, lastUsed: gone })).toEqual({ kind: 'none' });
  });
});
