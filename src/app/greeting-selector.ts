/**
 * Stable greeting selection per cache key (#318).
 *
 * A greeting is picked once on first use and kept for the lifetime of the process,
 * across re-renders, remounts and route revisits. Recent picks avoid exact repeats;
 * history is bounded and in-memory only (local state has no schema for it yet).
 */
import type { GreetingPeriod } from '../domain/greeting-time.ts';
import { selectGreeting } from '../domain/greetings.ts';

const historyLimit = 8;

/** Owns the per-key greeting cache and the bounded recent-pick history. */
export class GreetingSelector {
  private readonly cache = new Map<string, string>();
  private readonly recent: string[] = [];

  /** Returns the stable greeting for `key`, selecting it on first use. */
  for(key: string, period: GreetingPeriod | undefined, rng: () => number = Math.random): string {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const greeting = selectGreeting(period, this.recent, rng);
    this.cache.set(key, greeting);
    this.recent.push(greeting);
    if (this.recent.length > historyLimit) this.recent.shift();
    return greeting;
  }
}
