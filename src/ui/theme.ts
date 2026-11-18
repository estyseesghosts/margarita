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

export function pickTheme(env: NodeJS.ProcessEnv): Theme {
  return env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '' ? plain : dark;
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
