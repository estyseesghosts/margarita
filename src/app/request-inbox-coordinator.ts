/**
 * Bounded request-inbox refresh coordinator (#310).
 *
 * Owns the monotonic refresh revision, the per-key revision map and the two publication
 * phases of one request refresh. Independent endpoint reads, freshness checks, error
 * assembly and both merges happen here; the controller only executes the returned commands
 * in the two batches they belong to. The generator boundary is intentional: authoritative
 * results must be published before the ancestry verification await (#294), and a later
 * response may only publish if it still owns the session, backend and revision.
 */
import type { Backend } from '../adapter/backend.ts';
import type { PermissionPrompt } from '../adapter/wire-mapping.ts';
import type { FormRequest } from '../domain/form.ts';
import { strings } from '../i18n/index.ts';
import type { DescendantVerification } from './ancestry-verifier.ts';
import {
  mergeLocationForms,
  shouldResetPermissionFocus,
  unknownLocationChildren,
} from './request-inbox.ts';

/** One endpoint's settled result; a rejected endpoint is never confirmed-empty. */
export type RequestRead<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown };

/** The three independently settled reads of one refresh. */
export interface RequestReads {
  readonly permissions: RequestRead<PermissionPrompt[]>;
  readonly forms: RequestRead<FormRequest[]>;
  readonly locationForms: RequestRead<FormRequest[]>;
}

/** Partial-failure record; absence of a key means both categories are known. */
export interface RequestErrors {
  permissions?: string;
  forms?: string;
}

/** One store effect the facade must execute inside the batch it arrived in. */
export type RequestInboxCommand =
  | { kind: 'set-permissions'; key: string; value: PermissionPrompt[] }
  | { kind: 'set-forms'; key: string; value: FormRequest[] }
  | { kind: 'set-request-errors'; key: string; value: RequestErrors | undefined }
  | { kind: 'reset-permission-focus' };

/** Everything the coordinator needs from its host, as explicit ports. */
export interface RequestInboxCoordinatorDeps {
  /** Performs all three reads in one all-settled group so no endpoint blocks another (#214). */
  readonly readRequests: (
    sessionID: string,
    directory: string | undefined,
    backend: Backend,
  ) => Promise<RequestReads>;
  readonly backendFor: (serverID: string) => Backend;
  readonly keyFor: (serverID: string, sessionID: string) => string;
  readonly sessionEpoch: (key: string) => number;
  readonly isSessionCurrent: (key: string, epoch: number) => boolean;
  readonly isRegisteredBackend: (serverID: string, backend: Backend) => boolean;
  readonly directoryOf: (key: string) => string | undefined;
  readonly previousPermissionIDOf: (key: string) => string | undefined;
  readonly cachedFormsOf: (key: string) => readonly FormRequest[];
  /** Read after the first await and compared to the captured origin, never used to reselect. */
  readonly attachedRoute: () => { serverID: string; sessionID: string } | undefined;
  /** Fresh mutable scope for this refresh; the coordinator may extend it after verification. */
  readonly scope: (sessionID: string, serverID: string) => Set<string>;
  readonly describeError: (reason: unknown) => string;
  readonly verify: (
    children: readonly string[],
    ancestorID: string,
    serverID: string,
  ) => Promise<DescendantVerification>;
}

/** Converts a partial-failure record to the delete-or-replace value the store expects. */
export function requestErrorsValue(errors: RequestErrors): RequestErrors | undefined {
  return Object.keys(errors).length === 0 ? undefined : errors;
}

/** Owns refresh revisions and the ordered store effects of one request refresh. */
export class RequestInboxCoordinator {
  private revision = 0;
  private readonly revisions = new Map<string, { revision: number; serverID: string }>();

  constructor(private readonly deps: RequestInboxCoordinatorDeps) {}

  /** Drops the revision record for one deleted session. */
  forgetSession(key: string): void {
    this.revisions.delete(key);
  }

  /** Drops every revision record belonging to an unpaired host. */
  forgetServer(serverID: string): void {
    for (const [key, entry] of this.revisions) {
      if (entry.serverID === serverID) this.revisions.delete(key);
    }
  }

