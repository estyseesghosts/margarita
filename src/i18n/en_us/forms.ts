import type { FormsStrings } from '../types.ts';

/** English (United States) form validation and custom-entry messages. */
export const formsEnUs = {
  required: 'Required.',
  pickOneOfOptions: 'Pick one of the options.',
  expectedWholeNumber: 'Enter a whole number.',
  expectedNumber: 'Enter a number.',
  atLeast: (minimum) => `At least ${minimum}.`,
  atMost: (maximum) => `At most ${maximum}.`,
  pickAtLeast: (minimum) => `Pick at least ${minimum}.`,
  pickAtMost: (maximum) => `Pick at most ${maximum}.`,
  minLength: (minimum) => `Must be at least ${minimum} character${minimum === 1 ? '' : 's'}.`,
  maxLength: (maximum) => `Must be at most ${maximum} character${maximum === 1 ? '' : 's'}.`,
  patternMismatch: 'Does not match the requested format.',
  email: 'Enter an email address.',
  uri: 'Enter a URI.',
  date: 'Enter a date (YYYY-MM-DD).',
  dateTime: 'Enter a date and time.',
  alreadyChosen: 'Already chosen.',
  noFieldSelected: 'No field is selected.',
  openExternalInBrowser: 'Open external prompts in a browser.',
  fieldDoesNotAcceptText: 'This field does not accept text.',
} satisfies FormsStrings;
