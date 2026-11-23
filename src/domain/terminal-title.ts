/**
 * Pure OS terminal tab/window title derivation (#329). The terminal title is a separate
 * surface from Margarita's in-app header: it must never carry control bytes, raw user/agent
 * text or full private paths, and it must resolve the selected session's own directory rather
 * than the launcher process's CWD. Publishing the title to the terminal is a separate,
 * lifecycle-aware responsibility at the terminal-host boundary.
 */
import { sanitizeSingleLine } from './sanitize-text.ts';

const prefix = 'MARG';
const maxTitleLength = 120;

/** The selected session metadata needed for a title; both fields are optional. */
export interface TerminalTitleSource {
  readonly title?: string;
  readonly directory?: string;
}

function directoryBasename(directory: string | undefined): string | undefined {
  if (directory === undefined) return undefined;
  // A remote session may use either path style, so accept both separators.
  const segments = sanitizeSingleLine(directory)
    .split(/[\\/]+/)
    .filter((segment) => segment !== '' && segment !== '.');
  return segments.at(-1);
}

/** Truncates by code point so a long Unicode title never ends on half a surrogate pair. */
function truncate(text: string): string {
  const points = Array.from(text);
  if (points.length <= maxTitleLength) return text;
  return `${points.slice(0, maxTitleLength - 1).join('')}…`;
}

/**
 * Derives a single-line, control-safe title: session title, then the session's own directory
 * basename, then the fallback directory basename, then the bare prefix. Never emits an opaque
 * ID, `undefined`, or an empty suffix (#329).
 */
export function deriveTerminalTitle(
  session: TerminalTitleSource | undefined,
  fallbackDirectory?: string,
): string {
  const sessionTitle = session?.title === undefined ? undefined : sanitizeSingleLine(session.title);
  if (sessionTitle !== undefined && sessionTitle !== '')
    return `${prefix} - ${truncate(sessionTitle)}`;

  const directory = directoryBasename(session?.directory) ?? directoryBasename(fallbackDirectory);
  if (directory !== undefined && directory !== '') return `${prefix} - ${truncate(directory)}`;
  return prefix;
}
