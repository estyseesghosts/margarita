/**
 * Version negotiation for Margarita's own JSON state files. An older binary must never
 * silently turn a newer-schema file into empty version-1 defaults and then overwrite it (#150).
 */

import { isRecord } from '../domain/backend-event.ts';

/** The only schema version this build can read *and* write. */
export const supportedSchemaVersion = 1 as const;

export type IncompatibleDetail = Readonly<{
  path: string;
  version: unknown;
  supported: typeof supportedSchemaVersion;
}>;

/** The on-disk file uses a schema this build cannot safely write. */
export class IncompatibleSchemaError extends Error {
  constructor(readonly detail: IncompatibleDetail) {
    super(
      `${detail.path} uses schema version ${String(detail.version)}, but this build supports ` +
        `only ${detail.supported}. The file was left unchanged; upgrade Margarita before writing to it.`,
    );
    this.name = 'IncompatibleSchemaError';
  }
}

/** A parsed document declares a version this build cannot write. */
export function isIncompatibleVersion(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const version = raw['schemaVersion'] ?? supportedSchemaVersion;
  return version !== supportedSchemaVersion;
}

/** The declared version of a parsed document, for diagnostics. */
export function declaredVersion(raw: unknown): unknown {
  if (!isRecord(raw)) return undefined;
  return raw['schemaVersion'] ?? supportedSchemaVersion;
}
