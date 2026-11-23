/**
 * Shared error formatting and job-refresh outcome handling (#316).
 *
 * A job RPC has exactly two outcomes that matter to presentation: a confirmed
 * list, or a failure that preserves the last rows with a bounded, paint-safe
 * diagnostic. Keeping the formatter here gives controllers and the CLI one
 * source of truth for error text.
 */
import { sanitizeTerminalText } from '../domain/sanitize-text.ts';

/** Human-readable text for any thrown value; never throws or returns terminal escapes raw. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** One bounded, paint-safe diagnostic for a failed job refresh (#230). */
function jobRefreshDetail(error: unknown): string {
  const text = sanitizeTerminalText(errorText(error)).replace(/\s+/g, ' ').trim();
  if (text === '') return 'job refresh failed';
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** A job RPC's two real outcomes: a confirmed list, or a failure with a safe detail. */
export type RefreshOutcome<T> = { ok: true; jobs: readonly T[] } | { ok: false; detail: string };

/** Runs a job RPC and normalizes its result without leaking raw error text. */
export async function refreshOutcome<T>(
  request: () => Promise<readonly T[]>,
): Promise<RefreshOutcome<T>> {
  try {
    return { ok: true, jobs: await request() };
  } catch (error) {
    return { ok: false, detail: jobRefreshDetail(error) };
  }
}
