import { describe, expect, test } from 'bun:test';

import {
  layoutOverviewRow,
  layoutOverviewTabs,
  overviewColumnBudgets,
  overviewDotCells,
  overviewGapCells,
  overviewMarkerCells,
  padCells,
  wrapOverviewTitle,
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

  test('long titles use at most two word-wrapped lines with an ellipsis only when omitted', () => {
    const title = 'Silvestris roadmap drops working · Sandcat continue working on opencode-';
    const row = layoutOverviewRow({
      selected: false,
      dot: '●',
      title,
      status: 'working · 12m',
      contentWidth: 60,
    });
    expect(row.titleLines.length).toBeLessThanOrEqual(2);
    for (const line of row.titleLines) {
      expect(cellWidth(line)).toBe(row.titleCells);
      expect(line).not.toContain('\n');
    }
    expect(row.titleLines.at(-1)?.trimEnd().endsWith('…')).toBe(true);
  });

  test('word-boundary wrapping keeps whole words and never emits a third line', () => {
    const lines = wrapOverviewTitle('alpha beta gamma delta epsilon zeta', 12);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('alpha beta');
    expect(lines[1]).toBe('gamma delta…');
    expect(wrapOverviewTitle('exactlyfitting', 20)).toEqual(['exactlyfitting']);
    expect(wrapOverviewTitle('a very long title clipping', 8)).toHaveLength(2);
  });

  test('narrow terminals shrink both budgets while keeping a usable title', () => {
    const narrow = overviewColumnBudgets(20);
    const wide = overviewColumnBudgets(80);
    expect(narrow.titleCells).toBeGreaterThan(0);
    expect(narrow.statusCells).toBeLessThan(wide.statusCells);
    expect(wide.statusCells).toBeLessThanOrEqual(22);
  });

  test('overview tabs never wrap and never hide a count', () => {
    const tabs = [
      { label: 'All', compactLabel: 'All', tinyLabel: 'A', count: 247, selected: true },
      { label: 'Local', compactLabel: 'Local', tinyLabel: 'L', count: 247, selected: false },
      { label: 'Remotes', compactLabel: 'Remote', tinyLabel: 'R', count: 0, selected: false },
      { label: 'Active', compactLabel: 'Active', tinyLabel: 'C', count: 2, selected: false },
      { label: 'Needs input', compactLabel: 'Needs', tinyLabel: 'N', count: 0, selected: false },
    ];
    for (const width of [20, 40, 60, 80]) {
      const layout = layoutOverviewTabs(tabs, width);
      expect(layout).toHaveLength(5);
      expect(cellWidth(layout.join(''))).toBeLessThanOrEqual(width);
      expect(layout.every((tab) => !tab.includes('\n'))).toBe(true);
      for (const count of ['247', '0', '2']) {
        expect(layout.join('')).toContain(count);
      }
    }
    expect(layoutOverviewTabs(tabs, 80).join('')).toContain('[All 247]');
    expect(layoutOverviewTabs(tabs, 60).join('')).toContain('Needs 0');
    expect(layoutOverviewTabs(tabs, 40).join('')).toContain('N0');
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
