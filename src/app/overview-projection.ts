/**
 * Single owner of the memoized overview projections (#316, first slice).
 *
 * The tab counts, grouped sessions and flattened navigation rows are expensive derived views.
 * They are reused until an explicit invalidation or a change in the host-health scope key.
 * Reading the revision signal inside each selector makes a mounted observer subscribe to
 * invalidation itself, so a store write cannot repaint a stale projection. Callers batch the
 * invalidation with the store write that caused it (#293); this module owns no store writes.
 */
import { createSignal } from 'solid-js';

import type { OverviewRow, ProjectGroup } from '../domain/overview-groups.ts';
import type { OverviewTab } from '../domain/overview-tabs.ts';
import { RevisionCache } from './revision-cache.ts';

/** Owns the revision clock and the three single-entry overview caches. */
export class OverviewProjection {
  private readonly revision = createSignal(0);
  private readonly groupsCache = new RevisionCache<ProjectGroup[]>();
  private readonly rowsCache = new RevisionCache<OverviewRow[]>();
  private readonly tabCountsCache = new RevisionCache<Record<OverviewTab, number>>();

  constructor(private readonly scopeKey: () => string) {}

  /** Advances the reactive invalidation clock. Batch with the triggering store write (#293). */
  invalidate(): void {
    this.revision[1]((value) => value + 1);
  }

  /** Current revision; reading it makes a mounted observer depend on invalidation. */
  current(): number {
    return this.revision[0]();
  }

  tabCounts(compute: () => Record<OverviewTab, number>): Record<OverviewTab, number> {
    return this.tabCountsCache.get(this.current(), this.scopeKey(), compute);
  }

  groups(compute: () => ProjectGroup[]): ProjectGroup[] {
    return this.groupsCache.get(this.current(), this.scopeKey(), compute);
  }

  overviewRows(complete: boolean, compute: () => OverviewRow[]): OverviewRow[] {
    return this.rowsCache.get(
      this.current(),
      this.scopeKey(),
      compute,
      complete ? 'complete' : 'paged',
    );
  }
}
