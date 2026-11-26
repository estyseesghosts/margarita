/**
 * Single owner of the memoized overview projections (#316, first slice).
 *
 * The tab counts, grouped sessions, flattened navigation rows and row-key index are
 * expensive derived views. Each has its own invalidation lane so a purely presentational
 * project-window move cannot regroup or recount the session index. Reading the revision
 * signal inside each selector makes a mounted observer subscribe to invalidation itself,
 * so a store write cannot repaint a stale projection. Callers batch invalidation with the
 * store write that caused it (#293); this module owns no store writes.
 */
import { createSignal } from 'solid-js';

import type { OverviewRow, ProjectGroup } from '../domain/overview-groups.ts';
import type { OverviewTab } from '../domain/overview-tabs.ts';
import { RevisionCache } from './revision-cache.ts';

/** Owns separate revisions for status data, grouping and row-window presentation. */
export class OverviewProjection {
  private readonly statusRevision = createSignal(0);
  private readonly groupingRevision = createSignal(0);
  private readonly rowRevision = createSignal(0);
  private readonly groupsCache = new RevisionCache<ProjectGroup[]>();
  private readonly rowsCache = new RevisionCache<OverviewRow[]>();
  private readonly tabCountsCache = new RevisionCache<Record<OverviewTab, number>>();
  private indexedRows: readonly OverviewRow[] | undefined;
  private rowIndex: ReadonlyMap<string, OverviewRow> | undefined;
  private rowPositions: ReadonlyMap<string, number> | undefined;

  constructor(private readonly scopeKey: () => string) {}

  /** Full invalidation: session/status inputs can change counts, groups and rows at once. */
  invalidate(): void {
    this.statusRevision[1]((value) => value + 1);
    this.groupingRevision[1]((value) => value + 1);
    this.rowRevision[1]((value) => value + 1);
  }

  /** Alias for data changes, so ownership is explicit at call sites. */
  invalidateSessions(): void {
    this.invalidate();
  }

  /** Status changes affect classification-dependent counts and filtering. */
  invalidateStatuses(): void {
    this.invalidate();
  }

  /** Grouping/filtering inputs changed; rebuild groups and the rows derived from them. */
  invalidateGrouping(): void {
    this.groupingRevision[1]((value) => value + 1);
    this.rowRevision[1]((value) => value + 1);
  }

  /** Only row presentation changed (a project window moved); keep counts and groups. */
  invalidateRowWindow(): void {
    this.rowRevision[1]((value) => value + 1);
  }

  /** Current status revision; reading it makes a mounted observer depend on invalidation. */
  current(): number {
    return this.statusRevision[0]();
  }

  tabCounts(compute: () => Record<OverviewTab, number>): Record<OverviewTab, number> {
    return this.tabCountsCache.get(this.statusRevision[0](), this.scopeKey(), compute);
  }

  groups(compute: () => ProjectGroup[]): ProjectGroup[] {
    return this.groupsCache.get(this.groupingRevision[0](), this.scopeKey(), compute);
  }

  overviewRows(complete: boolean, compute: () => OverviewRow[]): OverviewRow[] {
    const rows = this.rowsCache.get(
      this.groupingRevision[0](),
      this.scopeKey(),
      compute,
      `${complete ? 'complete' : 'paged'}:${this.rowRevision[0]()}`,
    );
    if (rows !== this.indexedRows) {
      this.indexedRows = rows;
      this.rowIndex = new Map(rows.map((row) => [row.key, row]));
      this.rowPositions = new Map(rows.map((row, index) => [row.key, index]));
    }
    return rows;
  }

  /** Direct row lookup for selection and activation. */
  rowByKey(key: string): OverviewRow | undefined {
    return this.rowIndex?.get(key);
  }

  /** Direct row position for keyboard navigation. */
  rowPosition(key: string): number | undefined {
    return this.rowPositions?.get(key);
  }
}
