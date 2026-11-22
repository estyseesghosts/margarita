import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireFileLock, InvalidLockError, LockTimeoutError } from '../../src/config/file-lock.ts';
import { emptyState, loadState, saveState } from '../../src/config/local-state.ts';
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

  test('defaults follow the XDG spec under the real HOME', () => {
    const paths = appPaths({}, 'linux');
    expect(paths.configFile).toBe(join(homedir(), '.config', 'margarita', 'config.jsonc'));
    expect(paths.stateFile).toBe(join(homedir(), '.local', 'state', 'margarita', 'state.json'));
    expect(paths.serversFile).toBe(join(homedir(), '.local', 'state', 'margarita', 'servers.json'));
  });

  test('saving creates only Margarita-owned paths, with private permissions', async () => {
    const root = await temp();
    const paths = appPaths(
      {
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_STATE_HOME: join(root, 'state'),
      },
      'linux',
    );
    await saveState(paths.stateFile, { ...emptyState, history: { '/proj': ['kept'] } });
    expect((await stat(paths.stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.stateFile)).mode & 0o777).toBe(0o600);
    expect(await readdir(paths.stateDir)).toEqual(expect.arrayContaining(['state.json']));
    // Nothing appears under OpenCode's own XDG locations, and no config dir is invented.
    expect(existsSync(join(root, 'config'))).toBe(false);
    expect(existsSync(join(root, '.local', 'share', 'opencode'))).toBe(false);
    expect(existsSync(join(root, 'state', 'opencode'))).toBe(false);
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

  test('a held lock times out with guidance and the persistent path is not removed', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'state.json.lock');
    const first = await acquireFileLock(lockPath, { timeoutMs: 200 });
    let timedOut: unknown;
    try {
      await acquireFileLock(lockPath, { timeoutMs: 50, retryMs: 5 });
    } catch (error) {
      timedOut = error;
    }
    expect(timedOut).toBeInstanceOf(LockTimeoutError);
    expect(existsSync(lockPath)).toBe(true);
    await first.release();
    const next = await acquireFileLock(lockPath, { timeoutMs: 200 });
    await next.release();
  }, 30_000);

  test('legacy or partial lock files are reported, never silently deleted (#185)', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'state.json.lock');
    await writeFile(lockPath, 'legacy lock from an older writer');
    let legacyError: unknown;
    try {
      await acquireFileLock(lockPath, { timeoutMs: 50 });
    } catch (error) {
      legacyError = error;
    }
    expect(legacyError).toBeInstanceOf(InvalidLockError);
    expect(legacyError instanceof Error ? legacyError.message : '').toContain('remove this lock');
    expect(await readFile(lockPath, 'utf8')).toBe('legacy lock from an older writer');

    await writeFile(lockPath, '');
    let partialError: unknown;
    try {
      await acquireFileLock(lockPath, { timeoutMs: 50 });
    } catch (error) {
      partialError = error;
    }
    expect(partialError).toBeInstanceOf(InvalidLockError);
    expect((await stat(lockPath)).size).toBe(0);
  }, 30_000);
});

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'failures leave state intact (#185)',
  () => {
    test('a read-only state directory surfaces an error and keeps the previous file', async () => {
      const { chmod, mkdir } = await import('node:fs/promises');
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
    const { mkdir, writeFile: writeBallast } = await import('node:fs/promises');
    const dir = join(tinyDir ?? '', `case-${Date.now()}`);
    dirs.push(dir);
    await mkdir(dir);
    const path = join(dir, 'state.json');
    await saveState(path, { ...emptyState, history: { '/p': ['kept'] } });
    await writeBallast(join(dir, 'ballast'), Buffer.alloc(200 * 1024)).catch(() => undefined);
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
