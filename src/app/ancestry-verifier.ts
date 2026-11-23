/**
 * Bounded, time-limited ancestry verification for uncached child questions (#310).
 *
 * This service owns the verified-child evidence cache and the in-flight walk deduplication.
 * Every external dependency — backend lookup, local index, session lifetimes, clock and
 * timeouts — is an explicit port supplied by the owning controller, so the whole ownership
 * decision (including stalls, cycles, depth caps and stale results) can be tested with
 * deterministic fakes. It never writes the reactive store or selects navigation.
 *
 * OpenCode v2 exposes an AbortSignal only for `events`, not for `getSession`. A stalled
 * ancestry read therefore cannot be canceled on the wire (#332); instead a retired walk is
 * checked before every hop and after every await so it issues no further RPCs, and the
 * number of logically outstanding reads is capped so repeated retries cannot accumulate
 * unbounded backend work. A retired read releases its logical slot immediately, so a
 * recovered backend can issue a fresh request.
 */
import type { Backend } from '../adapter/backend.ts';
import type { SessionSummary } from '../domain/session.ts';
import type { VerifiedDescendant } from './descendant-scope.ts';
import { errorText } from './error-text.ts';

/** Outcome of walking authoritative parent links for one uncached child question (#274). */
export type DescendantCheck =
  | Readonly<{ status: 'verified' }>
  | Readonly<{ status: 'unrelated' }>
  | Readonly<{ status: 'unresolved'; error: string }>;

/** Freshness inputs for a walk that is already in progress. */
export interface AncestryCurrentInput {
  readonly serverID: string;
  readonly backend: Backend;
  readonly childKey: string;
  readonly ancestorKey: string;
  readonly childEpoch: number;
  readonly ancestorEpoch: number;
}

/** Everything the verifier needs from the controller, as explicit ports. */
export interface AncestryVerifierDeps {
  readonly backendFor: (serverID: string) => Backend;
  readonly isRegistered: (serverID: string, backend: Backend) => boolean;
  readonly getSession: (backend: Backend, sessionID: string) => Promise<SessionSummary>;
  readonly keyFor: (serverID: string, sessionID: string) => string;
  readonly sessionEpoch: (key: string) => number;
  readonly localSummary: (key: string) => SessionSummary | undefined;
  readonly isSessionCurrent: (key: string, epoch: number) => boolean;
  readonly now: () => number;
  readonly withTimeout: (
    check: Promise<DescendantCheck>,
    timeoutMs: number,
  ) => Promise<DescendantCheck>;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly budgetMs: number;
  /** Cap on logically outstanding noncancelable reads across all retry attempts (#332). */
  readonly maxOutstandingReads?: number;
}

/** Classified results of one bounded verification phase. */
export interface DescendantVerification {
  readonly verified: Set<string>;
  readonly unrelated: Set<string>;
  readonly pending: Set<string>;
  readonly error?: string;
}

/** One deduplicated walk; its token lets retirement ignore a late completion. */
interface AncestryLookup {
  readonly token: number;
  readonly childKey: string;
  readonly ancestorKey: string;
  readonly serverID: string;
  readonly promise: Promise<DescendantCheck>;
}

/** A read whose slot is reserved until it settles or its flight is retired. */
interface TrackedRead {
  readonly token: number;
  released: boolean;
}

const defaultMaxOutstandingReads = 8;

/** A retired walk is unresolved, never a definitive "unrelated" verdict (#332). */
const retiredCheck: DescendantCheck = {
  status: 'unresolved',
  error: 'the ownership check was retired',
};

/** Owns ancestry evidence and the bounded verification of unknown child owners. */
export class AncestryVerifier {
  private readonly evidenceByKey = new Map<string, VerifiedDescendant>();
  private readonly serverByKey = new Map<string, string>();
  private readonly lookups = new Map<string, AncestryLookup>();
  private readonly activeReads = new Set<TrackedRead>();
  private readonly readWaiters: Array<() => void> = [];
  private nextToken = 1;

  constructor(private readonly deps: AncestryVerifierDeps) {}

  /** Read-only evidence for the pure descendantScope rule. */
  evidence(): ReadonlyMap<string, VerifiedDescendant> {
    return this.evidenceByKey;
  }

  /** Logically outstanding reads, exposed for bounded-work assertions in tests (#332). */
  outstandingReads(): number {
    return this.activeReads.size;
  }

