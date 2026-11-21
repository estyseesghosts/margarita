import { describe, expect, test } from 'bun:test';

import type { CatalogModel } from './model-resolution.ts';
import { sortModelCatalogForPicker } from './model-sort.ts';

const model = (providerID: string, modelID: string, name = modelID): CatalogModel => ({
  providerID,
  modelID,
  name,
  enabled: true,
  variants: [],
});

const ids = (models: readonly CatalogModel[]) =>
  models.map((entry) => `${entry.providerID}/${entry.modelID}`);

describe('sortModelCatalogForPicker (#166)', () => {
  test('groups providers alphabetically and keeps their identity on each row', () => {
    const sorted = sortModelCatalogForPicker([
      model('zebra', 'z'),
      model('anthropic', 'claude-5.5-opus'),
      model('alpha', 'b'),
      model('alpha', 'a'),
    ]);
    expect(ids(sorted)).toEqual(['alpha/a', 'alpha/b', 'anthropic/claude-5.5-opus', 'zebra/z']);
  });

  test('generic routers stay alphabetical even with vendor-like model IDs', () => {
    const sorted = sortModelCatalogForPicker([
      model('opencode', 'minimax-m3.1-flash'),
      model('opencode', 'gpt-6.1-terra'),
      model('opencode', 'deepseek-4.1'),
    ]);
    expect(ids(sorted)).toEqual([
      'opencode/deepseek-4.1',
      'opencode/gpt-6.1-terra',
      'opencode/minimax-m3.1-flash',
    ]);
    const official = sortModelCatalogForPicker([
      model('commandcode', 'gpt-6.2-astra'),
      model('commandcode', 'gpt-6.1-sol'),
    ]);
    expect(ids(official)).toEqual(['commandcode/gpt-6.1-sol', 'commandcode/gpt-6.2-astra']);
  });

  test('official OpenAI/Codex: newest release first, then Astra > Sol > Terra > Luna', () => {
    const sorted = sortModelCatalogForPicker([
      model('openai', 'gpt-6.1-luna'),
      model('openai', 'gpt-6.2-terra'),
      model('openai', 'gpt-6.2-astra'),
      model('openai', 'gpt-6.9-sol'),
      model('openai', 'gpt-6.10-sol'),
      model('openai', 'gpt-6.2-sol'),
      model('openai', 'gpt-6.2-luna'),
    ]);
    expect(ids(sorted)).toEqual([
      'openai/gpt-6.10-sol',
      'openai/gpt-6.9-sol',
      'openai/gpt-6.2-astra',
      'openai/gpt-6.2-sol',
      'openai/gpt-6.2-terra',
      'openai/gpt-6.2-luna',
      'openai/gpt-6.1-luna',
    ]);
  });

  test('Codex subscription provider gets the same tier rules, kept as its own group', () => {
    const sorted = sortModelCatalogForPicker([
      model('openai', 'gpt-6.2-sol'),
      model('codex', 'gpt-6.2-astra'),
      model('codex', 'gpt-6.2-luna'),
    ]);
    expect(ids(sorted)).toEqual([
      'codex/gpt-6.2-astra',
      'codex/gpt-6.2-luna',
      'openai/gpt-6.2-sol',
    ]);
  });

  test('official Anthropic: newer release first, then Mythos > Fable > Opus > Sonnet > Haiku', () => {
    const sorted = sortModelCatalogForPicker([
      model('anthropic', 'claude-5.5-haiku'),
      model('anthropic', 'claude-5.4-opus'),
      model('anthropic', 'claude-5.5-sonnet'),
      model('anthropic', 'claude-5.5-opus'),
      model('anthropic', 'claude-5.5-fable'),
      model('anthropic', 'claude-5.5-mythos'),
    ]);
    expect(ids(sorted)).toEqual([
      'anthropic/claude-5.5-mythos',
      'anthropic/claude-5.5-fable',
      'anthropic/claude-5.5-opus',
      'anthropic/claude-5.5-sonnet',
      'anthropic/claude-5.5-haiku',
      'anthropic/claude-5.4-opus',
    ]);
  });

  test('unknown tiers and undated IDs fall back after recognized entries', () => {
    const sorted = sortModelCatalogForPicker([
      model('openai', 'gpt-experimental'),
      model('openai', 'gpt-6.2-unknown'),
      model('openai', 'gpt-6.2-astra'),
    ]);
    expect(ids(sorted)).toEqual([
      'openai/gpt-6.2-astra',
      'openai/gpt-6.2-unknown',
      'openai/gpt-experimental',
    ]);
  });

  test('dated revisions sort newest first within the same release and tier', () => {
    const sorted = sortModelCatalogForPicker([
      model('openai', 'gpt-6.2-astra-20260101'),
      model('openai', 'gpt-6.2-astra-20260102'),
    ]);
    expect(ids(sorted)).toEqual(['openai/gpt-6.2-astra-20260102', 'openai/gpt-6.2-astra-20260101']);
  });

  test('stable across catalog refresh and filtering does not reorder survivors', () => {
    const catalog = [
      model('openai', 'gpt-6.2-astra'),
      model('openai', 'gpt-6.1-sol'),
      model('zebra', 'z'),
      model('alpha', 'a'),
    ];
    const first = sortModelCatalogForPicker(catalog);
    expect(sortModelCatalogForPicker(catalog.toReversed())).toEqual(first);
    expect(sortModelCatalogForPicker(structuredClone(catalog))).toEqual(first);
    const filtered = first.filter((entry) => entry.providerID === 'openai');
    expect(sortModelCatalogForPicker(filtered)).toEqual(filtered);
  });
});
