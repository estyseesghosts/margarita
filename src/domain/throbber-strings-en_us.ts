import type { ToolCategory } from './tool-classification.ts';

/** Elapsed-time forms used by the inline activity indicator. */
export interface ThrobberElapsedStrings {
  readonly hoursMinutes: (hours: number, minutes: number) => string;
  readonly minutesSeconds: (minutes: number, seconds: number) => string;
  readonly seconds: (seconds: number) => string;
}

/**
 * User-facing text for the inline activity indicator (docs/21-throbber.md), for one
 * locale. Only display text lives here; glyphs and animation frames are not localized.
 */
export interface ThrobberStrings {
  /** Decorative verbs used when the agent reports no specific activity. */
  readonly decorativeVerbs: readonly string[];
  /** Last-resort verb when no decorative verb can be selected. Must be non-empty. */
  readonly fallbackVerb: string;
  /** Short status label for a tool category that is genuinely running. */
  readonly activity: Readonly<Record<ToolCategory, string>>;
  /** Status while the conversation is being compacted. */
  readonly compacting: string;
  /** Status while the model is reasoning without a running tool. */
  readonly thinking: string;
  /** Dimmed prefix for the optional secondary hint line. */
  readonly tipPrefix: string;
  /** At most one of these is shown per long turn. */
  readonly tips: readonly string[];
  /** Reported token usage, e.g. `63.6k tokens`. */
  readonly tokens: (count: string) => string;
  /** Completed-turn status, e.g. `Finished at 1:29 AM`. */
  readonly finishedAt: (time: string) => string;
  readonly interrupted: string;
  readonly failed: string;
  readonly elapsed: ThrobberElapsedStrings;
}

/** English (United States) throbber text. */
export const throbberStringsEnUs: ThrobberStrings = {
  decorativeVerbs: ['thinking', 'combobulating', 'composing', 'ideating', 'dashing', 'snooping', 'tinkering', 'wondering', 'sketching', 'shivering', 'crawling', "jorkin' it"],
  fallbackVerb: 'thinking',
  activity: {
    read: 'reading',
    search: 'searching',
    edit: 'vim-ing',
    shell: 'running',
    code: 'scripting',
    web: 'internetting',
    delegate: 'delegating',
    other: 'producing',
  },
  compacting: 'compacting',
  thinking: 'thinking',
  tipPrefix: 'tip:',
  tips: [
    'press shift+tab to cycle agents',
    'press ctrl+o to show the detailed transcript',
    'press ctrl+c to interrupt your session. press it twice to close the program.',
    'press alt+enter to steer instead of queueing (f6, ctrl+enter)',
    'press f1 for all key bindings',
  ],
  tokens: (count) => `${count} tokens`,
  finishedAt: (time) => `done at ${time}`,
  interrupted: 'interrupted - what should we do next?',
  failed: 'failed!',
  elapsed: {
    hoursMinutes: (hours, minutes) => `${hours}h ${minutes}m`,
    minutesSeconds: (minutes, seconds) => `${minutes}m ${seconds}s`,
    seconds: (seconds) => `${seconds}s`,
  },
};
