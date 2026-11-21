import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadState } from '../../src/config/local-state.ts';
import { appPaths } from '../../src/config/paths.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'marg-linux-'));
  dirs.push(dir);
  return dir;
}

describe.skipIf(process.platform === 'win32')('XDG paths (#185)', () => {
  test('absolute overrides are honoured and never point at OpenCode directories', () => {
    const paths = appPaths(
      { XDG_CONFIG_HOME: '/custom/config', XDG_STATE_HOME: '/custom/state' },
      'linux',
    );
    expect(paths.configFile).toBe('/custom/config/margarita/config.jsonc');
    expect(paths.stateFile).toBe('/custom/state/margarita/state.json');
    expect(paths.serversFile).toBe('/custom/state/margarita/servers.json');
    for (const path of Object.values(paths)) expect(path).not.toContain('opencode');
  });

  test('empty or relative values are ignored as the spec requires', () => {
    for (const bad of ['', 'relative/dir', '.']) {
      const paths = appPaths({ XDG_CONFIG_HOME: bad, XDG_STATE_HOME: bad }, 'linux');
      expect(paths.stateFile.startsWith('/')).toBe(true);
      expect(paths.configFile.startsWith('/')).toBe(true);
    }
  });

  test('POSIX paths stay case-sensitive and distinct', () => {
    expect(appPaths({ XDG_STATE_HOME: '/s/App' }, 'linux').stateDir).not.toBe(
      appPaths({ XDG_STATE_HOME: '/s/app' }, 'linux').stateDir,
    );
  });
});

describe.skipIf(process.platform === 'win32')('cross-process state writes (#185)', () => {
  const writer = join(import.meta.dir, 'state-writer.ts');

  test('two processes saving distinct histories lose nothing and leave 0600 files', async () => {
    const dir = await temp();
    const path = join(dir, 'state', 'state.json');
    const run = (key: string) =>
      Bun.spawn([process.execPath, writer, path, key, '15'], { stdout: 'pipe', stderr: 'pipe' });
    const children = [run('/proj-a'), run('/proj-b'), run('/proj-c')];
    const codes = await Promise.all(children.map((child) => child.exited));
    expect(codes).toEqual([0, 0, 0]);
    const { state } = await loadState(path);
    for (const key of ['/proj-a', '/proj-b', '/proj-c']) {
      expect(state.history[key]).toHaveLength(15);
    }
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }, 60_000);

  test('a killed lock holder is recovered by the next writer', async () => {
    const dir = await temp();
    const path = join(dir, 'state.json');
    const holder = Bun.spawn([process.execPath, writer, path, '/held', '0', 'hold'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await Bun.sleep(500);
    holder.kill('SIGKILL');
    await holder.exited;
    const next = Bun.spawn([process.execPath, writer, path, '/after', '3'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await next.exited).toBe(0);
    expect((await loadState(path)).state.history['/after']).toHaveLength(3);
  }, 60_000);
});
