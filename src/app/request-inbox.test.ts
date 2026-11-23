import { describe, expect, test } from 'bun:test';

import type { FormRequest } from '../domain/form.ts';
import {
  type FormMergeInput,
  mergeLocationForms,
  shouldResetPermissionFocus,
  unknownLocationChildren,
} from './request-inbox.ts';

function form(id: string, sessionID: string): FormRequest {
  return { id, sessionID, title: id, fields: [] };
}

function mergeInput(overrides: Partial<FormMergeInput> = {}): FormMergeInput {
  return {
    base: [],
    locationForms: [],
    sessionID: 'attached',
    sessionFormsAuthoritative: true,
    allowed: new Set(['attached']),
    keepUnknown: new Set(),
    cachedForms: [],
    ...overrides,
  };
}

function ids(forms: readonly FormRequest[]): string[] {
  return forms.map((entry) => entry.id);
}

describe('request inbox: visibility and authority (#310)', () => {
  test('unknown children exclude global, the attached session and already allowed owners', () => {
    const locationForms = [
      form('g', 'global'),
      form('a', 'attached'),
      form('v', 'verified'),
      form('s1', 'sibling'),
      form('s2', 'sibling'),
    ];
    expect(
      unknownLocationChildren(locationForms, 'attached', new Set(['attached', 'verified'])),
    ).toEqual(['sibling']);
    expect(unknownLocationChildren(undefined, 'attached', new Set())).toEqual([]);
  });

  test('an authoritative session listing wins over a duplicate location row', () => {
    const result = mergeLocationForms(
      mergeInput({
        base: [form('a', 'attached')],
        locationForms: [form('a', 'attached'), form('g', 'global'), form('v', 'verified')],
        allowed: new Set(['attached', 'verified']),
      }),
    );
    expect(ids(result)).toEqual(['a', 'g', 'v']);
    // The base row is kept, not overwritten by the location copy.
    expect(result.find((entry) => entry.id === 'a')).toEqual(form('a', 'attached'));
  });

  test('an unknown sibling never appears, even from a fresh location snapshot', () => {
    const result = mergeLocationForms(
      mergeInput({
        locationForms: [form('s', 'sibling'), form('g', 'global')],
      }),
    );
    expect(ids(result)).toEqual(['g']);
  });

  test('a failed location listing keeps confirmed global and verified child forms', () => {
    const result = mergeLocationForms(
      mergeInput({
        locationForms: undefined,
        sessionFormsAuthoritative: false,
        allowed: new Set(['attached', 'verified']),
        cachedForms: [
          form('g', 'global'),
          form('v', 'verified'),
          form('s', 'sibling'),
          form('a', 'attached'),
        ],
      }),
    );
    expect(ids(result)).toEqual(['g', 'v']);
  });

  test('an in-flight child keeps only its previously confirmed row', () => {
    const result = mergeLocationForms(
      mergeInput({
        locationForms: [form('old', 'child'), form('new', 'child'), form('g', 'global')],
        allowed: new Set(['attached']),
        keepUnknown: new Set(['child']),
        cachedForms: [form('old', 'child')],
      }),
    );
    expect(ids(result)).toEqual(['old', 'g']);
  });

  test('an unrelated child already in base is not revived by the location snapshot', () => {
    // The controller strips unrelated rows from base before merging; the location snapshot
    // must not let them back in now that the child is no longer in the allowed scope.
    const result = mergeLocationForms(
      mergeInput({
        base: [form('a', 'attached')],
        locationForms: [form('s', 'sibling'), form('g', 'global')],
        allowed: new Set(['attached']),
      }),
    );
    expect(ids(result)).toEqual(['a', 'g']);
  });

  test('without an authoritative session listing the location snapshot supplies attached rows', () => {
    const result = mergeLocationForms(
      mergeInput({
        base: [form('old', 'attached')],
        locationForms: [form('new', 'attached')],
        sessionFormsAuthoritative: false,
      }),
    );
    expect(ids(result)).toEqual(['old', 'new']);
  });

  test('permission focus resets only for a changed, failed or empty request on the route', () => {
    const base = {
      attached: true,
      permissionsFulfilled: true,
      nextPermissionID: 'p1',
      previousPermissionID: 'p1',
    };
    expect(shouldResetPermissionFocus(base)).toBe(false);
    expect(shouldResetPermissionFocus({ ...base, nextPermissionID: 'p2' })).toBe(true);
    expect(shouldResetPermissionFocus({ ...base, permissionsFulfilled: false })).toBe(true);
    expect(shouldResetPermissionFocus({ ...base, nextPermissionID: undefined })).toBe(true);
    expect(shouldResetPermissionFocus({ ...base, attached: false })).toBe(false);
  });
});
