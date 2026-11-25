import { strings } from '../i18n/index.ts';
import type { GreetingPeriod } from './greeting-time.ts';

/**
 * Extensible greeting catalog for the active locale. Only short, plain text lives in the
 * locale file: no terminal escape sequences and no server-provided content. Add an entry
 * to a pool there to make it available.
 */
export const greetingCatalog = strings.greetings.catalog;

const timedWeight = 0.7;
const recentLimit = 4;
const fallback = strings.greetings.fallback;

/** Uniform pick from a pool, with an empty pool returning undefined. */
function pick(pool: readonly string[], rng: () => number): string | undefined {
  if (pool.length === 0) return undefined;
  const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return pool[index];
}

/**
 * Select a greeting: 70% time-specific / 30% anytime for a known period, 100% anytime
 * otherwise. Exact repeats from the last four shown greetings are avoided across all
 * pools; if that leaves nothing eligible the history restriction is relaxed, and if a
 * pool is empty the other pool is used. Never throws or returns an empty string.
 */
export function selectGreeting(
  period: GreetingPeriod | undefined,
  recentHistory: readonly string[],
  rng: () => number = Math.random,
): string {
  const recent = new Set(recentHistory.slice(-recentLimit));
  const timed =
    period !== undefined && Object.hasOwn(greetingCatalog, period) ? greetingCatalog[period] : [];
  const anytime = greetingCatalog.anytime;
  const preferTimed = timed.length > 0 && rng() < timedWeight;
  const pools = preferTimed ? [timed, anytime] : [anytime, timed];
  // Try the alternate pool before allowing any exact repeat.
  for (const pool of pools) {
    const chosen = pick(
      pool.filter((greeting) => !recent.has(greeting)),
      rng,
    );
    if (chosen !== undefined) return chosen;
  }
  for (const pool of pools) {
    const chosen = pick(pool, rng);
    if (chosen !== undefined) return chosen;
  }
  return fallback;
}