  /**
   * Yields the authoritative publication batch, then — only if unknown children exist and
   * the refresh is still current — a second batch after bounded ancestry verification.
   */
  async *refresh(
    sessionID: string,
    serverID: string,
  ): AsyncGenerator<readonly RequestInboxCommand[], void, void> {
    const d = this.deps;
    const backend = d.backendFor(serverID);
    const key = d.keyFor(serverID, sessionID);
    const epoch = d.sessionEpoch(key);
    const next = ++this.revision;
    this.revisions.set(key, { revision: next, serverID });
    const directory = d.directoryOf(key);
    const previousPermissionID = d.previousPermissionIDOf(key);

    const reads = await d.readRequests(sessionID, directory, backend);
    if (this.revisions.get(key)?.revision !== next) return;
    if (!d.isSessionCurrent(key, epoch)) return;
    if (!d.isRegisteredBackend(serverID, backend)) return;

    const errors: RequestErrors = {};
    if (reads.permissions.status === 'rejected') {
      errors.permissions = d.describeError(reads.permissions.reason);
    }
    const sessionForms = reads.forms.status === 'fulfilled' ? reads.forms.value : undefined;
    if (reads.forms.status === 'rejected') errors.forms = d.describeError(reads.forms.reason);
    const locationForms =
      reads.locationForms.status === 'fulfilled' ? reads.locationForms.value : undefined;
    if (reads.locationForms.status === 'rejected') {
      errors.forms ??= d.describeError(reads.locationForms.reason);
    }
    const cachedForms = d.cachedFormsOf(key);
    const allowed = d.scope(sessionID, serverID);
    const authoritative = sessionForms !== undefined;
    const unknownChildren = unknownLocationChildren(locationForms, sessionID, allowed);
    let forms = sessionForms ?? cachedForms.filter((form) => form.sessionID === sessionID);

    forms = mergeLocationForms({
      base: forms,
      locationForms,
      sessionID,
      sessionFormsAuthoritative: authoritative,
      allowed,
      keepUnknown: new Set(unknownChildren),
      cachedForms,
    });

    const attached = d.attachedRoute();
    const nextPermissionID =
      reads.permissions.status === 'fulfilled' ? reads.permissions.value[0]?.id : undefined;
    const first: RequestInboxCommand[] = [];
    if (reads.permissions.status === 'fulfilled') {
      first.push({ kind: 'set-permissions', key, value: reads.permissions.value });
    }
    first.push({ kind: 'set-forms', key, value: forms });
    first.push({ kind: 'set-request-errors', key, value: requestErrorsValue(errors) });
    if (
      shouldResetPermissionFocus({
        attached:
          attached !== undefined &&
          attached.serverID === serverID &&
          attached.sessionID === sessionID,
        permissionsFulfilled: reads.permissions.status === 'fulfilled',
        nextPermissionID,
        previousPermissionID,
      })
    ) {
      first.push({ kind: 'reset-permission-focus' });
    }
    yield first;

    if (unknownChildren.length === 0) return;
    const checked = await d.verify(unknownChildren, sessionID, serverID);
    if (
      this.revisions.get(key)?.revision !== next ||
      !d.isSessionCurrent(key, epoch) ||
      !d.isRegisteredBackend(serverID, backend)
    ) {
      return;
    }
    for (const childID of checked.verified) allowed.add(childID);
    for (const childID of checked.unrelated) allowed.delete(childID);
    const merged = mergeLocationForms({
      base: forms.filter((form) => !checked.unrelated.has(form.sessionID)),
      locationForms,
      sessionID,
      sessionFormsAuthoritative: authoritative,
      allowed,
      keepUnknown: new Set(checked.pending),
      cachedForms,
    });
    const finalErrors: RequestErrors = { ...errors };
    if (checked.error !== undefined) {
      finalErrors.forms ??= strings.notices.forms.childOwnerFailed(checked.error);
    }
    yield [
      { kind: 'set-forms', key, value: merged },
      { kind: 'set-request-errors', key, value: requestErrorsValue(finalErrors) },
    ];
  }
}
