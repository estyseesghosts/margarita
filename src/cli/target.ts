import { posix, win32 } from 'node:path';

import type { RouteName } from '../config/config.ts';
import { isServerAbsolutePath, serverPathShape } from '../domain/server-path.ts';
import type { StartTarget } from './args.ts';

/**
 * Applies the configured startup route only to the implicit no-argument target.
 * Every explicit CLI selection (prompt, --continue, --resume) is left untouched.
 */
export function withDefaultRoute(target: StartTarget, defaultRoute: RouteName): StartTarget {
  if (target.kind === 'new' && target.prompt === undefined && defaultRoute === 'overview') {
    return { kind: 'overview' };
  }
  return target;
}

export type WorkingDirectoryResult =
  { ok: true; directory: string } | { ok: false; message: string };

/**
 * Resolves `--cwd` for the selected target. Local paths may be relative to the shell's
 * directory; a remote path is always interpreted on the remote host and is never passed
 * through `node:path.resolve()` (which would silently produce a local absolute path).
 */
export function resolveWorkingDirectory(options: {
  cwd: string | undefined;
  remote: boolean;
  localCwd: string;
  platform: NodeJS.Platform;
}): WorkingDirectoryResult {
  if (options.remote) {
    if (options.cwd === undefined) return { ok: true, directory: '' };
    if (!isServerAbsolutePath(options.cwd)) {
      return {
        ok: false,
        message:
          '--cwd must be an absolute path on the remote host. Relative remote paths are not resolved against this machine.',
      };
    }
    return { ok: true, directory: options.cwd };
  }
  if (options.cwd === undefined) return { ok: true, directory: options.localCwd };
  const paths = options.platform === 'win32' ? win32 : posix;
  if (!paths.isAbsolute(options.cwd)) {
    return { ok: true, directory: paths.resolve(options.localCwd, options.cwd) };
  }
  return { ok: true, directory: options.cwd };
}

/** True when the path shape looks like a different platform than this frontend. */
export function isCrossPlatformPath(path: string, platform: NodeJS.Platform): boolean {
  const shape = serverPathShape(path);
  if (platform === 'win32') return shape === 'posix';
  return shape === 'windows';
}
