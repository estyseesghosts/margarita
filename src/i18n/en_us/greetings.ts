import type { GreetingStrings } from '../types.ts';

/** English (United States) greeting text. */
export const greetingsEnUs = {
  catalog: {
    morning: ['good morning!', "mornin'!", 'early start?', 'up and at it?', 'sunrise debugger'],
    afternoon: [
      'good afternoon!',
      "it's daytime!",
      'back to work?',
      'ready to start working?',
      'meow!',
    ],
    evening: ['good evening!', 'back for more?', 'sunset programmer'],
    night: ['up late?', 'night owl?', 'working late?', 'late night ideas?'],
    anytime: [
      ':3',
      'hey!',
      'what are you building?',
      'rm -rfv / --no-preserve-root',
      'new day, new project?',
    ],
  },
  fallback: 'welcome back!',
} satisfies GreetingStrings;
