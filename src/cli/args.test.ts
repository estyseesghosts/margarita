import { describe, expect, test } from 'bun:test';

import { helpText, parseArgs } from './args.ts';

function run(argv: string[]) {
  const parsed = parseArgs(argv);
  if (parsed.kind !== 'run') throw new Error(`expected run, got ${JSON.stringify(parsed)}`);
  return parsed.options;
}

describe('parseArgs', () => {
  test('no arguments opens the overview', () => {
    expect(run([]).target).toEqual({ kind: 'new' });
  });
  test('a positional prompt starts an interactive session', () => {
    const options = run([
      '--provider',
      'openai',
      '--model',
      'gpt-6.1-sol',
      '--effort',
      'high',
      'Analyze it',
    ]);
    expect(options.target).toEqual({ kind: 'new', prompt: 'Analyze it' });
    expect(options.print).toBe(false);
    expect(options).toMatchObject({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' });
  });
  test('separate words are joined; quoting and newlines are preserved', () => {
    expect(run(['fix', 'the', 'bug']).target).toEqual({ kind: 'new', prompt: 'fix the bug' });
    expect(run(['line one\nline "two"!']).target).toEqual({
      kind: 'new',
      prompt: 'line one\nline "two"!',
    });
  });
  test('inline values and -- separator', () => {
    expect(run(['--model=openai/x#high', '--', '--not-a-flag']).target).toEqual({
      kind: 'new',
      prompt: '--not-a-flag',
    });
  });
  test('resume with and without ID', () => {
    expect(run(['--resume', 'ses_abc']).target).toEqual({ kind: 'resume', sessionID: 'ses_abc' });
    expect(run(['-r']).target).toEqual({ kind: 'overview' });
    expect(run(['-r', 'ses_abc', 'more']).target).toEqual({
      kind: 'resume',
      sessionID: 'ses_abc',
      prompt: 'more',
    });
  });
  test('continue appends the prompt to the latest session', () => {
    expect(run(['-c', 'go on']).target).toEqual({ kind: 'continue', prompt: 'go on' });
  });
  test('print mode', () => {
    const options = run(['-p', '--json', 'count']);
    expect(options).toMatchObject({ print: true, json: true });
  });
  test.each([
    [['--json', 'x'], '--json requires --print'],
    [['-c', '-r', 'ses_1'], 'cannot be combined'],
    [['-p'], '--print needs a prompt'],
    [['--model'], 'requires a value'],
    [['--model', 'a', '--model', 'b'], 'more than once'],
    [['--bogus'], 'Unknown option'],
    [['-r', 'hello'], 'opens the overview'],
    [['--server', 'http://x', '--start-server'], 'cannot be combined'],
  ])('rejects %p', (argv, message) => {
    const parsed = parseArgs(argv);
    expect(parsed.kind).toBe('error');
    expect(parsed.kind === 'error' && parsed.message).toContain(message);
  });
  test('help describes --json as buffered transcript messages, not live events (#46)', () => {
    expect(helpText).toContain('buffered, not live');
    expect(helpText).not.toContain('NDJSON events');
  });
  test('help and version short-circuit', () => {
    expect(parseArgs(['--help', '--bogus-later']).kind).toBe('error');
    expect(parseArgs(['-h']).kind).toBe('help');
    expect(parseArgs(['--version']).kind).toBe('version');
  });
});

describe('remote target selection', () => {
  test('--remote selects a saved profile', () => {
    expect(run(['--remote', 'buildbox']).remote).toBe('buildbox');
    expect(run(['--remote=buildbox', '--cwd', '/home/me/app'])).toMatchObject({
      remote: 'buildbox',
      cwd: '/home/me/app',
    });
  });
  test('--local forces the local service', () => {
    expect(run(['--local']).local).toBe(true);
  });
  test('conflicting target options are rejected', () => {
    for (const argv of [
      ['--remote', 'a', '--local'],
      ['--remote', 'a', '--server', 'https://x'],
      ['--remote', 'a', '--start-server'],
      ['--local', '--server', 'https://x'],
    ]) {
      expect(parseArgs(argv).kind).toBe('error');
    }
  });
  test('help documents remote selection', () => {
    expect(helpText).toContain('--remote <shortname>');
    expect(helpText).toContain('--local');
  });
});
