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

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'failures leave state intact (#185)',
  () => {
    test('a read-only state directory surfaces an error and keeps the previous file', async () => {
      const { chmod, mkdir } = await import('node:fs/promises');
      const { emptyState, saveState } = await import('../../src/config/local-state.ts');
      const dir = await temp();
      const stateDir = join(dir, 'state');
      await mkdir(stateDir);
      const path = join(stateDir, 'state.json');
      await saveState(path, { ...emptyState, history: { '/p': ['kept'] } });
      await chmod(stateDir, 0o500);
      try {
        let failed = false;
        try {
          await saveState(path, { ...emptyState, history: { '/p': ['lost'] } });
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
      } finally {
        await chmod(stateDir, 0o700);
      }
      expect((await loadState(path)).state.history['/p']).toEqual(['kept']);
    });

    test('an unreadable state file is reported, not treated as empty and rewritten', async () => {
      const { chmod } = await import('node:fs/promises');
      const { emptyState, saveState } = await import('../../src/config/local-state.ts');
      const dir = await temp();
      const path = join(dir, 'state.json');
      await saveState(path, { ...emptyState, history: { '/p': ['kept'] } });
      await chmod(path, 0o000);
      try {
        const loaded = await loadState(path);
        expect(loaded.warning).toContain('Could not read');
      } finally {
        await chmod(path, 0o600);
      }
      expect((await loadState(path)).state.history['/p']).toEqual(['kept']);
    });
  },
);

/** Opt-in: MARGARITA_TINY_DIR is a writable directory on a nearly-full tiny filesystem. */
const tinyDir = process.env['MARGARITA_TINY_DIR'];
describe.skipIf(tinyDir === undefined)('low disk space (#185)', () => {
  test('a failed save on a full filesystem is reported and the previous state survives', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { emptyState, saveState } = await import('../../src/config/local-state.ts');
    const dir = join(tinyDir ?? '', `case-${Date.now()}`);
    dirs.push(dir);
    await mkdir(dir);
    const path = join(dir, 'state.json');
    await saveState(path, { ...emptyState, history: { '/p': ['kept'] } });
    await writeFile(join(dir, 'ballast'), Buffer.alloc(200 * 1024)).catch(() => undefined);
    let failed = false;
    try {
      await saveState(path, { ...emptyState, history: { '/p': ['x'.repeat(100_000)] } });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect((await loadState(path)).state.history['/p']).toEqual(['kept']);
  });
});
