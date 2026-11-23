import { describe, expect, test } from 'bun:test';

import { RevisionCache } from './revision-cache.ts';

describe('revision cache (#316)', () => {
  test('reuses the value while revision, key and discriminator are unchanged', () => {
    const cache = new RevisionCache<number>();
    let computes = 0;
    const compute = (): number => {
      computes += 1;
      return computes;
    };
    expect(cache.get(1, 'local', compute)).toBe(1);
    expect(cache.get(1, 'local', compute)).toBe(1);
    expect(computes).toBe(1);
  });

  test('a new revision recomputes', () => {
    const cache = new RevisionCache<number>();
    let computes = 0;
    const compute = (): number => (computes += 1);
    expect(cache.get(1, 'local', compute)).toBe(1);
    expect(cache.get(2, 'local', compute)).toBe(2);
  });

  test('a new scope key recomputes', () => {
    const cache = new RevisionCache<string>();
    const prefix = 'scope';
    const compute = (): string => `${prefix}:${Math.random()}`;
    const local = cache.get(1, 'local', compute);
    expect(cache.get(1, 'remote', compute)).not.toBe(local);
  });

  test('the extra discriminator distinguishes otherwise identical keys', () => {
    const cache = new RevisionCache<string>();
    const prefix = 'extra';
    const compute = (): string => `${prefix}:${Math.random()}`;
    const complete = cache.get(1, 'local', compute, 'complete');
    expect(cache.get(1, 'local', compute, 'complete')).toBe(complete);
    expect(cache.get(1, 'local', compute, 'paged')).not.toBe(complete);
  });
});
