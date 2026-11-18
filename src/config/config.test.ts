import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
