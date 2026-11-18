import { describe, expect, test } from 'bun:test';

import { isCrossPlatformPath, resolveWorkingDirectory } from './target.ts';

describe('working directory resolution', () => {
  test('local relative paths resolve against the shell directory', () => {
    expect(
      resolveWorkingDirectory({
        cwd: 'work/app',
        remote: false,
        localCwd: '/home/me',
        platform: 'linux',
      }),
    ).toEqual({ ok: true, directory: '/home/me/work/app' });
  });

  test('local absolute paths are kept', () => {
    expect(
      resolveWorkingDirectory({
        cwd: '/srv/repo',
        remote: false,
        localCwd: '/home/me',
        platform: 'linux',
      }),
    ).toEqual({ ok: true, directory: '/srv/repo' });
  });

  test('a remote target never resolves a relative path locally', () => {
    const result = resolveWorkingDirectory({
      cwd: 'work/app',
      remote: true,
      localCwd: '/home/me',
      platform: 'linux',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('absolute path on the remote host');
  });

  test('a remote absolute path is passed through unchanged', () => {
    expect(
      resolveWorkingDirectory({
        cwd: '/home/me/app',
        remote: true,
        localCwd: 'C:\\work',
        platform: 'win32',
      }),
    ).toEqual({ ok: true, directory: '/home/me/app' });
  });

  test('no remote cwd means no implicit session directory', () => {
    expect(
      resolveWorkingDirectory({
        cwd: undefined,
        remote: true,
        localCwd: '/home/me',
        platform: 'linux',
      }),
    ).toEqual({ ok: true, directory: '' });
  });

  test('detects cross-platform path shapes', () => {
    expect(isCrossPlatformPath('/home/me/app', 'win32')).toBe(true);
    expect(isCrossPlatformPath('C:\\work\\app', 'linux')).toBe(true);
    expect(isCrossPlatformPath('/home/me/app', 'linux')).toBe(false);
  });
});