  /** Drops one session's evidence and pending walks after deletion or ID reuse. */
  forgetSession(key: string): void {
    this.evidenceByKey.delete(key);
    this.serverByKey.delete(key);
    for (const [lookupKey, lookup] of this.lookups) {
      if (lookup.childKey === key || lookup.ancestorKey === key) {
        this.retireLookup(lookupKey, lookup.token);
      }
    }
  }

  /** Drops every cached relationship and pending walk belonging to an unpaired host. */
  forgetServer(serverID: string): void {
    for (const [key, owner] of this.serverByKey) {
      if (owner === serverID) {
        this.evidenceByKey.delete(key);
        this.serverByKey.delete(key);
      }
    }
    for (const [lookupKey, lookup] of this.lookups) {
      if (lookup.serverID === serverID) this.retireLookup(lookupKey, lookup.token);
    }
  }

  /** Clears all owned walks, reads and evidence; late completions become inert (#332). */
  dispose(): void {
    this.lookups.clear();
    this.evidenceByKey.clear();
    this.serverByKey.clear();
    for (const read of this.activeReads) this.releaseRead(read);
    this.activeReads.clear();
    this.readWaiters.length = 0;
  }

  /** Removes a lookup only while it is still the flight that created it. */
  private retireLookup(lookupKey: string, token: number): void {
    if (this.lookups.get(lookupKey)?.token !== token) return;
    this.lookups.delete(lookupKey);
    // The wire request may still be pending, but its flight is over: free its logical slot
    // so a recovered backend can retry instead of queuing behind an abandoned read (#332).
    for (const read of this.activeReads) {
      if (read.token === token) this.releaseRead(read);
    }
  }

  private releaseRead(read: TrackedRead): void {
    if (read.released) return;
    read.released = true;
    this.activeReads.delete(read);
    this.readWaiters.shift()?.();
  }

  /** Bounded, retirement-aware read: retired flights release their slot immediately. */
  private async boundedGetSession(
    token: number,
    backend: Backend,
    sessionID: string,
    isRetired: () => boolean,
  ): Promise<SessionSummary> {
    const cap = this.deps.maxOutstandingReads ?? defaultMaxOutstandingReads;
    while (this.activeReads.size >= cap) {
      await new Promise<void>((resolve) => this.readWaiters.push(resolve));
      // A flight retired while queued for a slot must not start a late RPC (#332).
      if (isRetired()) {
        this.readWaiters.shift()?.();
        throw new Error('the ownership check was retired');
      }
    }
    if (isRetired()) throw new Error('the ownership check was retired');
    const tracked: TrackedRead = { token, released: false };
    this.activeReads.add(tracked);
    let read: Promise<SessionSummary>;
    try {
      read = this.deps.getSession(backend, sessionID);
    } catch (error) {
      this.releaseRead(tracked);
      throw error;
    }
    return read.then(
      (value) => {
        this.releaseRead(tracked);
        return value;
      },
      (error: unknown) => {
        this.releaseRead(tracked);
        throw error;
      },
    );
  }

  /** Verifies one child, reusing lifetime-matched evidence and deduplicating concurrent walks. */
  verifyDescendant(
    childID: string,
    ancestorID: string,
    serverID: string,
  ): Promise<DescendantCheck> {
    const { keyFor, sessionEpoch } = this.deps;
    const childKey = keyFor(serverID, childID);
    const ancestorKey = keyFor(serverID, ancestorID);
    const childEpoch = sessionEpoch(childKey);
    const ancestorEpoch = sessionEpoch(ancestorKey);
    const cached = this.evidenceByKey.get(childKey);
    if (
      cached !== undefined &&
      cached.ancestor === ancestorID &&
      cached.childEpoch === childEpoch &&
      cached.ancestorEpoch === ancestorEpoch
    ) {
      return Promise.resolve({ status: 'verified' });
    }
    const lookupKey = `${childKey}|${ancestorKey}|${childEpoch}|${ancestorEpoch}`;
    const existing = this.lookups.get(lookupKey);
    if (existing !== undefined) return existing.promise;
    const token = this.nextToken;
    this.nextToken += 1;
    // The walk starts synchronously, before the lookup is registered. Treat "not yet
    // registered" as current so its first hop is not mistaken for a retired flight.
    let registered = false;
    const isRetired = (): boolean => registered && this.lookups.get(lookupKey)?.token !== token;
    const walk = this.walkAncestry(
      childID,
      ancestorID,
      serverID,
      childKey,
      childEpoch,
      ancestorEpoch,
      token,
      isRetired,
    ).then((result): DescendantCheck => {
      // A retired or replaced walk may not publish evidence or clear newer state (#332).
      if (this.lookups.get(lookupKey)?.token !== token) {
        return { status: 'unresolved', error: 'the ownership check was retired' };
      }
      if (result.status === 'verified') {
        this.evidenceByKey.set(childKey, { ancestor: ancestorID, childEpoch, ancestorEpoch });
        this.serverByKey.set(childKey, serverID);
      }
      return result;
    });
    // The deadline is part of the deduplicated flight: when it wins, the lookup is
    // retired at once so a recovered backend can be retried instead of reusing a
    // promise that can never settle (#332).
    const promise = this.deps.withTimeout(walk, this.deps.timeoutMs).finally(() => {
      this.retireLookup(lookupKey, token);
    });
    this.lookups.set(lookupKey, { token, childKey, ancestorKey, serverID, promise });
    registered = true;
    return promise;
  }

