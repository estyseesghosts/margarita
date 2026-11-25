import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isRecord } from '../domain/backend-event.ts';
import template from './config.template.jsonc' with { type: 'text' };

/** The annotated template planted on first launch. Embedded in the compiled binary. */
export const CONFIG_TEMPLATE: string = template;

/**
 * Plants the template at `path` if no config exists there. `wx` guarantees an existing file
 * (even an empty one) is never overwritten, including when two launches race. A failure is
 * reported as a warning so startup can continue with defaults.
 */
export async function ensureConfigTemplate(path: string): Promise<string | undefined> {
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (cause: unknown) {
    return `Could not create ${dirname(path)}: ${String(cause)}`;
  }
  try {
    await writeFile(path, CONFIG_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
  } catch (cause: unknown) {
    if (isRecord(cause) && cause['code'] === 'EEXIST') return undefined;
    return `Could not create ${path}: ${String(cause)}`;
  }
  return undefined;
}
