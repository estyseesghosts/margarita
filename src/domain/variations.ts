import type { Variations } from '../i18n/types.ts';

/**
 * How long one wording stays on screen before the next pool entry may be shown. Variety is
 * meant to be noticed over minutes, never per frame: a running turn must not flicker between
 * different words while you watch it.
 */
export const variationPeriodMs = 180_000;

/**
 * Resolve a catalog field that is either one wording or a pool of equivalent wordings.
 *
 * A plain string is returned verbatim, so existing single-wording entries keep working. For
 * a pool, the step advances once per `periodMs` of the supplied clock, so the visible wording
 * is stable while you watch and only changes after a few minutes. `seed` spreads different
 * turns across the pool without making any one turn flicker; the same seed and clock always
 * resolve to the same wording.
 */
export function resolveVariation(
  value: Variations | undefined,
  nowMs: number,
  seed = 0,
  periodMs = variationPeriodMs,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (value.length === 0) return undefined;
  const step = Math.floor(Math.max(0, nowMs) / periodMs);
  const index = Math.abs(seed + step) % value.length;
  return value[index] ?? value[0];
}