  private async walkAncestry(
    childID: string,
    ancestorID: string,
    serverID: string,
    childKey: string,
    childEpoch: number,
    ancestorEpoch: number,
    token: number,
    isRetired: () => boolean,
  ): Promise<DescendantCheck> {
    const { backendFor, isRegistered, keyFor, localSummary, isSessionCurrent } = this.deps;
    const backend = backendFor(serverID);
    const ancestorKey = keyFor(serverID, ancestorID);
    const stillCurrent = (): boolean =>
      !isRetired() &&
      isRegistered(serverID, backend) &&
      isSessionCurrent(childKey, childEpoch) &&
      isSessionCurrent(ancestorKey, ancestorEpoch);
    const seen = new Set<string>();
    let current = childID;
    for (let depth = 0; depth < 32; depth += 1) {
      // A retired walk must never begin another ancestor RPC, even when an earlier pending
      // request resolves after the deadline or teardown (#332).
      if (isRetired()) return retiredCheck;
      if (seen.has(current)) {
        return { status: 'unresolved', error: 'the session ancestry contains a cycle' };
      }
      seen.add(current);
      let parentID: string | undefined;
      try {
        const currentKey = keyFor(serverID, current);
        // The child itself may still be absent from the index; parents are usually cached.
        const summary =
          localSummary(currentKey) ??
          (await this.boundedGetSession(token, backend, current, isRetired));
        if (isRetired()) return retiredCheck;
        if (!stillCurrent()) {
          return { status: 'unresolved', error: 'the session lifetime changed during lookup' };
        }
        parentID = summary.parentID;
      } catch (error) {
        return { status: 'unresolved', error: errorText(error) };
      }
      if (parentID === undefined) return { status: 'unrelated' };
      if (parentID === ancestorID) return { status: 'verified' };
      current = parentID;
    }
    return { status: 'unresolved', error: 'the session ancestry is too deep' };
  }

  /**
   * Checks each unknown child at most once within a global deadline. A stalled or deep chain
   * becomes `pending` — visible, retryable, never cleared — instead of blocking the refresh.
   */
  async verifyUnknownDescendants(
    childIDs: readonly string[],
    ancestorID: string,
    serverID: string,
  ): Promise<DescendantVerification> {
    const verified = new Set<string>();
    const unrelated = new Set<string>();
    const pending = new Set<string>();
    let error: string | undefined;
    const deadline = this.deps.now() + this.deps.budgetMs;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < childIDs.length) {
        const childID = childIDs[next];
        next += 1;
        if (childID === undefined) continue;
        if (this.deps.now() >= deadline) {
          pending.add(childID);
          error ??= 'ownership verification ran out of time';
          continue;
        }
        const result = await this.verifyDescendant(childID, ancestorID, serverID).catch(
          (cause: unknown): DescendantCheck => ({
            status: 'unresolved',
            error: errorText(cause),
          }),
        );
        if (result.status === 'verified') verified.add(childID);
        else if (result.status === 'unrelated') unrelated.add(childID);
        else {
          pending.add(childID);
          error ??= result.error;
        }
      }
    };
    const workers = Math.min(this.deps.concurrency, childIDs.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return { verified, unrelated, pending, ...(error === undefined ? {} : { error }) };
  }
}
