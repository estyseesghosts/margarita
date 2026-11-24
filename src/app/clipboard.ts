import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createHostClipboard,
  type HostClipboardService,
  type TerminalClipboardAdapter,
} from '@opentui/core';

/**
 * Where an explicit or automatic copy actually landed. A terminal write is deliberately
 * called `unconfirmed`: OSC 52 has no acknowledgement, so no backend may claim success.
 */
export type CopyOutcome =
  | Readonly<{ status: 'written'; backend: 'native' }>
  | Readonly<{ status: 'unconfirmed'; backend: 'terminal' }>
  | Readonly<{ status: 'file'; path: string }>
  | Readonly<{ status: 'unavailable'; detail: string }>;

/** One clipboard read, keeping the bytes and MIME type the source supplied. */
export type ClipboardRead =
  | Readonly<{ status: 'read'; bytes: Uint8Array; mimeType: string }>
  | Readonly<{ status: 'empty' }>
  | Readonly<{ status: 'unsupported'; detail: string }>
  | Readonly<{ status: 'too-large'; detail: string }>
  | Readonly<{ status: 'failed'; detail: string }>;

/** The surface the controller owns: transport only, never an OpenCode server RPC. */
export type ClipboardPort = Readonly<{
  /**
   * Writes exact text. `fileFallback` is opt-in so a failed autocopy never silently
   * writes private selection bytes to disk.
   */
  writeText: (text: string, options?: Readonly<{ fileFallback?: boolean }>) => Promise<CopyOutcome>;
  read: () => Promise<ClipboardRead>;
}>;

export type ClipboardService = ClipboardPort &
  Readonly<{
    /** The renderer owns the terminal OSC 52 channel and is created after the controller. */
    attachTerminal: (adapter: TerminalClipboardAdapter | undefined) => void;
    dispose: () => Promise<void>;
  }>;

/**
 * MIME preference for paste. Text wins when the source offers both, matching the old
 * bracketed-paste behaviour; images and PDFs are the attachment types this client accepts.
 */
export const clipboardReadTypes: readonly [string, ...string[]] = [
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
];

/**
 * A process logged in over SSH owns the *remote* desktop clipboard, not the one belonging
 * to the person at the terminal. In that environment OSC 52 is the only truthful route.
 */
export function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
  return (
    env['SSH_CONNECTION'] !== undefined ||
    env['SSH_TTY'] !== undefined ||
    env['MOSH_CONNECTION'] !== undefined
  );
}

export type ClipboardServiceOptions = Readonly<{
  stateDir: string;
  pid: number;
  /** OSC 52-only: never touch the host clipboard of the machine this process runs on. */
  remote?: boolean;
  /** `null` disables the native backend even on a local session (tests). */
  host?: HostClipboardService | null;
  terminal?: TerminalClipboardAdapter;
}>;

/**
 * One client-local clipboard service shared by every copy and paste path. Writes prefer the
 * native desktop clipboard (Windows, macOS, Wayland and X11 through OpenTUI's bundled
 * backend), fall back to the terminal's OSC 52 channel, and only then to an explicit,
 * owner-only local file when the caller allows it. Reads exist only through the native
 * backend: there is no portable terminal read.
 */
