import { afterEach, describe, expect, test } from 'bun:test';
import { access, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pickTheme, withAccentOverrides } from '../ui/theme.ts';
import { defaultConfig, loadConfig, parseConfig, stripJsonComments } from './config.ts';
import {
  emptyState,
  loadState,
  LocalStateSafetyError,
  mergeState,
  parseState,
  saveState,
} from './local-state.ts';
import type { LocalStateIO, PinnedModelOperation } from './local-state.ts';
import { appPaths } from './paths.ts';
import { IncompatibleSchemaError } from './schema-guard.ts';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'margarita-test-'));
  temps.push(dir);
  return dir;
}

describe('config', () => {
  test('strips comments and trailing commas but not string contents', () => {
    const text = '{ // c\n "a": "http://x/*y*/", /* b */ "b": [1,2,], }';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 'http://x/*y*/', b: [1, 2] });
  });
  test('trailing-comma cleanup is string-aware', () => {
    const cases: Array<[string, unknown]> = [
      ['{"keys":{"x":"foo,}"},}', { keys: { x: 'foo,}' } }],
      ['{"keys":{"x":"foo, ]"},}', { keys: { x: 'foo, ]' } }],
      ['{"a":",]"}', { a: ',]' }],
      ['["a,}", "b, ]",]', ['a,}', 'b, ]']],
      ['{"a":"escaped \\"quote,}",}', { a: 'escaped "quote,}' }],
      ['{"a":"back \\\\ slash,}",}', { a: 'back \\ slash,}' }],
      ['{/* c */ "a": 1, // tail\n}', { a: 1 }],
      ['{"a":1,/* between , and } */}', { a: 1 }],
      ['{"a":"http://x",}', { a: 'http://x' }],
      ['{"a":"// not a comment",}', { a: '// not a comment' }],
      ['{"a":"/* not a comment */",}', { a: '/* not a comment */' }],
      ['[1,2,3,]', [1, 2, 3]],
      ['{"a":{"b":[1,{"c":2,},],},}', { a: { b: [1, { c: 2 }] } }],
    ];
    for (const [input, expected] of cases) {
      expect(JSON.parse(stripJsonComments(input))).toEqual(expected);
    }
  });
  test('missing file yields defaults without warnings', async () => {
    expect(await loadConfig(join(await tempDir(), 'none.jsonc'))).toEqual({
      config: defaultConfig,
      warnings: [],
    });
  });
  test('invalid fields fall back individually with warnings', () => {
    const { config, warnings } = parseConfig({
      agents: { default: 'plan', cycle: 'nope' },
      input: { enterWhileRunning: 'yolo' },
      history: { limit: -1 },
      keys: { 'model.pick': 'alt+m', bad: 3 },
      extra: true,
    });
    expect(config.agents).toEqual({ default: 'plan', cycle: ['build', 'plan'] });
    expect(config.input.enterWhileRunning).toBe('queue');
    expect(config.history.limit).toBe(200);
    expect(config.keys).toEqual({ 'model.pick': 'alt+m' });
    expect(warnings).toHaveLength(5);
  });
  test('ui theme and accessibility switches', () => {
    expect(parseConfig({ ui: { theme: 'high-contrast', ascii: true } }).config.ui).toEqual({
      ...defaultConfig.ui,
      theme: 'high-contrast',
      ascii: true,
    });
    const bad = parseConfig({ ui: { theme: 'neon', animation: 'no' } });
    expect(bad.config.ui).toEqual(defaultConfig.ui);
    expect(bad.warnings).toHaveLength(2);
  });
  test('ui accent colours validate as #rrggbb, falling back per field', () => {
    const parsed = parseConfig({
      ui: { accent: '#00ff88', accentLight: 'peach', caret: '#ff0000' },
    });
    expect(parsed.config.ui).toEqual({
      ...defaultConfig.ui,
      accent: '#00ff88',
      caret: '#ff0000',
    });
    expect(parsed.warnings).toEqual(['ui.accentLight must be a #rrggbb colour']);

    const upper = parseConfig({ ui: { accent: '#00FF88' } });
    expect(upper.config.ui.accent).toBe('#00FF88');
    expect(upper.warnings).toEqual([]);
  });
  test('startup, footer and reduced-motion preferences validate', () => {
    const parsed = parseConfig({
      ui: {
        defaultRoute: 'overview',
        reducedMotion: true,
        footer: ['agent', 'tokens', 'bogus', 'agent'],
      },
    });
    expect(parsed.config.ui.defaultRoute).toBe('overview');
    expect(parsed.config.ui.reducedMotion).toBe(true);
    expect(parsed.config.ui.footer).toEqual(['agent', 'tokens']);
    expect(parsed.warnings).toEqual(['ui.footer has unknown entry "bogus"']);
    const bad = parseConfig({ ui: { defaultRoute: 'sideways', footer: 'tokens' } });
    expect(bad.config.ui.defaultRoute).toBe('new');
    expect(bad.config.ui.footer).toEqual(defaultConfig.ui.footer);
    expect(bad.warnings).toEqual([
      'ui.footer must be an array of strings',
      'ui.defaultRoute must be one of new, overview',
    ]);
  });
  test('transcript detail preferences validate with current defaults', () => {
    expect(defaultConfig.transcript).toEqual({
      toolOutputChars: 64_000,
      detailed: false,
      reasoning: 'details-only',
      previewRows: 12,
      groupTools: 'compact',
    });
    const parsed = parseConfig({
      transcript: {
        detailed: true,
        reasoning: 'always',
        previewRows: 40,
        groupTools: 'none',
      },
    });
    expect(parsed.config.transcript).toEqual({
      toolOutputChars: 64_000,
      detailed: true,
      reasoning: 'always',
      previewRows: 40,
      groupTools: 'none',
    });
    const bad = parseConfig({
      transcript: { reasoning: 'sometimes', previewRows: 0, groupTools: 5 },
    });
    expect(bad.config.transcript).toEqual(defaultConfig.transcript);
    expect(bad.warnings).toEqual([
      'transcript.reasoning must be one of hidden, details-only, always',
      'transcript.previewRows must be a positive integer',
      'transcript.groupTools must be one of compact, none',
    ]);
  });
  test('servers, default model, debug log and array key overrides validate', () => {
    const parsed = parseConfig({
      servers: { launch: 'home', connect: ['home', 'work', 'home'] },
      models: { default: 'anthropic/claude#high' },
      debugLog: '/tmp/marg.log',
      keys: { 'nav.cancel': ['escape', 'f12'], 'help.show': 'unbound' },
    });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config.servers).toEqual({ launch: 'home', connect: ['home', 'work'] });
    expect(parsed.config.models.default).toBe('anthropic/claude#high');
    expect(parsed.config.debugLog).toBe('/tmp/marg.log');
    expect(parsed.config.keys).toEqual({
      'nav.cancel': ['escape', 'f12'],
      'help.show': 'unbound',
    });
    const bad = parseConfig({
      servers: { launch: 5, connect: 'home' },
      models: { default: 'not a model!' },
      keys: { up: 5 },
    });
    expect(bad.config.servers).toEqual({ launch: 'local' });
    expect(bad.config.models.default).toBeUndefined();
    expect(bad.config.keys).toEqual({});
    expect(bad.warnings).toContain('servers.launch must be a non-empty string');
    expect(bad.warnings).toContain('servers.connect must be an array of strings');
    expect(bad.warnings).toContain('keys.up must be a single key or an array of keys');
  });
  test('clipboard preferences default on and validate as booleans (issue #4)', () => {
    expect(defaultConfig.clipboard).toEqual({
      autoCopy: true,
      rightClickCopy: true,
      rightClickPaste: true,
    });
    const parsed = parseConfig({
      clipboard: { autoCopy: false, rightClickCopy: true, rightClickPaste: false },
    });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config.clipboard).toEqual({
      autoCopy: false,
      rightClickCopy: true,
      rightClickPaste: false,
    });
    const bad = parseConfig({ clipboard: { autoCopy: 'yes', rightClickPaste: 1 } });
    expect(bad.config.clipboard).toEqual(defaultConfig.clipboard);
    expect(bad.warnings).toEqual([
      'clipboard.autoCopy must be a boolean',
      'clipboard.rightClickPaste must be a boolean',
    ]);
  });
});

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const high = Math.max(luminance(a), luminance(b));
  const low = Math.min(luminance(a), luminance(b));
  return (high + 0.05) / (low + 0.05);
}

