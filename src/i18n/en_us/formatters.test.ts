import { describe, expect, test } from 'bun:test';

import { enUsStrings } from './index.ts';

/**
 * These assert the literal English a formatter produces, not merely that production and the
 * test import the same constant. They are the guardrail for plural and interpolation shapes.
 */
describe('en_us formatters', () => {
  test('tool summaries pluralize the counted noun', () => {
    const tools = enUsStrings.transcript.tools;
    expect(tools.read(1)).toBe('Read 1 file');
    expect(tools.read(3)).toBe('Read 3 files');
    expect(tools.search(1)).toBe('Searched for 1 pattern');
    expect(tools.search(2)).toBe('Searched for 2 patterns');
    expect(tools.shell(1)).toBe('Ran 1 shell command');
    expect(tools.shell(4)).toBe('Ran 4 shell commands');
    expect(tools.externalCalls(1)).toBe('Called 1 external tool');
    expect(tools.serverCalls('lotus', 2)).toBe('Called lotus 2 times');
  });

  test('throbber elapsed and token forms interpolate their values', () => {
    expect(enUsStrings.throbber.tokens('63.6k')).toBe('63.6k tokens');
    expect(enUsStrings.throbber.finishedAt('1:29 AM')).toBe('done at 1:29 AM');
    expect(enUsStrings.throbber.elapsed.hoursMinutes(1, 2)).toBe('1h 2m');
    expect(enUsStrings.throbber.elapsed.minutesSeconds(13, 3)).toBe('13m 3s');
    expect(enUsStrings.throbber.elapsed.seconds(9)).toBe('9s');
  });

  test('overview count and directory forms keep their punctuation', () => {
    expect(enUsStrings.overview.showMore(2)).toBe('[Show more] 2');
    expect(enUsStrings.overview.tasksProgress(1, 4)).toBe(' · 1/4 tasks');
    expect(enUsStrings.overview.couldNotLoadMore('timeout')).toBe(
      'Could not load more sessions: timeout',
    );
    expect(enUsStrings.overview.newSessionIn('kohjoh')).toBe('New session in: kohjoh');
    expect(enUsStrings.overview.pairedUnavailable('buildbox')).toBe(
      'Paired server buildbox is unavailable (no usable credential).',
    );
  });

  test('form character limits pluralize "character"', () => {
    expect(enUsStrings.forms.minLength(1)).toBe('minimum 1 character.');
    expect(enUsStrings.forms.maxLength(3)).toBe('maximum 3 characters.');
    expect(enUsStrings.forms.atLeast(2)).toBe('at least 2.');
  });

  test('footer counts and token rows interpolate without concatenation drift', () => {
    expect(enUsStrings.chrome.footer.queued(2)).toBe('2 queued');
    expect(enUsStrings.chrome.footer.contextPercent(41)).toBe('41% context');
    expect(enUsStrings.chrome.footer.tokensInOut('~', '42k', '5k')).toBe('~42k in · 5k out');
  });

  test('transcript tool counts distinguish singular and plural rows', () => {
    const tool = enUsStrings.transcript.tool;
    expect(tool.failedCount(2, 2)).toBe('2 failed');
    expect(tool.failedCount(2, 1)).toBe('2 failed (1 shown)');
    expect(tool.moreFiles(1)).toBe('    … 1 more file · inspect for the full metadata');
    expect(tool.moreFiles(2)).toBe('    … 2 more files · inspect for the full metadata');
    expect(enUsStrings.transcript.shell.status('timeout', 1)).toBe('  └ timeout (exit 1)');
    expect(enUsStrings.transcript.shell.status('completed', undefined)).toBe('  └ completed');
  });

  test('CLI argument errors name the flag exactly once', () => {
    expect(enUsStrings.cli.args.requiresValue('--model')).toBe('--model requires a value.');
    expect(enUsStrings.cli.args.duplicated('--model')).toBe('--model was given more than once.');
    expect(enUsStrings.cli.args.unknownOption('--nope')).toBe('Unknown option --nope. See --help.');
  });
});
