import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CredentialStore } from './credentials.ts';
import {
  enqueueCredentialCleanup,
  PendingQueueError,
  reconcileCredentialCleanup,
} from './unpair-recovery.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'marg-unpair-'));
  dirs.push(dir);
  return dir;
}

function store(failing: readonly string[] = []): CredentialStore & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    kind: 'memory',
    description: 'test store',
    deleted,
    get: async () => undefined,
    set: async () => {},
    delete: async (id: string) => {
      if (failing.includes(id)) throw new Error('keyring locked');
      deleted.push(id);
    },
  };
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (cause) {
    return cause;
  }
  return undefined;
}

describe('pending unpair queue (#200)', () => {
  test('a missing queue is empty and enqueue creates it', async () => {
    const dir = await stateDir();
    expect(await reconcileCredentialCleanup(dir, store())).toEqual({ cleared: 0, remaining: [] });
    await enqueueCredentialCleanup(dir, 'srv_1');
    await enqueueCredentialCleanup(dir, 'srv_1');
    expect(JSON.parse(await readFile(join(dir, 'pending-unpair.json'), 'utf8'))).toEqual({
      serverIDs: ['srv_1'],
    });
  });

  const bad: ReadonlyArray<[string, string]> = [
    ['truncated JSON', '{"serverIDs": ["srv_1"'],
    ['missing serverIDs', '{"other": 1}'],
    ['a string instead of the array', '{"serverIDs": "srv_1"}'],
    ['invalid entries', '{"serverIDs": ["srv_1", 7]}'],
    ['an empty ID', '{"serverIDs": ["srv_1", ""]}'],
    ['a bare array', '["srv_1"]'],
  ];

  for (const [label, content] of bad) {
    test(`never overwrites or ignores a queue with ${label}`, async () => {
      const dir = await stateDir();
      const path = join(dir, 'pending-unpair.json');
      await writeFile(path, content);
      const credentials = store();
      expect(await failure(() => enqueueCredentialCleanup(dir, 'srv_2'))).toBeInstanceOf(
        PendingQueueError,
      );
      expect(await failure(() => reconcileCredentialCleanup(dir, credentials))).toBeInstanceOf(
        PendingQueueError,
      );
      expect(await readFile(path, 'utf8')).toBe(content);
      expect(credentials.deleted).toEqual([]);
    });
  }

  test('the error is non-secret and names the path', async () => {
    const dir = await stateDir();
    await writeFile(join(dir, 'pending-unpair.json'), '{"serverIDs": ["srv_secretish"');
    const error = await enqueueCredentialCleanup(dir, 'srv_2').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PendingQueueError);
    expect(String(error)).toContain('pending-unpair.json');
    expect(String(error)).not.toContain('srv_secretish');
  });

  test('an unreadable queue fails closed instead of reading as empty', async () => {
    const dir = await stateDir();
    // A directory in place of the file makes readFile fail with EISDIR on every platform.
    await Bun.write(join(dir, 'pending-unpair.json', 'x'), '');
    expect(await failure(() => reconcileCredentialCleanup(dir, store()))).toBeInstanceOf(
      PendingQueueError,
    );
    await chmod(dir, 0o700).catch(() => {});
  });

  test('failed deletions stay queued, successes are cleared, duplicates collapse', async () => {
    const dir = await stateDir();
    await writeFile(join(dir, 'pending-unpair.json'), '{"serverIDs": ["srv_a", "srv_b", "srv_a"]}');
    const credentials = store(['srv_b']);
    expect(await reconcileCredentialCleanup(dir, credentials)).toEqual({
      cleared: 1,
      remaining: ['srv_b'],
    });
    expect(credentials.deleted).toEqual(['srv_a']);
    expect(JSON.parse(await readFile(join(dir, 'pending-unpair.json'), 'utf8'))).toEqual({
      serverIDs: ['srv_b'],
    });
  });
});