export function createClipboardService(options: ClipboardServiceOptions): ClipboardService {
  const remote = options.remote === true;
  // `undefined` means "create the native backend on first use": print mode and unit tests
  // never open the desktop clipboard, and a headless host only pays for the attempt when the
  // user actually copies or pastes.
  let host: HostClipboardService | null | undefined = options.host;
  let terminal = options.terminal;
  let disposed = false;
  let writeChain: Promise<unknown> = Promise.resolve();

  const ensureHost = (): HostClipboardService | null => {
    if (host === undefined) host = createOwnedHostClipboard(remote);
    return host;
  };

  const writeFallbackFile = async (text: string): Promise<CopyOutcome> => {
    try {
      await mkdir(options.stateDir, { recursive: true });
      const path = join(options.stateDir, `marg-copy-${options.pid}-${randomUUID()}.txt`);
      await writeFile(path, text, { encoding: 'utf8', mode: 0o600 });
      try {
        await chmod(path, 0o600);
      } catch {
        // Filesystems without POSIX permission bits still keep the exact bytes.
      }
      return { status: 'file', path };
    } catch (error) {
      return unavailable(`could not save a fallback file: ${messageOf(error)}`);
    }
  };
  const writeNative = async (text: string): Promise<CopyOutcome | undefined> => {
    if (remote) return undefined;
    const native = ensureHost();
    if (native === null) return undefined;
    try {
      const result = await native.writeText(text, { selection: 'clipboard' });
      switch (result.status) {
        case 'written':
          return { status: 'written', backend: 'native' };
        case 'unsupported':
          return undefined;
        case 'timed-out':
          return unavailable('the system clipboard did not respond');
        case 'cancelled':
          return unavailable('the system clipboard write was cancelled');
        case 'failed':
          return unavailable(result.error.message);
        default:
          return unavailable('the system clipboard returned an unknown result');
      }
    } catch {
      // Native access can reject synchronously for NUL characters or unpaired surrogates;
      // the terminal channel can still carry escaped text, so let it try before failing.
      return undefined;
    }
  };

  const writeTerminal = (text: string): CopyOutcome | undefined => {
    const adapter = terminal;
    if (adapter === undefined) return undefined;
    const result = adapter.writeText(text, 'clipboard');
    if (result.status === 'attempted') return { status: 'unconfirmed', backend: 'terminal' };
    if (result.status === 'local-failure') {
      return unavailable('the terminal could not queue a clipboard sequence');
    }
    return undefined;
  };

  const performWrite = async (text: string, fileFallback: boolean): Promise<CopyOutcome> => {
    if (disposed) return unavailable('the clipboard service is shut down');
    if (text === '') return unavailable('there was no text to copy');
    const native = await writeNative(text);
    if (native !== undefined && native.status === 'written') return native;
    const terminalResult = writeTerminal(text);
    if (terminalResult !== undefined && terminalResult.status === 'unconfirmed')
      return terminalResult;
    if (fileFallback) return writeFallbackFile(text);
    const detail =
      native?.status === 'unavailable'
        ? native.detail
        : terminalResult?.status === 'unavailable'
          ? terminalResult.detail
          : remote
            ? 'this session has no client-side clipboard'
            : 'no system clipboard or terminal fallback is available';
    return unavailable(detail);
  };

  return {
    writeText(text, writeOptions = {}) {
      // Serialize writes so two overlapping copies cannot land out of order: the newest
      // request is always performed and completed last.
      const run = () => performWrite(text, writeOptions.fileFallback === true);
      const next = writeChain.then(run, run);
      writeChain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },

    async read() {
      if (disposed) return { status: 'failed', detail: 'the clipboard service is shut down' };
      if (remote)
        return { status: 'unsupported', detail: 'this session has no client-side clipboard' };
      const native = ensureHost();
      if (native === null)
        return { status: 'unsupported', detail: 'no system clipboard is available' };
      try {
        const result = await native.read({
          preferredTypes: clipboardReadTypes,
          selection: 'clipboard',
        });
        switch (result.status) {
          case 'read':
            return {
              status: 'read',
              bytes: result.representation.bytes,
              mimeType: result.representation.mimeType,
            };
          case 'empty':
            return { status: 'empty' };
          case 'unsupported':
            return { status: 'unsupported', detail: 'the system clipboard cannot be read here' };
          case 'limit-exceeded':
            return { status: 'too-large', detail: 'the clipboard payload is larger than 8 MB' };
          case 'timed-out':
            return { status: 'failed', detail: 'the clipboard read timed out' };
          case 'cancelled':
            return { status: 'failed', detail: 'the clipboard read was cancelled' };
          case 'failed':
            return { status: 'failed', detail: result.error.message };
          default:
            return { status: 'failed', detail: 'the system clipboard returned an unknown result' };
        }
      } catch (error) {
        return { status: 'failed', detail: messageOf(error) };
      }
    },

    attachTerminal(adapter) {
      terminal = adapter;
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      await writeChain;
      // Only a backend that was actually opened needs shutting down.
      if (host !== undefined && host !== null) {
        try {
          await host.dispose();
        } catch {
          // A backend that cannot shut down cleanly must not block process exit.
        }
      }
    },
  };
}

/** Production clipboard: native on a local desktop, OSC 52-only across SSH/mosh. */
export function createSystemClipboard(options: {
  stateDir: string;
  pid: number;
  env: NodeJS.ProcessEnv;
}): ClipboardService {
  const remote = isRemoteSession(options.env);
  return createClipboardService({ stateDir: options.stateDir, pid: options.pid, remote });
}

function createOwnedHostClipboard(remote: boolean): HostClipboardService | null {
  if (remote) return null;
  try {
    return createHostClipboard({ timeoutMs: 1_000 });
  } catch {
    // A build without the native library, or a headless host without a clipboard service,
    // keeps OSC 52 and the explicit file fallback instead of failing startup.
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailable(detail: string): CopyOutcome {
  return { status: 'unavailable', detail };
}
