/**
 * Greeting time-of-day classification.
 *
 * This is client-side presentation only: the injected `Date` is interpreted in the
 * Margarita process's own local timezone (via `getHours()`), never a paired server's
 * clock or timezone. Passing a `Date` keeps boundaries testable without depending on
 * the CI runner's current time.
 */
export type GreetingPeriod = 'morning' | 'afternoon' | 'evening' | 'night';

/** Morning 05:00–11:59, afternoon 12:00–16:59, evening 17:00–21:59, night 22:00–04:59. */
export function greetingPeriod(at: Date): GreetingPeriod {
  const hour = at.getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}
