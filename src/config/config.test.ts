import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pickTheme } from '../ui/theme.ts';
import { defaultConfig, loadConfig, parseConfig, stripJsonComments } from './config.ts';
import { emptyState, loadState, mergeState, parseState, saveState } from './local-state.ts';
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
      theme: 'high-contrast',
      animation: true,
      ascii: true,
    });
    const bad = parseConfig({ ui: { theme: 'neon', animation: 'no' } });
    expect(bad.config.ui).toEqual(defaultConfig.ui);
    expect(bad.warnings).toHaveLength(2);
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
