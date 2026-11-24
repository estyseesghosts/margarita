import { describe, expect, test } from 'bun:test';

import {
  layoutOverviewRow,
  layoutOverviewTabs,
  overviewColumnBudgets,
  overviewDotCells,
  overviewGapCells,
  overviewMarkerCells,
  padCells,
} from './overview-row-layout.ts';
import { cellWidth } from './text-width.ts';

describe('overview row fixed columns (#344)', () => {
  test('columns always total the available content width', () => {
    for (const width of [20, 30, 40, 60, 80, 120]) {
      const row = layoutOverviewRow({
        selected: false,
        dot: '●',
        title: 'a fairly long session title that should be clipped',
        status: 'interrupted · 13m',
        contentWidth: width,
      });
      expect(
        overviewMarkerCells +
          overviewDotCells +
          cellWidth(row.title) +
          overviewGapCells +
          cellWidth(row.status),
      ).toBe(width);
    }
  });

  test('title and status start at the same column for every row', () => {
    const rows = [
      { selected: true, dot: '●', title: 'short', status: 'working · 2m' },
      {
        selected: false,
        dot: '●',
        title: 'a much longer session title that wraps today',
        status: 'idle · 1m',
      },
      { selected: false, dot: '○', title: 'unknown', status: 'interrupted · 3h' },
    ].map((row) => layoutOverviewRow({ ...row, contentWidth: 40 }));
    const titleStarts = rows.map((row) => cellWidth(`${row.marker}${row.dot}`));
    const statusStarts = rows.map((row) => cellWidth(`${row.marker}${row.dot}${row.title} `));
    expect(new Set(titleStarts).size).toBe(1);
    expect(new Set(statusStarts).size).toBe(1);
  });

  test('long titles are clipped with an ellipsis and never wrap', () => {
    const title = 'Silvestris roadmap drops working · Sandcat continue working on opencode-';
    const row = layoutOverviewRow({
      selected: false,
      dot: '●',
      title,
      status: 'working · 12m',
      contentWidth: 60,
    });
    expect(row.title.endsWith('…')).toBe(true);
    expect(cellWidth(row.title)).toBe(row.titleCells);
    expect(row.title).not.toContain('\n');
  });

  test('narrow terminals shrink both budgets while keeping a usable title', () => {
    const narrow = overviewColumnBudgets(20);
    const wide = overviewColumnBudgets(80);
    expect(narrow.titleCells).toBeGreaterThan(0);
    expect(narrow.statusCells).toBeLessThan(wide.statusCells);
    expect(wide.statusCells).toBeLessThanOrEqual(22);
  });

  test('overview tabs share one fixed width and never wrap', () => {
    for (const width of [20, 40, 60, 80]) {
      const tabs = layoutOverviewTabs(
        ['[All 247]', 'Local 247', 'Remotes 0', 'Active 2', 'Needs input 0'],
        width,
      );
      expect(tabs).toHaveLength(5);
      expect(new Set(tabs.map(cellWidth)).size).toBe(1);
      expect(cellWidth(tabs.join(''))).toBeLessThanOrEqual(width);
      expect(tabs.every((tab) => !tab.includes('\n'))).toBe(true);
    }
  });

  test('wide Unicode graphemes are clipped by display cells', () => {
    const row = layoutOverviewRow({
      selected: false,
      dot: '●',
      title: '日本語の非常に長いセッションタイトル',
      status: 'idle · 5h',
      contentWidth: 30,
    });
    expect(cellWidth(row.title)).toBe(row.titleCells);
    expect(padCells('x', 4)).toBe('x   ');
  });
});
