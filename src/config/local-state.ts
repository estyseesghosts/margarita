import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isRecord } from '../domain/backend-event.ts';
import type { ModelSelection } from '../domain/model-ref.ts';

/** Frontend-only presentation state. Session history is never stored here. */
export type LocalState = Readonly<{
  schemaVersion: 1;
  /** Prompt history keyed by canonical project directory key. */
  history: Readonly<Record<string, readonly string[]>>;
  recentModels: readonly ModelSelection[];
}>;

export const emptyState: LocalState = { schemaVersion: 1, history: {}, recentModels: [] };

export async function loadState(path: string): Promise<{ state: LocalState; warning?: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (isRecord(cause) && cause['code'] === 'ENOENT') return { state: emptyState };
    return { state: emptyState, warning: `Could not read local state: ${String(cause)}` };
  }
  try {
    return { state: parseState(JSON.parse(text)) };
  } catch (cause) {
    return {
      state: emptyState,
      warning: `Local state was unreadable and was reset: ${String(cause)}`,
    };
  }
}

export function parseState(raw: unknown): LocalState {
  if (!isRecord(raw) || raw['schemaVersion'] !== 1) return emptyState;
  const history: Record<string, string[]> = {};
  if (isRecord(raw['history'])) {
    for (const [key, entries] of Object.entries(raw['history'])) {
      if (Array.isArray(entries))
        history[key] = entries.filter((entry) => typeof entry === 'string');
    }
  }
  const recentModels: ModelSelection[] = [];
  if (Array.isArray(raw['recentModels'])) {
    for (const entry of raw['recentModels']) {
      if (!isRecord(entry)) continue;
      const { providerID, modelID, variant } = entry;
      if (typeof providerID !== 'string' || typeof modelID !== 'string') continue;
      recentModels.push({
        providerID,
        modelID,
        ...(typeof variant === 'string' ? { variant } : {}),
      });
    }
  }
  return { schemaVersion: 1, history, recentModels };
}

/** Atomic save: write a temp file next to the target, then rename over it. */
export async function saveState(path: string, state: LocalState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}
