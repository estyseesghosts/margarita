import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    expect(result.files).toContain('real.ts');
  });

  test('the entry bound and an injected clock both terminate the scan', async () => {
    const root = await tree();
    for (let index = 0; index < 40; index += 1) await mkdir(join(root, `d${index}`));
    expect((await scanProjectFiles(root, { entries: 10 })).truncated).toBe('entries');
    let tick = 0;
    const result = await scanProjectFiles(root, { timeMs: 3, now: () => (tick += 1) });
    expect(result.truncated).toBe('time');
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
