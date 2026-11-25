import type { FormsStrings } from '../types.ts';

/** English (United States) form validation and custom-entry messages. */
export const formsEnUs = {
  required: 'required.',
  pickOneOfOptions: 'pick one option.',
  expectedWholeNumber: 'enter a whole number.',
  expectedNumber: 'enter a number.',
  atLeast: (minimum) => `at least ${minimum}.`,
  atMost: (maximum) => `at most ${maximum}.`,
  pickAtLeast: (minimum) => `pick at least ${minimum}.`,
  pickAtMost: (maximum) => `pick at most ${maximum}.`,
  minLength: (minimum) => `minimum ${minimum} character${minimum === 1 ? '' : 's'}.`,
  maxLength: (maximum) => `maximum ${maximum} character${maximum === 1 ? '' : 's'}.`,
  patternMismatch: 'bad formatting.',
  email: 'enter an email address.',
  uri: 'enter a URI.',
  date: 'enter a date (YYYY-MM-DD).',
  dateTime: 'enter a date and time.',
  alreadyChosen: 'already chosen.',
  noFieldSelected: 'no field selected.',
  openExternalInBrowser: 'open external prompts in a browser.',
  fieldDoesNotAcceptText: 'this field does not accept text.',
} satisfies FormsStrings;
