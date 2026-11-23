import { sanitizeSingleLine } from '../domain/sanitize-text.ts';
/**
 * Terminal-host boundary for the OS tab/window title (#329). The pure derivation lives in
 * `src/domain/terminal-title.ts`; this helper only encodes it as an OSC sequence on an
 * injectable writer. It never touches Margarita's rendered header or writes to stdout when the
 * output is not an interactive terminal.
 */
import { deriveTerminalTitle, type TerminalTitleSource } from '../domain/terminal-title.ts';

export type TitleSequenceStyle = 'osc0' | 'osc2';

export interface TerminalTitlePublisherOptions {
  /** Receives the complete escape sequence; injectable so tests can count writes. */
  readonly write: (sequence: string) => void;
  /** False for redirected/non-interactive output: no sequences are ever written. */
  readonly enabled: boolean;
  readonly style?: TitleSequenceStyle;
}

export interface TerminalTitlePublisher {
  /** Publishes only when the effective title actually changes. */
  set(session: TerminalTitleSource | undefined, fallbackDirectory?: string): void;
  /** Releases the title on a clean exit without leaving a stale suffix. */
  restore(): void;
  dispose(): void;
}

function sequence(style: TitleSequenceStyle, title: string): string {
  // Derivation already strips controls; sanitize again as defense in depth so a BEL or ST
  // can never terminate the OSC payload early (#329).
  const safe = sanitizeSingleLine(title);
  return `\u001b]${style === 'osc0' ? '0' : '2'};${safe}\u0007`;
}

export function createTerminalTitlePublisher(
  options: TerminalTitlePublisherOptions,
): TerminalTitlePublisher {
  const style = options.style ?? 'osc0';
  let lastPublished: string | undefined;
  let disposed = false;

  return {
    set(session, fallbackDirectory) {
      if (!options.enabled || disposed) return;
      const title = deriveTerminalTitle(session, fallbackDirectory);
      if (title === lastPublished) return;
      lastPublished = title;
      options.write(sequence(style, title));
    },
    restore() {
      if (!options.enabled || disposed || lastPublished === undefined) return;
      lastPublished = undefined;
      // An empty title releases the OS tab/window title without printing raw bytes into logs.
      options.write(sequence(style, ''));
    },
    dispose() {
      this.restore();
      disposed = true;
    },
  };
}
