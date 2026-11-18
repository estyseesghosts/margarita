import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pickTheme } from '../ui/theme.ts';
import { defaultConfig, loadConfig, parseConfig, stripJsonComments } from './config.ts';
import { emptyState, loadState, parseState, saveState } from './local-state.ts';
import { appPaths } from './paths.ts';

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
  test('corrupt state resets with a warning', async () => {
    const dir = await tempDir();
    const path = join(dir, 'state.json');
    await Bun.write(path, '{not json');
    const result = await loadState(path);
    expect(result.state).toEqual(emptyState);
    expect(result.warning).toBeDefined();
  });
  test('drops malformed entries', () => {
    expect(
      parseState({ schemaVersion: 1, history: { a: ['x', 2] }, recentModels: [{ providerID: 1 }] }),
    ).toEqual({ schemaVersion: 1, history: { a: ['x'] }, recentModels: [] });
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
