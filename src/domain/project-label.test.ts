import { describe, expect, test } from 'bun:test';

import { projectLabel, projectLabelBlock, serverFamilyHue } from './project-label.ts';

describe('project labels', () => {
  test('local projects receive varied, distinct colours', () => {
    const colors = ['/a', '/b', '/c', '/d'].map((dir) => projectLabel('local', dir).background);
    expect(new Set(colors).size).toBe(4);
  });

  test('assignment is stable and independent of names or recency', () => {
    expect(projectLabel('srv_1', '/work/lotus')).toEqual(projectLabel('srv_1', '/work/lotus'));
  });

  test('servers get distinct hue families; their projects get related shades', () => {
    const local = serverFamilyHue('local');
    const buildbox = serverFamilyHue('srv_1');
    const linuxbox = serverFamilyHue('srv_2');
    expect(new Set([local, buildbox, linuxbox]).size).toBe(3);
    expect(serverFamilyHue('srv_1')).toBe(buildbox);
  });

  test('foreground is chosen for contrast', () => {
    for (const dir of ['/a', '/b', '/c', '/d', '/e']) {
      const label = projectLabel('srv_1', dir);
      expect(['#000000', '#ffffff']).toContain(label.foreground);
    }
  });

  test('ASCII mode omits the colour block', () => {
    expect(projectLabelBlock(projectLabel('local', '/a'), true)).toBe('');
    expect(projectLabelBlock(undefined, false)).toBe('');
  });
});
