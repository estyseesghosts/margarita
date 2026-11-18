import { describe, expect, test } from 'bun:test';

import {
  baseServerPath,
  isServerAbsolutePath,
  joinServerPath,
  normalizeServerPath,
  relativeServerPath,
  serverFileUri,
  serverPathShape,
} from './server-path.ts';

describe('serverPathShape', () => {
  test('posix directories are posix', () => {
    expect(serverPathShape('/home/u/proj')).toBe('posix');
    expect(serverPathShape('relative/dir')).toBe('posix');
  });

  test('drive-letter and UNC roots are windows, forward or back slashes', () => {
    expect(serverPathShape('C:\\Users\\u\\proj')).toBe('windows');
    expect(serverPathShape('c:/users/u/proj')).toBe('windows');
    expect(serverPathShape('D:')).toBe('posix'); // drive-relative, not absolute
    expect(serverPathShape('\\\\server\\share\\proj')).toBe('windows');
  });
});

describe('isServerAbsolutePath', () => {
  test('posix absolute', () => {
    expect(isServerAbsolutePath('/home/u/proj/a.ts')).toBe(true);
    expect(isServerAbsolutePath('src/a.ts')).toBe(false);
  });

  test('windows absolute (drive or UNC)', () => {
    expect(isServerAbsolutePath('C:\\proj\\a.ts')).toBe(true);
    expect(isServerAbsolutePath('c:/proj/a.ts')).toBe(true);
    expect(isServerAbsolutePath('\\\\server\\share\\a.ts')).toBe(true);
    expect(isServerAbsolutePath('proj\\a.ts')).toBe(false);
  });
});

describe('joinServerPath', () => {
  test('posix joins with forward slashes', () => {
    expect(joinServerPath('/home/u/proj', 'src/a.ts')).toBe('/home/u/proj/src/a.ts');
    expect(joinServerPath('/home/u/proj/', 'src/a.ts')).toBe('/home/u/proj/src/a.ts');
    expect(joinServerPath('/home/u/proj', './src/./a.ts')).toBe('/home/u/proj/src/a.ts');
    expect(joinServerPath('/home/u/proj', '../shared/b.ts')).toBe('/home/u/shared/b.ts');
  });

  test('posix `..` cannot escape the root', () => {
    expect(joinServerPath('/proj', '../../../etc/passwd')).toBe('/etc/passwd');
  });

  test('windows drive joins with backslashes', () => {
    expect(joinServerPath('C:\\Users\\u\\proj', 'src/a.ts')).toBe('C:\\Users\\u\\proj\\src\\a.ts');
    expect(joinServerPath('C:/Users/u/proj', 'src\\a.ts')).toBe('C:\\Users\\u\\proj\\src\\a.ts');
    expect(joinServerPath('C:\\proj', '..\\up.ts')).toBe('C:\\up.ts');
  });

  test('UNC joins keep the server root', () => {
    expect(joinServerPath('\\\\server\\share\\proj', 'src/a.ts')).toBe(
      '\\\\server\\share\\proj\\src\\a.ts',
    );
  });

  test('mixed separators in the relative part are accepted', () => {
    expect(joinServerPath('C:\\proj', 'src/nested\\a.ts')).toBe('C:\\proj\\src\\nested\\a.ts');
  });
});

describe('normalizeServerPath', () => {
  test('windows normalization is case-insensitive and forward-slash', () => {
    expect(normalizeServerPath('C:\\Users\\U\\Proj\\A.TS', 'windows')).toBe('c:/users/u/proj/a.ts');
  });

  test('posix normalization keeps case', () => {
    expect(normalizeServerPath('/Home/U/A.ts', 'posix')).toBe('/Home/U/A.ts');
  });
});

describe('relativeServerPath', () => {
  test('posix: file inside the project is relative to it', () => {
    expect(relativeServerPath('/proj', '/proj/src/a.ts')).toBe('src/a.ts');
    expect(relativeServerPath('/proj/', '/proj/a.ts')).toBe('a.ts');
  });

  test('posix: file outside the project is rejected', () => {
    expect(relativeServerPath('/proj', '/etc/passwd')).toBeUndefined();
    expect(relativeServerPath('/proj', '/proj2/a.ts')).toBeUndefined();
  });

  test('windows: comparisons are case-insensitive', () => {
    expect(relativeServerPath('C:\\Proj', 'c:\\proj\\src\\A.ts')).toBe('src/a.ts');
    expect(relativeServerPath('C:\\Proj', 'C:\\other\\a.ts')).toBeUndefined();
  });

  test('windows: shared UNC project', () => {
    expect(relativeServerPath('\\\\server\\share\\proj', '\\\\server\\share\\proj\\a.ts')).toBe(
      'a.ts',
    );
  });
});

describe('baseServerPath', () => {
  test('returns the last segment for either separator', () => {
    expect(baseServerPath('/proj/src/a.ts')).toBe('a.ts');
    expect(baseServerPath('C:\\proj\\src\\a.ts')).toBe('a.ts');
    expect(baseServerPath('a.ts')).toBe('a.ts');
  });
});

describe('serverFileUri', () => {
  test('posix paths become file:/// with per-segment encoding', () => {
    expect(serverFileUri('/home/u/a b.ts')).toBe('file:///home/u/a%20b.ts');
    expect(serverFileUri('/weird/[x]#y?.ts')).toBe('file:///weird/%5Bx%5D%23y%3F.ts');
  });

  test('windows drive paths keep the drive letter upper-cased', () => {
    expect(serverFileUri('C:\\proj\\a b.ts')).toBe('file:///C:/proj/a%20b.ts');
    expect(serverFileUri('c:/proj/src/a.ts')).toBe('file:///C:/proj/src/a.ts');
  });

  test('windows UNC paths become host-qualified file:// URIs', () => {
    expect(serverFileUri('\\\\server\\share\\proj\\a b.ts')).toBe(
      'file://server/share/proj/a%20b.ts',
    );
  });
});
