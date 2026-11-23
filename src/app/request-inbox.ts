/**
 * Pure visibility and authority rules for the request inbox (#310, first slice).
 *
 * A question belongs to the viewed conversation only when it is the global sentinel, the
 * attached session itself, or a server-verified descendant. An unknown sibling must never
 * leak, and a failed listing must never make an already confirmed question disappear. These
 * rules depend only on explicit inputs; transport, timers and the reactive store stay with
 * the controller, which executes the decisions this module returns.
 */
import type { FormRequest } from '../domain/form.ts';

/** Inputs for merging the location snapshot into one conversation's form bucket. */
export interface FormMergeInput {
  /** Forms already authoritative from the attached session's own listing. */
  readonly base: readonly FormRequest[];
  /** Location-directory forms; undefined means that listing failed. */
  readonly locationForms: readonly FormRequest[] | undefined;
  readonly sessionID: string;
  /** True when the session listing succeeded and is authoritative for attached rows. */
  readonly sessionFormsAuthoritative: boolean;
  /** Attached session plus server-verified descendants. */
  readonly allowed: ReadonlySet<string>;
  /** Children whose previous confirmed rows are retained during in-flight verification. */
  readonly keepUnknown: ReadonlySet<string>;
  /** Previously displayed forms, used only to retain confirmed or location-owned rows. */
  readonly cachedForms: readonly FormRequest[];
}

/** Inputs for the deliberate permission-focus rule. */
export interface PermissionFocusInput {
  /** Whether the route still names the session that owns the request. */
  readonly attached: boolean;
  /** Whether the permission listing succeeded. */
  readonly permissionsFulfilled: boolean;
  readonly nextPermissionID: string | undefined;
  readonly previousPermissionID: string | undefined;
}

/** Distinct location-form owners outside the attached session and its verified scope. */
export function unknownLocationChildren(
  locationForms: readonly FormRequest[] | undefined,
  sessionID: string,
  allowed: ReadonlySet<string>,
): string[] {
  if (locationForms === undefined) return [];
  const unknown = new Set<string>();
  for (const form of locationForms) {
    const childID = form.sessionID;
    if (childID === 'global' || childID === sessionID || allowed.has(childID)) continue;
    unknown.add(childID);
  }
  return [...unknown];
}

/**
 * The location forms this conversation may display. A successful session listing is
 * authoritative for its own rows; the global sentinel and verified descendants may be
 * merged from the location snapshot. `keepUnknown` retains a child's previously confirmed
 * row while a new ownership check is in flight, never a new one (#294).
 */
export function mergeLocationForms(input: FormMergeInput): FormRequest[] {
  const {
    base,
    locationForms,
    sessionID,
    sessionFormsAuthoritative,
    allowed,
    keepUnknown,
    cachedForms,
  } = input;
  const merged = new Map(base.map((form) => [form.id, form]));
  for (const form of cachedForms) {
    if (keepUnknown.has(form.sessionID) && !merged.has(form.id)) merged.set(form.id, form);
  }
  if (locationForms === undefined) {
    for (const form of cachedForms) {
      const locationOwned =
        form.sessionID === 'global' ||
        (form.sessionID !== sessionID && allowed.has(form.sessionID));
      if (locationOwned && !merged.has(form.id)) merged.set(form.id, form);
    }
    return [...merged.values()];
  }
  for (const form of locationForms) {
    // With a successful session listing, that route is authoritative for the attached
    // session; merging the same forms again could revive one it just removed. When the
    // session route failed, the location snapshot is the only available source (#258).
    if (form.sessionID === sessionID && sessionFormsAuthoritative) continue;
    if (
      form.sessionID !== 'global' &&
      form.sessionID !== sessionID &&
      !allowed.has(form.sessionID)
    ) {
      continue;
    }
    // With an authoritative session listing, a duplicate location entry must not overwrite
    // it. Without one, the location snapshot is the only live source.
    if (sessionFormsAuthoritative && merged.has(form.id)) continue;
    merged.set(form.id, form);
  }
  return [...merged.values()];
}

/** Deliberate focus survives only an unchanged, successfully listed request on this route. */
export function shouldResetPermissionFocus(input: PermissionFocusInput): boolean {
  return (
    input.attached &&
    (!input.permissionsFulfilled ||
      input.nextPermissionID === undefined ||
      input.nextPermissionID !== input.previousPermissionID)
  );
}
