import type { TokenUsage } from './session.ts';

/** `$0.38`; sub-cent nonzero values show `<$0.01`; unknown cost shows `—`, never `$0.00`. */
export function formatCost(cost: number | undefined): string {
  if (cost === undefined || !Number.isFinite(cost) || cost < 0) return '—';
  if (cost > 0 && cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

/** Rounds to the nearest thousand: `46k`, `1.2M`. */
export function formatTokenCount(count: number): string {
  if (count < 1000) return count === 0 ? '0' : '<1k';
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Footer token headline. Input and output are shown separately because cache-read
 * overlap with input differs between providers; summing would double count.
 */
export function formatTokens(tokens: TokenUsage | undefined): string {
  if (tokens === undefined) return '— tok';
  return `${formatTokenCount(tokens.input)} in · ${formatTokenCount(tokens.output)} out`;
}

/** Relative age for overview rows, from a fixed `now` so it is testable. */
export function formatAge(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
