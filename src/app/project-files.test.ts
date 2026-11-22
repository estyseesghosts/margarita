import { afterEach, describe, expect, test } from 'bun:test';
import type { Dirent } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listProjectFiles, scanProjectFiles } from './project-files.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'marg-files-'));
  roots.push(root);
  return root;
}

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('bounded project file discovery (#204)', () => {
  test('an ordinary tree is listed completely with relative POSIX paths', async () => {
    const root = await tree();
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'a.md'), '');
    await writeFile(join(root, 'src', 'b.ts'), '');
    await writeFile(join(root, 'node_modules', 'skip.js'), '');
    const result = await scanProjectFiles(root);
    expect(result.files.toSorted()).toEqual(['a.md', 'src/b.ts']);
    expect(result.truncated).toBeUndefined();
    expect(result.incomplete).toBe(false);
    expect(result.unreadable).toEqual({ count: 0, samples: [] });
  });

  test('the file-count cap still works', async () => {
    const root = await tree();
    for (let index = 0; index < 20; index += 1) await writeFile(join(root, `f${index}.txt`), '');
    expect((await scanProjectFiles(root, { files: 5 })).truncated).toBe('files');
    expect(await listProjectFiles(root, 5)).toHaveLength(5);
  });

  test('a wide tree of empty directories stops at the directory bound', async () => {
    const root = await tree();
    for (let index = 0; index < 300; index += 1) await mkdir(join(root, `d${index}`));
    await writeFile(join(root, 'real.ts'), '');
    const result = await scanProjectFiles(root, { directories: 50 });
    expect(result.truncated).toBe('directories');
    expect(result.directoriesVisited).toBe(50);
    expect(result.incomplete).toBe(true);
    expect(result.files).toContain('real.ts');
  });

  test('the entry bound and an injected clock both terminate the scan', async () => {
    const root = await tree();
    for (let index = 0; index < 40; index += 1) await mkdir(join(root, `d${index}`));
    expect((await scanProjectFiles(root, { entries: 10 })).truncated).toBe('entries');
    let tick = 0;
    const result = await scanProjectFiles(root, { timeMs: 3, now: () => (tick += 1) });
    expect(result.truncated).toBe('time');
    expect(result.incomplete).toBe(true);
  });

  test('a cancelled scan reports aborted and never lists the whole tree', async () => {
    const root = await tree();
    await mkdir(join(root, 'd'));
    await writeFile(join(root, 'd', 'x.ts'), '');
    const controller = new AbortController();
    controller.abort();
    const result = await scanProjectFiles(root, { signal: controller.signal });
    expect(result.truncated).toBe('aborted');
    expect(result.files).toEqual([]);
  });
});

describe('unreadable directories are reported, not treated as empty (#279)', () => {
  test('a denied nested subtree keeps readable files and reports a redacted sample', async () => {
    const root = await tree();
    await mkdir(join(root, 'blocked'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'root.md'), '');
    await writeFile(join(root, 'src', 'good.ts'), '');
    await writeFile(join(root, 'blocked', 'secret.ts'), '');
    const result = await scanProjectFiles(root, {
      readdir: async (path, options) => {
        if (path.endsWith('blocked')) throw fsError('EACCES');
        return readdir(path, options) as Promise<Dirent[]>;
      },
    });
    expect(result.files.toSorted()).toEqual(['root.md', 'src/good.ts']);
    expect(result.truncated).toBeUndefined();
    expect(result.incomplete).toBe(true);
    expect(result.unreadable).toEqual({
      count: 1,
      samples: [{ path: 'blocked', code: 'EACCES' }],
    });
  });

  test('sample paths stay root-relative and the list is capped', async () => {
    const root = await tree();
    for (let index = 0; index < 6; index += 1) await mkdir(join(root, `denied${index}`));
    const result = await scanProjectFiles(root, {
      readdir: async (path, options) => {
        if (path !== root) throw fsError('EPERM');
        return readdir(path, options) as Promise<Dirent[]>;
      },
    });
    expect(result.unreadable.count).toBe(6);
    expect(result.unreadable.samples).toHaveLength(3);
    expect(result.unreadable.samples[0]).toEqual({ path: 'denied0', code: 'EPERM' });
    expect(result.incomplete).toBe(true);
  });

  test('a stalled read is abandoned at the deadline and cannot mutate the returned result', async () => {
    const root = await tree();
    await writeFile(join(root, 'late.ts'), '');
    const entries = (await readdir(root, { withFileTypes: true })) as Dirent[];
    const result = await scanProjectFiles(root, {
      timeMs: 5,
      readdir: () => new Promise<Dirent[]>((resolve) => setTimeout(() => resolve(entries), 40)),
    });
    expect(result.truncated).toBe('time');
    expect(result.files).toEqual([]);
    expect(result.incomplete).toBe(true);
    await Bun.sleep(70);
    expect(result.files).toEqual([]);
  });

  test('cancellation interrupts a stalled read before the deadline', async () => {
    const root = await tree();
    const controller = new AbortController();
    const scan = scanProjectFiles(root, {
      timeMs: 5_000,
      signal: controller.signal,
      readdir: () => new Promise<Dirent[]>(() => {}),
    });
    controller.abort();
    expect((await scan).truncated).toBe('aborted');
  });
});
