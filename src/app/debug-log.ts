import { closeSync, fstatSync, openSync, write, writeSync } from 'node:fs';

/**
 * Opt-in diagnostics for `--debug-log <path>`. Structured NDJSON, one object per line,
 * timestamped, append-only and redacted by construction: call sites log kinds, ids,
 * counts and statuses — never prompt text, model output or tool stdout. Values that do
 * pass through are scrubbed (sensitive keys dropped, bearer tokens masked, long strings
 * truncated) as defense in depth.
 *
 * Writes are buffered off the synchronous interactive path: a bounded queue is flushed in
 * batches through the asynchronous filesystem API. Shutdown drains explicitly; crash paths
 * may use one last best-effort synchronous write.
 */
export type DebugLog = Readonly<{
  readonly enabled: boolean;
  write(kind: string, fields?: Record<string, unknown>): void;
  close(): void;
}>;

/** Discard logger used when the flag is absent; creates nothing, ever. */
export const noDebugLog: DebugLog = Object.freeze({
  enabled: false,
  write: () => {},
  close: () => {},
});

const sensitiveKey =
  /(authorization|proxy-authorization|password|passwd|secret|token|cookie|credential|api[-_]?key)/i;
const bearerPattern = /(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const maxStringLength = 300;
const maxDepth = 4;
const maxArrayLength = 50;
/** Bounds memory if a pathological caller emits diagnostics faster than the disk accepts. */
const maxQueuedLines = 512;
const flushBatchLines = 64;

function scrubString(value: string): string {
  const masked = value.replace(bearerPattern, '$1 [redacted]');
  if (masked.length <= maxStringLength) return masked;
  return `${masked.slice(0, maxStringLength)}…[truncated ${masked.length} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scrubValue(key: string | undefined, value: unknown, depth: number): unknown {
  if (key !== undefined && sensitiveKey.test(key)) return '[redacted]';
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  if (depth >= maxDepth) return '[deep]';
  if (Array.isArray(value)) {
    return value
      .slice(0, maxArrayLength)
      .map((entry) => scrubValue(undefined, entry, depth + 1) ?? null);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const scrubbed = scrubValue(childKey, childValue, depth + 1);
      if (scrubbed !== undefined) out[childKey] = scrubbed;
    }
    return out;
  }
  // Functions, symbols and bigints carry no diagnosable content worth stringifying.
  return `[${typeof value}]`;
}

function scrubFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const scrubbed = scrubValue(key, value, 0);
    if (scrubbed !== undefined) out[key] = scrubbed;
  }
  return out;
}

class FileDebugLog implements DebugLog {
  readonly enabled = true;
  private fd: number | undefined;
  private failed = false;
  private readonly queue: string[] = [];
  private dropped = 0;
  private scheduled = false;
  private inFlight: string | undefined;
  private generation = 0;

  constructor(fd: number) {
    this.fd = fd;
  }

  write(kind: string, fields?: Record<string, unknown>): void {
    const fd = this.fd;
    if (fd === undefined || this.failed) return;
    let line: string;
    try {
      const entry = {
        ts: new Date().toISOString(),
        kind,
        ...(fields === undefined ? {} : scrubFields(fields)),
      };
      line = `${JSON.stringify(entry)}\n`;
    } catch {
      line = `${JSON.stringify({ ts: new Date().toISOString(), kind, error: 'unserializable' })}\n`;
    }
    if (this.queue.length >= maxQueuedLines) {
      this.dropped += 1;
      return;
    }
    this.queue.push(line);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.scheduled || this.failed) return;
    const fd = this.fd;
    if (fd === undefined) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.flush(fd);
    });
  }

  private async flush(fd: number): Promise<void> {
    if (this.failed || this.fd === undefined || this.inFlight !== undefined) return;
    const batch = this.queue.splice(0, flushBatchLines).join('');
    if (batch === '') return;
    const generation = ++this.generation;
    this.inFlight = batch;
    const dropped = this.dropped;
    this.dropped = 0;
    await new Promise<void>((resolve) => {
      write(fd, batch, (error) => {
        // A concurrent close may drain and close this batch; never write it twice.
        if (this.generation === generation) {
          this.inFlight = undefined;
          if (error !== undefined) this.fail(error);
          if (dropped > 0 && !this.failed) this.queue.push(this.droppedLine(dropped));
        }
        resolve();
      });
    });
    if (!this.failed) this.scheduleFlush();
  }

  private droppedLine(count: number): string {
    return `${JSON.stringify({
      ts: new Date().toISOString(),
      kind: 'debug-log-dropped',
      count,
    })}\n`;
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.queue.length = 0;
    process.stderr.write(
      `marg: --debug-log write failed and diagnostics are disabled: ${errorMessage(error)}\n`,
    );
  }

  close(): void {
    const fd = this.fd;
    if (fd === undefined) return;
    this.fd = undefined;
    this.generation += 1;
    // Shutdown is not an interactive hot path: drain synchronously, including a batch that
    // was about to be written asynchronously, so no accepted record is lost.
    let pending = this.inFlight ?? this.queue.join('');
    if (this.dropped > 0) pending += this.droppedLine(this.dropped);
    this.dropped = 0;
    this.inFlight = undefined;
    this.queue.length = 0;
    if (pending !== '') {
      try {
        writeSync(fd, pending);
      } catch (error) {
        process.stderr.write(`marg: --debug-log close failed: ${errorMessage(error)}\n`);
      }
    }
    try {
      closeSync(fd);
    } catch {
      // Nothing useful left to do; refusing to write diagnostics must not crash the app.
    }
  }
}

export type CreateDebugLogResult = { ok: true; log: DebugLog } | { ok: false; message: string };

/**
 * Opens (creating if needed) the log for appending. A bad path is a startup error with a
 * clear message, not a silently missing file.
 */
export function createDebugLog(path: string): CreateDebugLogResult {
  let fd: number;
  try {
    fd = openSync(path, 'a');
    // Windows opens directories for append without erroring; reject them here.
    if (fstatSync(fd).isDirectory()) {
      closeSync(fd);
      return { ok: false, message: `--debug-log ${path} is a directory` };
    }
  } catch (error) {
    return { ok: false, message: `cannot append to --debug-log ${path}: ${errorMessage(error)}` };
  }
  return { ok: true, log: new FileDebugLog(fd) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