describe('themes', () => {
  test('text colours meet WCAG AA against their intended background', () => {
    const cases = [
      { name: 'dark', background: '#000000' },
      { name: 'light', background: '#ffffff' },
      { name: 'high-contrast', background: '#000000' },
    ] as const;
    for (const { name, background } of cases) {
      const theme = pickTheme({}, name);
      for (const role of ['text', 'dim', 'accent', 'error', 'warn', 'success'] as const) {
        expect(contrast(theme[role], background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  test('NO_COLOR overrides any configured theme', () => {
    expect(pickTheme({ NO_COLOR: '1' }, 'light').text).toBe('#ffffff');
  });
  test('accent overrides never mutate the built-in palette', () => {
    const dark = pickTheme({}, 'dark');
    const custom = withAccentOverrides(dark, { accent: '#00ff88' });
    expect(custom).not.toBe(dark);
    expect(custom.accent).toBe('#00ff88');
    expect(custom.accentLight).toBe('#00ff88');
    expect(custom.caret).toBe('#00ff88');
    expect(dark.accent).toBe('#e4677e');
    expect(dark.accentLight).toBe('#ffd3a8');
    expect(dark.caret).toBe('#e4677e');
  });
  test('the caret follows the accent unless it has its own colour', () => {
    const dark = pickTheme({}, 'dark');
    expect(withAccentOverrides(dark, {})).toBe(dark);
    const lightOnly = withAccentOverrides(dark, { accentLight: '#ffd3a8' });
    expect(lightOnly.caret).toBe(dark.accent);
    const custom = withAccentOverrides(dark, { accent: '#00ff88', caret: '#123456' });
    expect(custom.caret).toBe('#123456');
    expect(custom.accentLight).toBe('#00ff88');
  });
  test('NO_COLOR ignores configured accent colours', () => {
    const plain = pickTheme({ NO_COLOR: '1' });
    expect(withAccentOverrides(plain, { accent: '#00ff88', caret: '#ff0000' })).toBe(plain);
  });
});

describe('local state', () => {
  test('round-trips atomically', async () => {
    const path = join(await tempDir(), 'nested', 'state.json');
    const state = {
      schemaVersion: 1 as const,
      history: { '/x': ['hi'] },
      recentModels: [{ providerID: 'opencode', modelID: 'longcat-2.5-free' }],
    };
    await saveState(path, state);
    expect((await loadState(path)).state).toEqual(state);
    expect(await readFile(path, 'utf8')).toContain('longcat');
  });
  test('corrupt state is preserved aside with a warning, never silently reset', async () => {
    const dir = await tempDir();
    const path = join(dir, 'state.json');
    await Bun.write(path, '{not json');
    const result = await loadState(path);
    expect(result.state).toEqual(emptyState);
    expect(result.warning).toContain('preserved');
    expect((await readdir(dir)).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true);
  });

  test('a newer schema is reported as incompatible and left untouched (#150)', async () => {
    const dir = await tempDir();
    const path = join(dir, 'state.json');
    const raw = '{"schemaVersion":2,"history":{"/p":["keep me"]},"recentModels":[],"future":true}';
    await Bun.write(path, raw);
    const result = await loadState(path);
    expect(result.incompatible?.version).toBe(2);
    expect(result.warning).toContain('schema version 2');
    expect(await readFile(path, 'utf8')).toBe(raw);

    // A later write must not downgrade or destroy the newer file.
    let failed: unknown;
    try {
      await saveState(path, { schemaVersion: 1, history: {}, recentModels: [] });
    } catch (cause) {
      failed = cause;
    }
    expect(failed).toBeInstanceOf(IncompatibleSchemaError);
    expect(await readFile(path, 'utf8')).toBe(raw);
  });

  test('a missing file still starts from safe empty v1 state', async () => {
    const path = join(await tempDir(), 'missing', 'state.json');
    const result = await loadState(path);
    expect(result.state).toEqual(emptyState);
    expect(result.incompatible).toBeUndefined();
  });
  test('drops malformed entries', () => {
    expect(
      parseState({ schemaVersion: 1, history: { a: ['x', 2] }, recentModels: [{ providerID: 1 }] }),
    ).toEqual({ schemaVersion: 1, history: { a: ['x'] }, recentModels: [] });
  });
  test('merge keeps both writers\u2019 distinct project histories', () => {
    const ours = {
      schemaVersion: 1 as const,
      history: { '/project-a': ['a1', 'a2'] },
      recentModels: [{ providerID: 'p', modelID: 'ours' }],
    };
    const theirs = {
      schemaVersion: 1 as const,
      history: { '/project-b': ['b1'], '/project-a': ['a0'] },
      recentModels: [{ providerID: 'p', modelID: 'theirs' }],
    };
    const merged = mergeState(ours, theirs);
    expect(merged.history['/project-a']).toEqual(['a0', 'a1', 'a2']);
    expect(merged.history['/project-b']).toEqual(['b1']);
    expect(merged.recentModels.map((entry) => entry.modelID)).toEqual(['ours', 'theirs']);
  });
  test('concurrent saves from separate writers retain both histories', async () => {
    const dir = await tempDir();
    const path = join(dir, 'state.json');
    // Simulate two processes: each holds its own snapshot derived from the same baseline.
    const base = { schemaVersion: 1 as const, history: {}, recentModels: [] };
    const writerA = saveState(path, {
      ...base,
      history: { '/a': ['a1'] },
    });
    const writerB = saveState(path, {
      ...base,
      history: { '/b': ['b1'] },
    });
    await Promise.all([writerA, writerB]);
    const { state } = await loadState(path);
    expect(state.history['/a']).toEqual(['a1']);
    expect(state.history['/b']).toEqual(['b1']);
  });
  test('overlapping saves in one process do not corrupt the file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'state.json');
    let state = {
      schemaVersion: 1 as const,
      history: {} as Record<string, string[]>,
      recentModels: [] as never[],
    };
    const saves: Promise<unknown>[] = [];
    for (let index = 0; index < 12; index += 1) {
      state = {
        ...state,
        history: {
          ...state.history,
          [`/p${index % 3}`]: [...(state.history[`/p${index % 3}`] ?? []), `entry-${index}`],
        },
      };
      saves.push(saveState(path, state));
    }
    await Promise.all(saves);
    const { state: loaded } = await loadState(path);
    const all = Object.values(loaded.history).flat();
    expect(all.length).toBeGreaterThanOrEqual(12);
    // No temp files should be left behind.
    const leftovers = (await readdir(dir)).filter((name) => name.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

/** Real I/O with individual operations replaced by deterministic faults (#336). */
function ioWith(overrides: Partial<LocalStateIO>): LocalStateIO {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    rename: async (from, to) => {
      await rename(from, to);
    },
    verify: async (path) => {
      await access(path);
    },
    ...overrides,
  };
}

function readError(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code} while reading state`), { code });
}

describe('non-destructive local-state saves (#336)', () => {
  const pending = { schemaVersion: 1 as const, history: { '/p': ['new'] }, recentModels: [] };

  test('a non-ENOENT read failure refuses the save and leaves the original bytes intact', async () => {
    const path = join(await tempDir(), 'state.json');
    const original = '{"schemaVersion":1,"history":{"/p":["keep"]},"recentModels":[]}\n';
    await Bun.write(path, original);
    for (const code of ['EACCES', 'EIO', 'EPERM']) {
      let failure: unknown;
      try {
        await saveState(
          path,
          pending,
          undefined,
          ioWith({
            readFile: async () => {
              throw readError(code);
            },
          }),
        );
      } catch (cause) {
        failure = cause;
      }
      if (!(failure instanceof LocalStateSafetyError)) {
        throw new Error(`expected a LocalStateSafetyError, got ${String(failure)}`);
      }
      expect(failure.reason).toBe('unreadable');
      expect(failure.message).toContain('left unchanged');
      expect(await readFile(path, 'utf8')).toBe(original);
    }
  });

  test('ENOENT still creates a new file with the merged snapshot', async () => {
    const path = join(await tempDir(), 'missing', 'state.json');
    const result = await saveState(path, pending);
    expect(result.state.history['/p']).toEqual(['new']);
    expect((await loadState(path)).state).toEqual(pending);
  });

  test('corrupt JSON with a verified backup is reported at its exact path', async () => {
    const dir = await tempDir();
    const path = join(dir, 'state.json');
    const corrupt = '{not json';
    await Bun.write(path, corrupt);
    const result = await saveState(path, pending);
    const backupName = (await readdir(dir)).find((name) => name.startsWith('state.json.corrupt-'));
    expect(backupName).toBeDefined();
    expect(result.warning).toContain(backupName ?? '');
    expect(await readFile(join(dir, backupName ?? ''), 'utf8')).toBe(corrupt);
    expect((await loadState(path)).state).toEqual(pending);
  });

  test('a failed backup rename leaves the corrupt original untouched and claims no backup', async () => {
    const dir = await tempDir();
    const path = join(dir, 'state.json');
    const corrupt = '{not json';
    await Bun.write(path, corrupt);
    let failure: unknown;
    try {
      await saveState(
        path,
        pending,
        undefined,
        ioWith({
          rename: async () => {
            throw readError('EACCES');
          },
        }),
      );
    } catch (cause) {
      failure = cause;
    }
    if (!(failure instanceof LocalStateSafetyError)) {
      throw new Error(`expected a LocalStateSafetyError, got ${String(failure)}`);
    }
    expect(failure.reason).toBe('backup-failed');
    expect(await readFile(path, 'utf8')).toBe(corrupt);
    expect((await readdir(dir)).some((name) => name.includes('.corrupt-'))).toBe(false);
  });

  test('pending edits survive an I/O failure and the next legitimate save succeeds', async () => {
    const path = join(await tempDir(), 'state.json');
    const original = '{"schemaVersion":1,"history":{"/p":["keep"]},"recentModels":[]}\n';
    await Bun.write(path, original);
    let allowRead = false;
    const io = ioWith({
      readFile: (target) => {
        if (!allowRead) throw readError('EIO');
        return readFile(target, 'utf8');
      },
    });
    let failure: unknown;
    try {
      await saveState(path, pending, undefined, io);
    } catch (cause) {
      failure = cause;
    }
    if (!(failure instanceof LocalStateSafetyError)) {
      throw new Error(`expected a LocalStateSafetyError, got ${String(failure)}`);
    }
    expect(failure.reason).toBe('unreadable');
    expect(await readFile(path, 'utf8')).toBe(original);
    allowRead = true;
    await saveState(path, pending, undefined, io);
    expect((await loadState(path)).state).toEqual({
      schemaVersion: 1,
      history: { '/p': ['keep', 'new'] },
      recentModels: [],
    });
  });
});

describe('paths', () => {
  test('never point into OpenCode directories', () => {
    const windows = appPaths({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32');
    const unix = appPaths({ XDG_CONFIG_HOME: '/c', XDG_STATE_HOME: '/s' }, 'linux');
    for (const path of [windows.configFile, windows.stateFile, unix.configFile, unix.stateFile]) {
      expect(path).toContain('margarita');
      expect(path).not.toContain('opencode');
    }
  });
});

const m = (modelID: string) => ({ providerID: 'p', modelID });

describe('pinned and last-used model state (#189, #190)', () => {
  test('round-trips through parseState and tolerates old files', () => {
    const parsed = parseState({
      schemaVersion: 1,
      history: {},
      recentModels: [],
      pinnedModels: { user: { ...m('a'), variant: 'high' }, bad: { providerID: 1 } },
      lastModels: { 'local|/work': m('b') },
    });
    expect(parsed.pinnedModels).toEqual({ user: { ...m('a'), variant: 'high' } });
    expect(parsed.lastModels).toEqual({ 'local|/work': m('b') });
    expect(parseState({ schemaVersion: 1, history: {}, recentModels: [] }).pinnedModels).toBe(
      undefined,
    );
  });
  test('a cleared pin is not resurrected from disk, an untouched writer keeps foreign pins', () => {
    const base = { schemaVersion: 1 as const, history: {}, recentModels: [] };
    const onDisk = { ...base, pinnedModels: { user: m('a') } };
    const clear: PinnedModelOperation = {
      revision: 1,
      model: null,
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(
      mergeState({ ...base, pinnedModels: {}, pinnedModelOps: { user: clear } }, onDisk)
        .pinnedModels,
    ).toBeUndefined();
    expect(mergeState(base, onDisk).pinnedModels).toEqual({ user: m('a') });
  });
  test('independent scopes survive an interleaved write from a stale snapshot (#273)', async () => {
    const path = join(await tempDir(), 'state.json');
    const base = { schemaVersion: 1 as const, history: {}, recentModels: [] };
    const pinA: PinnedModelOperation = {
      revision: 1,
      model: m('a'),
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const pinB: PinnedModelOperation = {
      revision: 1,
      model: m('b'),
      updatedAt: '2026-01-01T00:00:00Z',
    };
    // Writer A pins project A; writer B still holds the pre-pin snapshot and pins project B.
    await saveState(path, {
      ...base,
      pinnedModels: { 'project:/a': m('a') },
      pinnedModelOps: { 'project:/a': pinA },
    });
    await saveState(path, {
      ...base,
      pinnedModels: { 'project:/b': m('b') },
      pinnedModelOps: { 'project:/b': pinB },
    });
    expect((await loadState(path)).state.pinnedModels).toEqual({
      'project:/a': m('a'),
      'project:/b': m('b'),
    });
  });
  test('a clear wins over a stale writer and the other scope survives (#273)', async () => {
    const path = join(await tempDir(), 'state.json');
    const base = { schemaVersion: 1 as const, history: {}, recentModels: [] };
    const pinA: PinnedModelOperation = {
      revision: 1,
      model: m('a'),
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const pinB: PinnedModelOperation = {
      revision: 1,
      model: m('b'),
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const stale = {
      ...base,
      pinnedModels: { 'project:/a': m('a'), 'project:/b': m('b') },
      pinnedModelOps: { 'project:/a': pinA, 'project:/b': pinB },
    };
    await saveState(path, {
      ...stale,
      pinnedModels: { 'project:/b': m('b') },
      pinnedModelOps: {
        'project:/b': pinB,
        'project:/a': { revision: 2, model: null, updatedAt: '2026-01-01T00:00:01Z' },
      },
    });
    // Re-save the stale writer's unrelated scope: it must not resurrect A.
    await saveState(path, stale);
    expect((await loadState(path)).state.pinnedModels).toEqual({ 'project:/b': m('b') });
  });
  test('same-scope conflicts use revision then timestamp, not object order', () => {
    const base = { schemaVersion: 1 as const, history: {}, recentModels: [] };
    const older: PinnedModelOperation = {
      revision: 1,
      model: m('old'),
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const newer: PinnedModelOperation = {
      revision: 1,
      model: m('new'),
      updatedAt: '2026-01-02T00:00:00Z',
    };
    const left = mergeState(
      { ...base, pinnedModelOps: { user: older } },
      { ...base, pinnedModelOps: { user: newer } },
    );
    const right = mergeState(
      { ...base, pinnedModelOps: { user: newer } },
      { ...base, pinnedModelOps: { user: older } },
    );
    expect(left.pinnedModels).toEqual({ user: m('new') });
    expect(right.pinnedModels).toEqual({ user: m('new') });
  });
  test('last-used merges per scope with the writer winning', () => {
    const base = { schemaVersion: 1 as const, history: {}, recentModels: [] };
    const merged = mergeState(
      { ...base, lastModels: { s1: m('ours') } },
      { ...base, lastModels: { s1: m('theirs'), s2: m('other') } },
    );
    expect(merged.lastModels).toEqual({ s1: m('ours'), s2: m('other') });
  });
});
