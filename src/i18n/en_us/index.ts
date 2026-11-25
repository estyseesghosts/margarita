import type { LocaleStrings } from '../types.ts';
import { chromeEnUs } from './chrome.ts';
import { cliEnUs } from './cli.ts';
import { commandsEnUs } from './commands.ts';
import { errorsEnUs } from './errors.ts';
import { formsEnUs } from './forms.ts';
import { greetingsEnUs } from './greetings.ts';
import { noticesEnUs } from './notices.ts';
import { overlaysEnUs } from './overlays.ts';
import { overviewEnUs } from './overview.ts';
import { throbberEnUs } from './throbber.ts';
import { transcriptEnUs } from './transcript.ts';

/** English (United States), assembled from one module per surface. */
export const enUsStrings = {
  greetings: greetingsEnUs,
  throbber: throbberEnUs,
  overview: overviewEnUs,
  chrome: chromeEnUs,
  overlays: overlaysEnUs,
  transcript: transcriptEnUs,
  forms: formsEnUs,
  errors: errorsEnUs,
  commands: commandsEnUs,
  notices: noticesEnUs,
  cli: cliEnUs,
} satisfies LocaleStrings;
