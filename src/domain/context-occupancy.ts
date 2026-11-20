/**
 * Presentation-only mapping from a validated current-context occupancy percentage to a
 * semantic severity. Cumulative token totals are never accepted here: `undefined`,
 * non-finite, negative and over-100 values are all reported as unknown so the UI shows a
 * neutral fallback instead of inventing a red warning.
 */
export type ContextSeverity = 'normal' | 'warning' | 'critical' | 'unknown';

export function contextSeverity(occupancy: number | undefined): ContextSeverity {
  if (occupancy === undefined || !Number.isFinite(occupancy) || occupancy < 0 || occupancy > 100) {
    return 'unknown';
  }
  if (occupancy >= 90) return 'critical';
  if (occupancy >= 70) return 'warning';
  return 'normal';
}
