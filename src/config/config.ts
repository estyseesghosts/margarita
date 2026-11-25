import { readFile } from 'node:fs/promises';

import { isRecord } from '../domain/backend-event.ts';
import type { KeyOverride } from '../domain/keymap.ts';
import { parseModelRef } from '../domain/model-ref.ts';

export const themeNames = ['dark', 'light', 'high-contrast'] as const;
export type ThemeName = (typeof themeNames)[number];

export const routeNames = ['new', 'overview'] as const;
export type RouteName = (typeof routeNames)[number];

export const sortNames = ['activity', 'name'] as const;
export type SortName = (typeof sortNames)[number];

export const groupNames = ['project', 'server'] as const;
export type GroupName = (typeof groupNames)[number];

export const reasoningNames = ['hidden', 'details-only', 'always'] as const;
export type ReasoningName = (typeof reasoningNames)[number];

export const toolGroupNames = ['compact', 'none'] as const;
export type ToolGroupName = (typeof toolGroupNames)[number];

/** Footer fields a user may choose; `separator` is layout, never configurable. */
export const footerNames = [
  'agent',
  'model',
  'state',
  'queued',
  'goal',
  'context',
  'tokens',
  'cost',
] as const;
export type FooterName = (typeof footerNames)[number];

export type AppConfig = Readonly<{
  agents: Readonly<{ default: string; cycle: readonly string[] }>;
  sessions: Readonly<{
    showArchived: boolean;
    showChildren: boolean;
    sortBy: SortName;
    groupBy: GroupName;
  }>;
  input: Readonly<{ enterWhileRunning: 'queue' | 'steer' }>;
  models: Readonly<{ recentLimit: number; default?: string }>;
  history: Readonly<{ limit: number }>;
  transcript: Readonly<{
    toolOutputChars: number;
    detailed: boolean;
    reasoning: ReasoningName;
    previewRows: number;
    groupTools: ToolGroupName;
  }>;
  clipboard: Readonly<{ autoCopy: boolean; rightClickCopy: boolean; rightClickPaste: boolean }>;
  keys: Readonly<Record<string, KeyOverride>>;
  /** Paired-server shortnames only; secrets never live in this file. */
  servers: Readonly<{ launch: string; connect?: readonly string[] }>;
  debugLog?: string;
  ui: Readonly<{
    theme: ThemeName;
    animation: boolean;
    ascii: boolean;
    accent?: string;
    accentLight?: string;
    caret?: string;
    defaultRoute: RouteName;
    footer: readonly FooterName[];
    reducedMotion: boolean;
  }>;
}>;

export const defaultConfig: AppConfig = {
  agents: { default: 'build', cycle: ['build', 'plan'] },
  sessions: { showArchived: false, showChildren: false, sortBy: 'activity', groupBy: 'project' },
  input: { enterWhileRunning: 'queue' },
  models: { recentLimit: 8 },
  history: { limit: 200 },
  transcript: {
    toolOutputChars: 64_000,
    detailed: false,
    reasoning: 'details-only',
    previewRows: 12,
    groupTools: 'compact',
  },
  clipboard: { autoCopy: true, rightClickCopy: true, rightClickPaste: true },
  keys: {},
  servers: { launch: 'local' },
  ui: {
    theme: 'dark',
    animation: true,
    ascii: false,
    defaultRoute: 'new',
    footer: [...footerNames],
    reducedMotion: false,
  },
};

export type ConfigLoad = Readonly<{ config: AppConfig; warnings: readonly string[] }>;

function isOneOf<T extends string>(value: unknown, names: readonly T[]): value is T {
  return typeof value === 'string' && names.some((name) => name === value);
}

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

