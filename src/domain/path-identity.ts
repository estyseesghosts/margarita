/**
 * Canonical equality key for a project directory. On Windows paths are
 * case-insensitive and accept either separator; elsewhere case is preserved.
 * Does not touch the filesystem: folders may no longer exist.
 */
export function directoryKey(directory: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const normalized = directory.replaceAll('/', '\\').replace(/\\+$/, '');
    return (normalized === '' ? '\\' : normalized).toLowerCase();
  }
  const normalized = directory.replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}

/** Display basename of a directory, tolerating both separators. */
export function directoryName(directory: string): string {
  const parts = directory.split(/[\\/]+/).filter((part) => part !== '');
  return parts.at(-1) ?? directory;
}

/** Whether `child` equals `parent` or is inside it. */
export function isWithin(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const childKey = directoryKey(child, platform);
  const parentKey = directoryKey(parent, platform);
  if (childKey === parentKey) return true;
  const separator = platform === 'win32' ? '\\' : '/';
  return childKey.startsWith(parentKey.endsWith(separator) ? parentKey : parentKey + separator);
}
