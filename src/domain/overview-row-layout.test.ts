import { describe, expect, test } from 'bun:test';

import {
  layoutOverviewRow,
  layoutOverviewTabs,
  layoutProjectHeader,
  overviewColumnBudgets,
  overviewContentWidth,
  overviewDotCells,
  overviewMarker,
  overviewScrollbarCells,
  padCells,
  wrapOverviewTitle,
} from './overview-row-layout.ts';
import { cellWidth } from './text-width.ts';

function rowAt(contentWidth: number, overrides: { selected?: boolean; title?: string } = {}) {
  return layoutOverviewRow({
    selected: overrides.selected ?? false,
    dot: '●',
    title: overrides.title ?? 'a fairly long session title that should be clipped',
    status: 'interrupted · 13m',
    age: '13m',
    contentWidth,
  });
}

function rowInput(contentWidth: number) {
  return {
    selected: false,
    dot: '●',
    title: 'a fairly long session title that should be clipped',
    status: 'interrupted · 13m',
    age: '13m',
    contentWidth,
  };
}

function rowCells(row: ReturnType<typeof rowAt>): number {
  return (
    cellWidth(row.marker) +
    cellWidth(row.dot) +
    cellWidth(row.title) +
    cellWidth(row.gap) +
    cellWidth(row.status)
  );
}

describe('overview content width (#344)', () => {
  test('reserves the scrollbar column and both padding cells', () => {
    expect(overviewScrollbarCells).toBe(1);
    expect(overviewContentWidth(80)).toBe(77);
    expect(overviewContentWidth(3)).toBe(8);
  });
});

describe('overview row adaptive columns (#344)', () => {
  test('rows total the content width at every terminal width', () => {
    for (const width of [8, 12, 20, 27, 30, 40, 49, 50, 60, 80, 120]) {
      expect(rowCells(rowAt(width))).toBeLessThanOrEqual(Math.max(width, 8));
      if (width >= 20) expect(rowCells(rowAt(width))).toBe(width);
    }
  });

  test('wide terminals keep the full state and age status', () => {
    const row = rowAt(77);
    expect(row.statusMode).toBe('full');
    expect(row.status.trimEnd()).toBe('interrupted · 13m');
  });

  test('narrower terminals degrade to age only before squeezing the title', () => {
    const budgets = overviewColumnBudgets(40);
    expect(budgets.statusMode).toBe('age');
    expect(budgets.statusCells).toBe(4);
    expect(budgets.titleCells).toBeGreaterThanOrEqual(16);
    const row = rowAt(40);
    // Right-aligned so ages share a trailing edge.
    expect(row.status).toBe(' 13m');
    expect(layoutOverviewRow({ ...rowInput(40), age: 'now' }).status).toBe(' now');
  });

  test('very narrow terminals drop the status column and give the title everything', () => {
    const row = rowAt(24);
    expect(row.statusMode).toBe('none');
    expect(row.status).toBe('');
    expect(row.gap).toBe('');
    expect(row.titleCells).toBe(24 - cellWidth(row.marker) - overviewDotCells);
  });

  test('the status column never clips mid-label while it is shown in full', () => {
    for (let width = 8; width <= 140; width += 1) {
      const budgets = overviewColumnBudgets(width);
      if (budgets.statusMode === 'full') {
        expect(budgets.statusCells).toBeGreaterThanOrEqual(17);
      }
      if (budgets.statusMode !== 'none') {
        expect(budgets.titleCells).toBeGreaterThanOrEqual(16);
      }
    }
  });

  test('the marker shrinks on narrow terminals and is shared by every row kind', () => {
    expect(overviewMarker(true, 77)).toBe('  ❯ ');
    expect(overviewMarker(false, 77)).toBe('    ');
    expect(overviewMarker(true, 30)).toBe('❯ ');
    expect(overviewMarker(false, 30)).toBe('  ');
    expect(rowAt(30, { selected: true }).marker).toBe('❯ ');
    expect(rowAt(30).indentCells).toBe(cellWidth(rowAt(30).marker) + overviewDotCells);
  });

  test('title and status start at the same column for every row', () => {
    for (const width of [24, 40, 77]) {
      const rows = [
        { selected: true, title: 'short' },
        { selected: false, title: 'a much longer session title that wraps today' },
        { selected: false, title: 'unknown' },
      ].map((row) => rowAt(width, row));
      expect(new Set(rows.map((row) => cellWidth(`${row.marker}${row.dot}`))).size).toBe(1);
      expect(
        new Set(rows.map((row) => cellWidth(`${row.marker}${row.dot}${row.title}${row.gap}`))).size,
      ).toBe(1);
    }
  });

  test('long titles use at most two word-wrapped lines with an ellipsis only when omitted', () => {
    const title = 'Silvestris roadmap drops working · Sandcat continue working on opencode-';
    const row = rowAt(60, { title });
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
    // The ellipsis hugs the last kept word instead of leaving a dangling space.
    expect(
      wrapOverviewTitle('continue working on opencode-stuff/margarita. read the issues', 22),
    ).toEqual(['continue working on', 'opencode-stuff/margar…']);
    // The clip lands right after a space here: `def …` would waste a cell on the gap.
    expect(wrapOverviewTitle('x abc def ghi', 5)).toEqual(['x abc', 'def…']);
  });

  test('wide Unicode graphemes are clipped by display cells', () => {
    const row = rowAt(30, { title: '日本語の非常に長いセッションタイトル' });
    expect(cellWidth(row.title)).toBe(row.titleCells);
    expect(padCells('x', 4)).toBe('x   ');
  });
});

