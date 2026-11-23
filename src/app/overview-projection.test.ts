import { describe, expect, test } from 'bun:test';

import type { OverviewRow, ProjectGroup } from '../domain/overview-groups.ts';
import type { OverviewTab } from '../domain/overview-tabs.ts';
import { OverviewProjection } from './overview-projection.ts';

const counts = (): Record<OverviewTab, number> => ({
  all: 1,
  local: 2,
  remotes: 3,
  active: 4,
  'needs-input': 5,
});
const groups = (): ProjectGroup[] => [];
const rows = (): OverviewRow[] => [];

function fixture() {
  let scope = 'srv';
  const projection = new OverviewProjection(() => scope);
  return { projection, setScope: (value: string) => (scope = value) };
}

describe('overview projection cache (#316)', () => {
  test('reuses each projection while the revision and scope are unchanged', () => {
    const f = fixture();
    let computes = 0;
    const compute = () => {
      computes += 1;
      return counts();
    };
    const first = f.projection.tabCounts(compute);
    const second = f.projection.tabCounts(compute);
    expect(second).toBe(first);
    expect(computes).toBe(1);
  });

  test('invalidation replaces all three projections', () => {
    const f = fixture();
    const before = {
      counts: f.projection.tabCounts(counts),
      groups: f.projection.groups(groups),
      rows: f.projection.overviewRows(false, rows),
    };
    const revision = f.projection.current();
    f.projection.invalidate();
    expect(f.projection.current()).toBe(revision + 1);
    expect(f.projection.tabCounts(counts)).not.toBe(before.counts);
    expect(f.projection.groups(groups)).not.toBe(before.groups);
    expect(f.projection.overviewRows(false, rows)).not.toBe(before.rows);
  });

  test('a scope-key change invalidates without bumping the revision', () => {
    const f = fixture();
    const before = f.projection.groups(groups);
    const revision = f.projection.current();
    f.setScope('other');
    expect(f.projection.current()).toBe(revision);
    expect(f.projection.groups(groups)).not.toBe(before);
  });

  test('pagination completeness is a separate cache discriminator for rows', () => {
    const f = fixture();
    const paged = f.projection.overviewRows(false, rows);
    expect(f.projection.overviewRows(false, rows)).toBe(paged);
    // RevisionCache is single-entry, so switching discriminator recomputes rather than
    // caching both variants at once.
    const complete = f.projection.overviewRows(true, rows);
    expect(complete).not.toBe(paged);
    expect(f.projection.overviewRows(true, rows)).toBe(complete);
  });

  test('one cache miss does not populate the others', () => {
    const f = fixture();
    let groupComputes = 0;
    const computeGroups = () => {
      groupComputes += 1;
      return groups();
    };
    f.projection.tabCounts(counts);
    expect(groupComputes).toBe(0);
    f.projection.groups(computeGroups);
    f.projection.groups(computeGroups);
    expect(groupComputes).toBe(1);
  });
});
