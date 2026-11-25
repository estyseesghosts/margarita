import type { GreetingPeriod } from './greeting-time.ts';

/**
 * Greeting text for one locale.
 *
 * The catalog holds only short, plain text: no terminal escape sequences and no
 * server-provided content. Another locale implements this interface with its own pools.
 */
export interface GreetingStrings {
  readonly catalog: Readonly<Record<GreetingPeriod | 'anytime', readonly string[]>>;
  /** Last-resort greeting when every pool is empty. Must be non-empty. */
  readonly fallback: string;
}

/** English (United States) greeting text. */
export const greetingStringsEnUs: GreetingStrings = {
  catalog: {
    morning: ['good morning!', 'mornin\'!', 'early start?', 'up and at it?', 'sunrise debugger'],
    afternoon: ['good afternoon!', 'it\'s daytime!', 'back to work?', 'ready to start working?', 'meow!'],
    evening: ['good evening!', 'back for more?', 'sunset programmer'],
    night: ['up late?', 'night owl?', 'working late?', 'late night ideas?'],
    anytime: [':3', 'hey!', 'what are you building?', 'rm -rfv / --no-preserve-root', 'new day, new project?'],
  },
  fallback: 'welcome back!',
};