describe('overview tabs (#344)', () => {
  const tabs = [
    { label: 'All', compactLabel: 'All', tinyLabel: 'A', count: 247, selected: true },
    { label: 'Local', compactLabel: 'Local', tinyLabel: 'L', count: 247, selected: false },
    { label: 'Remotes', compactLabel: 'Remote', tinyLabel: 'R', count: 0, selected: false },
    { label: 'Active', compactLabel: 'Active', tinyLabel: 'C', count: 2, selected: false },
    { label: 'Needs input', compactLabel: 'Needs', tinyLabel: 'N', count: 0, selected: false },
  ];

  test('never wrap and never hide a count', () => {
    for (const width of [20, 30, 40, 60, 80]) {
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
  });

  test('narrow terminals keep the active filter named and abbreviate the rest', () => {
    const layout = layoutOverviewTabs(tabs, 40).join('');
    expect(layout).toContain('[All 247]');
    expect(layout).toContain('L247');
    expect(layout).toContain('N0');
  });

  test('tiny terminals fall back to letter and count for every filter', () => {
    expect(layoutOverviewTabs(tabs, 20).join('')).toContain('N0');
    expect(layoutOverviewTabs(tabs, 20).join('')).not.toContain('All');
  });
});

describe('overview project header (#344)', () => {
  test('shows the full path when it fits', () => {
    const header = layoutProjectHeader({
      name: 'workdir',
      extras: '',
      directory: 'C:\\Users\\terezi\\workdir',
      contentWidth: 60,
    });
    expect(header).toEqual({ name: 'workdir', directory: 'C:\\Users\\terezi\\workdir' });
  });

  test('keeps the tail of a long path and never exceeds the line', () => {
    const directory = 'C:\\Users\\terezi\\workdir\\opencode-stuff\\margarita';
    const header = layoutProjectHeader({
      name: 'margarita',
      extras: '',
      directory,
      contentWidth: 40,
    });
    expect(header.directory.startsWith('…')).toBe(true);
    expect(header.directory.endsWith('margarita')).toBe(true);
    expect(cellWidth(` ${header.name} `) + 2 + cellWidth(header.directory)).toBeLessThanOrEqual(40);
  });

  test('accounts for remote and offline markers', () => {
    const header = layoutProjectHeader({
      name: 'lotus',
      extras: '  🖥 build-box  [offline]',
      directory: '/home/terezi/projects/lotus',
      contentWidth: 50,
    });
    const used =
      cellWidth(' lotus ') +
      cellWidth('  🖥 build-box  [offline]') +
      2 +
      cellWidth(header.directory);
    expect(used).toBeLessThanOrEqual(50);
  });

  test('drops the path instead of wrapping when no room is left, and clips the name last', () => {
    const header = layoutProjectHeader({
      name: 'a-very-long-project-name-that-cannot-fit',
      extras: '',
      directory: '/work/a-very-long-project-name-that-cannot-fit',
      contentWidth: 20,
    });
    expect(header.directory).toBe('');
    expect(cellWidth(header.name) + 2).toBeLessThanOrEqual(20);
    expect(header.name.endsWith('…')).toBe(true);
  });
});
