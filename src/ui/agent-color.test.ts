import { describe, expect, test } from 'bun:test';

import { agentColor } from './agent-color.ts';
import { isNoColorTheme, pickTheme } from './theme.ts';

describe('agentColor', () => {
  const theme = pickTheme({});

  test('built-ins use fixed semantic colours and custom IDs are deterministic', () => {
    expect(agentColor('build', theme)).toBe(theme.agentBuild);
    expect(agentColor('plan', theme)).toBe(theme.agentPlan);
    expect(agentColor('reviewer', theme)).toBe(agentColor('reviewer', theme));
    expect(theme.agentPalette).toContain(agentColor('reviewer', theme));
  });

  test('unknown or missing agents stay neutral', () => {
    expect(agentColor(undefined, theme)).toBe(theme.dim);
    expect(agentColor('', theme)).toBe(theme.dim);
    expect(agentColor('—', theme)).toBe(theme.dim);
  });

  test('NO_COLOR never emits a distinct colour', () => {
    const plain = pickTheme({ NO_COLOR: '1' });
    expect(isNoColorTheme(plain)).toBe(true);
    expect(agentColor('build', plain)).toBe(plain.text);
    expect(agentColor('reviewer', plain)).toBe(plain.text);
  });
});
