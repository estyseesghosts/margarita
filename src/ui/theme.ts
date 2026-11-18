/** Semantic colours only; `NO_COLOR` collapses everything to the terminal default. */
export type Theme = Readonly<{
  text: string;
  dim: string;
  accent: string;
  accentLight: string;
  user: string;
  userBg: string;
  error: string;
  warn: string;
  success: string;
  border: string;
  selectionBg: string;
}>;

const dark: Theme = {
  text: '#e6e6e6',
  dim: '#8a8a8a',
  accent: '#e4677e',
  accentLight: '#ffd3a8',
  user: '#f2f2f2',
  userBg: '#3a3a3a',
  error: '#ff6b6b',
  warn: '#e5c07b',
  success: '#7fc77f',
  border: '#5a5a5a',
  selectionBg: '#444466',
};

/** For light terminal backgrounds; all text pairs keep at least 4.5:1 contrast on white. */
const light: Theme = {
  text: '#1f1f1f',
  dim: '#5f5f5f',
  accent: '#b0304a',
  accentLight: '#8a4b00',
  user: '#1f1f1f',
  userBg: '#e6e6e6',
  error: '#b00020',
  warn: '#7a5200',
  success: '#2d6a2d',
  border: '#9a9a9a',
  selectionBg: '#d0d8f0',
};

/** Maximum contrast; state is never conveyed by colour alone (marks and words carry it). */
const highContrast: Theme = {
  text: '#ffffff',
  dim: '#d0d0d0',
  accent: '#ffff00',
  accentLight: '#00ffff',
  user: '#ffffff',
  userBg: '#000000',
  error: '#ff5555',
  warn: '#ffff00',
  success: '#55ff55',
  border: '#ffffff',
  selectionBg: '#0000aa',
};

const plain: Theme = {
  text: '#ffffff',
  dim: '#ffffff',
  accent: '#ffffff',
  accentLight: '#ffffff',
  user: '#ffffff',
  userBg: '#000000',
  error: '#ffffff',
  warn: '#ffffff',
  success: '#ffffff',
  border: '#ffffff',
  selectionBg: '#000000',
};

const themes = { dark, light, 'high-contrast': highContrast } as const;

/** `NO_COLOR` always wins over the configured theme. */
export function pickTheme(env: NodeJS.ProcessEnv, name: keyof typeof themes = 'dark'): Theme {
  return env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '' ? plain : themes[name];
}

/** Linear blend of two `#rrggbb` colours, `t` in [0,1]. */
export function blend(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const mix = a.map((channel, index) =>
    Math.round(channel + ((b[index] ?? channel) - channel) * t),
  );
  return `#${mix.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(hex: string): number[] {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}