function toolOutputCap(value: unknown, path: string, fallback: number, warnings: string[]): number {
  if (value === undefined) return fallback;
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1_000 &&
    value <= 1_000_000
  ) {
    return value;
  }
  warnings.push(`${path} must be an integer between 1000 and 1000000`);
  return fallback;
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
    'transcript',
    'clipboard',
    'keys',
    'servers',
    'debugLog',
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
  const transcript = section('transcript');
  const clipboard = section('clipboard');
  const keysRaw = section('keys');
  const servers = section('servers');
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
  const hex = (value: unknown, path: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value;
    warnings.push(`${path} must be a #rrggbb colour`);
    return undefined;
  };
  const oneOf = <T extends string>(
    value: unknown,
    path: string,
    names: readonly T[],
    fallback: T,
  ): T => {
    if (value === undefined) return fallback;
    if (isOneOf(value, names)) return value;
    warnings.push(`${path} must be one of ${names.join(', ')}`);
    return fallback;
  };
  const stringList = (
    value: unknown,
    path: string,
    allowed?: readonly string[],
  ): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      warnings.push(`${path} must be an array of strings`);
      return undefined;
    }
    const result: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string' || entry === '') {
        warnings.push(`${path} must contain only non-empty strings`);
        continue;
      }
      if (allowed !== undefined && !allowed.includes(entry)) {
        warnings.push(`${path} has unknown entry "${entry}"`);
        continue;
      }
      if (!result.includes(entry)) result.push(entry);
    }
    return result;
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

  const keys: Record<string, KeyOverride> = {};
  for (const [action, binding] of Object.entries(keysRaw)) {
    if (typeof binding === 'string' && binding !== '') keys[action] = binding;
    else if (
      Array.isArray(binding) &&
      binding.length > 0 &&
      binding.every((entry) => typeof entry === 'string' && entry !== '')
    )
      keys[action] = binding;
    else warnings.push(`keys.${action} must be a single key or an array of keys`);
  }

  const accent = hex(ui['accent'], 'ui.accent');
  const accentLight = hex(ui['accentLight'], 'ui.accentLight');
  const caret = hex(ui['caret'], 'ui.caret');
  const footer = stringList(ui['footer'], 'ui.footer', footerNames);
  const connect = stringList(servers['connect'], 'servers.connect');
  if (connect !== undefined && connect.length === 0) {
    warnings.push('servers.connect must not be empty; using all paired servers');
  }
  let defaultModel: string | undefined;
  const modelRaw = models['default'];
  if (modelRaw !== undefined) {
    if (
      typeof modelRaw === 'string' &&
      /^\S+$/.test(modelRaw) &&
      parseModelRef(modelRaw) !== undefined
    )
      defaultModel = modelRaw.trim();
    else warnings.push('models.default must be model or provider/model[#variant]');
  }
  let debugLog: string | undefined;
  const debugRaw = raw['debugLog'];
  if (typeof debugRaw === 'string' && debugRaw !== '') debugLog = debugRaw;
  else if (debugRaw !== undefined) warnings.push('debugLog must be a non-empty path');

  return {
    config: {
      agents: {
        default: string(agents['default'], 'agents.default', defaultConfig.agents.default),
        cycle,
      },
      sessions: {
        showArchived: bool(sessions['showArchived'], 'sessions.showArchived', false),
        showChildren: bool(sessions['showChildren'], 'sessions.showChildren', false),
        sortBy: oneOf(sessions['sortBy'], 'sessions.sortBy', sortNames, 'activity'),
        groupBy: oneOf(sessions['groupBy'], 'sessions.groupBy', groupNames, 'project'),
      },
      input: { enterWhileRunning },
      models: {
        recentLimit: count(
          models['recentLimit'],
          'models.recentLimit',
          defaultConfig.models.recentLimit,
        ),
        ...(defaultModel === undefined ? {} : { default: defaultModel }),
      },
      history: { limit: count(history['limit'], 'history.limit', defaultConfig.history.limit) },
      transcript: {
        toolOutputChars: toolOutputCap(
          transcript['toolOutputChars'],
          'transcript.toolOutputChars',
          defaultConfig.transcript.toolOutputChars,
          warnings,
        ),
        detailed: bool(transcript['detailed'], 'transcript.detailed', false),
        reasoning: oneOf(
          transcript['reasoning'],
          'transcript.reasoning',
          reasoningNames,
          'details-only',
        ),
        previewRows: count(
          transcript['previewRows'],
          'transcript.previewRows',
          defaultConfig.transcript.previewRows,
        ),
        groupTools: oneOf(
          transcript['groupTools'],
          'transcript.groupTools',
          toolGroupNames,
          'compact',
        ),
      },
      clipboard: {
        autoCopy: bool(clipboard['autoCopy'], 'clipboard.autoCopy', true),
        rightClickCopy: bool(clipboard['rightClickCopy'], 'clipboard.rightClickCopy', true),
        rightClickPaste: bool(clipboard['rightClickPaste'], 'clipboard.rightClickPaste', true),
      },
      keys,
      servers: {
        launch: string(servers['launch'], 'servers.launch', 'local'),
        ...(connect === undefined || connect.length === 0 ? {} : { connect }),
      },
      ...(debugLog === undefined ? {} : { debugLog }),
      ui: {
        theme: oneOf(ui['theme'], 'ui.theme', themeNames, 'dark'),
        animation: bool(ui['animation'], 'ui.animation', defaultConfig.ui.animation),
        ascii: bool(ui['ascii'], 'ui.ascii', defaultConfig.ui.ascii),
        ...(accent === undefined ? {} : { accent }),
        ...(accentLight === undefined ? {} : { accentLight }),
        ...(caret === undefined ? {} : { caret }),
        defaultRoute: oneOf(ui['defaultRoute'], 'ui.defaultRoute', routeNames, 'new'),
        footer:
          footer === undefined
            ? defaultConfig.ui.footer
            : footer.filter((entry): entry is FooterName =>
                footerNames.some((name) => name === entry),
              ),
        reducedMotion: bool(ui['reducedMotion'], 'ui.reducedMotion', false),
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
    } else if (char === ',') {
      // Drop a trailing comma only when the next significant character outside
      // a string closes an object or array.
      let ahead = index + 1;
      while (ahead < text.length) {
        const peek = text[ahead] ?? '';
        if (/\s/.test(peek)) {
          ahead += 1;
          continue;
        }
        // Skip comments that may sit between the comma and the closing bracket.
        if (peek === '/' && text[ahead + 1] === '/') {
          while (ahead < text.length && text[ahead] !== '\n') ahead += 1;
          continue;
        }
        if (peek === '/' && text[ahead + 1] === '*') {
          const end = text.indexOf('*/', ahead + 2);
          ahead = end === -1 ? text.length : end + 2;
          continue;
        }
        break;
      }
      const closer = text[ahead];
      if (closer === '}' || closer === ']') {
        index += 1; // skip the comma, keep the whitespace that follows
      } else {
        out += char;
        index += 1;
      }
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
  return out;
}
