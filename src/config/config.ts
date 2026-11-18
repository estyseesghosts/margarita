import { readFile } from 'node:fs/promises';

import { isRecord } from '../domain/backend-event.ts';

export type AppConfig = Readonly<{
  agents: Readonly<{ default: string; cycle: readonly string[] }>;
  sessions: Readonly<{ showArchived: boolean; showChildren: boolean }>;
  input: Readonly<{ enterWhileRunning: 'queue' | 'steer' }>;
  models: Readonly<{ recentLimit: number }>;
  history: Readonly<{ limit: number }>;
  keys: Readonly<Record<string, string>>;
  ui: Readonly<{ theme: ThemeName; animation: boolean; ascii: boolean }>;
}>;

export const themeNames = ['dark', 'light', 'high-contrast'] as const;
export type ThemeName = (typeof themeNames)[number];

export const defaultConfig: AppConfig = {
  agents: { default: 'build', cycle: ['build', 'plan'] },
  sessions: { showArchived: false, showChildren: false },
  input: { enterWhileRunning: 'queue' },
  models: { recentLimit: 8 },
  history: { limit: 200 },
  keys: {},
  ui: { theme: 'dark', animation: true, ascii: false },
};

export type ConfigLoad = Readonly<{ config: AppConfig; warnings: readonly string[] }>;

/** Loads config; a missing file is fine, invalid content falls back per field with warnings. */
export async function loadConfig(path: string): Promise<ConfigLoad> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (isRecord(cause) && cause['code'] === 'ENOENT')
      return { config: defaultConfig, warnings: [] };
    return { config: defaultConfig, warnings: [`Could not read ${path}: ${String(cause)}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(text));
  } catch (cause) {
    return { config: defaultConfig, warnings: [`${path} is not valid JSONC: ${String(cause)}`] };
  }
  return parseConfig(raw);
}

export function parseConfig(raw: unknown): ConfigLoad {
  const warnings: string[] = [];
  if (!isRecord(raw)) return { config: defaultConfig, warnings: ['config root must be an object'] };
  const known = new Set([
    '$schema',
    'schemaVersion',
    'agents',
    'sessions',
    'input',
    'models',
    'history',
    'keys',
    'ui',
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) warnings.push(`unknown config key "${key}" ignored`);
  }
  const section = (name: string): Record<string, unknown> => {
    const value = raw[name];
    if (value === undefined) return {};
    if (isRecord(value)) return value;
    warnings.push(`"${name}" must be an object`);
    return {};
  };
  const agents = section('agents');
  const sessions = section('sessions');
  const input = section('input');
  const models = section('models');
  const history = section('history');
  const keysRaw = section('keys');
  const ui = section('ui');

  const string = (value: unknown, path: string, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value === 'string' && value !== '') return value;
    warnings.push(`${path} must be a non-empty string`);
    return fallback;
  };
  const bool = (value: unknown, path: string, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    warnings.push(`${path} must be a boolean`);
    return fallback;
  };
  const count = (value: unknown, path: string, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 10_000)
      return value;
    warnings.push(`${path} must be a positive integer`);
    return fallback;
  };

  let cycle = defaultConfig.agents.cycle;
  if (agents['cycle'] !== undefined) {
    if (
      Array.isArray(agents['cycle']) &&
      agents['cycle'].every((entry) => typeof entry === 'string')
    ) {
      cycle = agents['cycle'];
    } else {
      warnings.push('agents.cycle must be an array of agent IDs');
    }
  }
  let enterWhileRunning = defaultConfig.input.enterWhileRunning;
  const enter = input['enterWhileRunning'];
  if (enter === 'queue' || enter === 'steer') enterWhileRunning = enter;
  else if (enter !== undefined) warnings.push('input.enterWhileRunning must be "queue" or "steer"');

  let theme = defaultConfig.ui.theme;
  const themeRaw = ui['theme'];
  const matched = themeNames.find((name) => name === themeRaw);
  if (matched !== undefined) theme = matched;
  else if (themeRaw !== undefined)
    warnings.push(`ui.theme must be one of ${themeNames.join(', ')}`);

  const keys: Record<string, string> = {};
  for (const [action, binding] of Object.entries(keysRaw)) {
    if (typeof binding === 'string') keys[action] = binding;
    else warnings.push(`keys.${action} must be a string`);
  }

  return {
    config: {
      agents: {
        default: string(agents['default'], 'agents.default', defaultConfig.agents.default),
        cycle,
      },
      sessions: {
        showArchived: bool(sessions['showArchived'], 'sessions.showArchived', false),
        showChildren: bool(sessions['showChildren'], 'sessions.showChildren', false),
      },
      input: { enterWhileRunning },
      models: {
        recentLimit: count(
          models['recentLimit'],
          'models.recentLimit',
          defaultConfig.models.recentLimit,
        ),
      },
      history: { limit: count(history['limit'], 'history.limit', defaultConfig.history.limit) },
      keys,
      ui: {
        theme,
        animation: bool(ui['animation'], 'ui.animation', defaultConfig.ui.animation),
        ascii: bool(ui['ascii'], 'ui.ascii', defaultConfig.ui.ascii),
      },
    },
    warnings,
  };
}

/** Removes `//` and block comments plus trailing commas, leaving string contents intact. */
export function stripJsonComments(text: string): string {
  let out = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next;
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
