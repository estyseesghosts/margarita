/**
 * Path helpers for references that must work against the *server's* filesystem, not the
 * frontend's. A remote server may have a different platform and separator conventions than
 * this machine, so nothing here may use `node:path` or `node:url` semantics.
 */

export type ServerPathShape = 'posix' | 'windows';

/** Shapes: drive-letter or UNC paths are windows; everything else is posix. */
export function serverPathShape(path: string): ServerPathShape {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return 'windows';
  return 'posix';
}

/** True when `path` is absolute under either posix or windows rules. */
export function isServerAbsolutePath(path: string): boolean {
  return path.startsWith('/') || serverPathShape(path) === 'windows';
}

function normalizeSegments(path: string): string[] {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '..') {
      // Lexical resolution: a `..` past the root is dropped rather than escaping it.
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

/** Joins `relative` onto `directory` using the server's separator conventions. */
export function joinServerPath(directory: string, relative: string): string {
  const shape = serverPathShape(directory);
  const drive = shape === 'windows' ? /^([A-Za-z]:)/.exec(directory)?.[1] : undefined;
  const uncRoot =
    shape === 'windows' && drive === undefined
      ? /^(\\\\[^\\/]+[\\/][^\\/]+)/.exec(directory)?.[1]
      : undefined;
  const root = drive ?? uncRoot;
  const body = root === undefined ? directory : directory.slice(root.length);
  // Combined normalization so `..` in `relative` pops directory segments (clamped at root).
  const out = normalizeSegments(`${body}/${relative}`);
  if (shape === 'posix') return `/${out.join('/')}`;
  if (uncRoot !== undefined) return `${uncRoot}\\${out.join('\\')}`;
  return `${root ?? 'C:'}\\${out.join('\\')}`;
}

/** Forward-slash normalized form for comparison (case-insensitive when the dir is windows). */
export function normalizeServerPath(path: string, shape: ServerPathShape): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '/');
  return shape === 'windows' ? normalized.toLowerCase() : normalized;
}

/** Base name (last segment) of a server path. */
export function baseServerPath(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}

/**
 * Path of `path` relative to `directory`, forward-slash; undefined when it escapes
 * the project root (including same-shape absolute paths elsewhere on the server).
 */
export function relativeServerPath(directory: string, path: string): string | undefined {
  const shape = serverPathShape(directory);
  const dir = normalizeServerPath(directory, shape);
  const full = normalizeServerPath(path, shape);
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  if (!full.startsWith(prefix)) return undefined;
  return full.slice(prefix.length);
}

/** `file://` URI for a server path, encoded per segment; correct for both shapes. */
export function serverFileUri(path: string): string {
  const shape = serverPathShape(path);
  const segments = normalizeSegments(path);
  if (shape === 'posix') {
    return `file:///${segments.map(encodeURIComponent).join('/')}`;
  }
  const drive = /^([A-Za-z])/.exec(path)?.[0];
  if (drive !== undefined) {
    return `file:///${drive.toUpperCase()}:/${segments.slice(1).map(encodeURIComponent).join('/')}`;
  }
  const [host, ...rest] = segments;
  if (host === undefined) return 'file:///';
  return `file://${encodeURIComponent(host)}/${rest.map(encodeURIComponent).join('/')}`;
}
