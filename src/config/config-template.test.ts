import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_TEMPLATE, ensureConfigTemplate } from './config-template.ts';
import { defaultConfig, loadConfig } from './config.ts';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'margarita-template-'));
  temps.push(dir);
  return dir;
}

describe('config template', () => {
  test('plants an annotated template that parses to the defaults', async () => {
    const path = join(await tempDir(), 'margarita', 'config.jsonc');
    expect(await ensureConfigTemplate(path)).toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe(CONFIG_TEMPLATE);
    expect(await loadConfig(path)).toEqual({ config: defaultConfig, warnings: [] });
  });

  test('never overwrites an existing file, even an empty one', async () => {
    const empty = join(await tempDir(), 'config.jsonc');
    await writeFile(empty, '');
    expect(await ensureConfigTemplate(empty)).toBeUndefined();
    expect(await readFile(empty, 'utf8')).toBe('');

    const custom = join(await tempDir(), 'custom.jsonc');
    const original = '{"ui":{"theme":"light"}}\n';
    await writeFile(custom, original);
    expect(await ensureConfigTemplate(custom)).toBeUndefined();
    expect(await readFile(custom, 'utf8')).toBe(original);
  });

  test('two concurrent launches plant the file once', async () => {
    const path = join(await tempDir(), 'nested', 'config.jsonc');
    expect(await Promise.all([ensureConfigTemplate(path), ensureConfigTemplate(path)])).toEqual([
      undefined,
      undefined,
    ]);
    expect(await readFile(path, 'utf8')).toBe(CONFIG_TEMPLATE);
  });

  test('a blocked path warns instead of throwing', async () => {
    const blocker = join(await tempDir(), 'blocker');
    await writeFile(blocker, 'not a directory');
    const warning = await ensureConfigTemplate(join(blocker, 'config.jsonc'));
    expect(warning).toContain('Could not create');
  });
});
