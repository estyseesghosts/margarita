/**
 * Build identity for margarita: `YY-MM-<short commit>` from the commit date, plus `-dirty` when
 * the working tree has uncommitted changes. `scripts/build.ts` stamps the value into the compiled
 * binary through Bun's `define`; running from source probes the repository instead.
 */
declare const MARGARITA_BUILD_VERSION: string | undefined;

export type BuildIdentity = Readonly<{
  /** Four-digit year; the version keeps only its last two digits. */
  year: number;
  /** One-based month. */
  month: number;
  /** Abbreviated commit hash (at least six hex digits). */
  commit: string;
  dirty: boolean;
}>;

const shortCommitLength = 6;

/** The version this process reports. */
export function buildVersion(): string {
  return typeof MARGARITA_BUILD_VERSION === 'string'
    ? MARGARITA_BUILD_VERSION
    : formatBuildVersion(sourceIdentity());
}

export function formatBuildVersion(identity: BuildIdentity): string {
  const year = String(identity.year % 100).padStart(2, '0');
  const month = String(identity.month).padStart(2, '0');
  return `${year}-${month}-${identity.commit}${identity.dirty ? '-dirty' : ''}`;
}

/** Probes the repository containing this source file. Used by the build and by source runs. */
export function sourceIdentity(): BuildIdentity {
  const now = new Date();
  const commit = git(['rev-parse', `--short=${shortCommitLength}`, 'HEAD']);
  if (commit === undefined) {
    return { year: now.getFullYear(), month: now.getMonth() + 1, commit: 'unknown', dirty: false };
  }
  const date = commitDate() ?? { year: now.getFullYear(), month: now.getMonth() + 1 };
  // Any uncommitted change - tracked or untracked - can end up in the build.
  const status = git(['status', '--porcelain']);
  return { ...date, commit, dirty: status !== '' };
}

/** The commit's own date (committer date, in its recorded timezone), not the build date. */
function commitDate(): { year: number; month: number } | undefined {
  const value = git(['log', '-1', '--format=%cs', 'HEAD']);
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(value ?? '');
  if (match === null) return undefined;
  const [, year, month] = match;
  if (year === undefined || month === undefined) return undefined;
  return { year: Number(year), month: Number(month) };
}

function git(args: readonly string[]): string | undefined {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}
