/** Semantic colours only; `NO_COLOR` collapses everything to the terminal default. */
export type Theme = Readonly<{
  text: string;
  dim: string;
  accent: string;
  accentLight: string;
  /** Blinking composer caret; follows the accent unless configured separately. */
  caret: string;
  user: string;
  userBg: string;
  error: string;
  warn: string;
  success: string;
  /** Semantic agent colours; the palette is for deterministic custom-agent IDs. */
  agentBuild: string;
  agentPlan: string;
  agentPalette: readonly string[];
  border: string;
  selectionBg: string;
  /** Opaque backdrop for full-screen overlays (the inspector). */
  panelBg: string;
  addedBg: string;
  removedBg: string;
}>;

const dark: Theme = {
  text: '#e6e6e6',
  dim: '#8a8a8a',
  accent: '#e4677e',
  accentLight: '#ffd3a8',
  caret: '#e4677e',
  user: '#f2f2f2',
  userBg: '#3a3a3a',
  error: '#ff6b6b',
  warn: '#e5c07b',
  success: '#7fc77f',
  agentBuild: '#5aa9e6',
  agentPlan: '#b58ce8',
  agentPalette: ['#e5a44a', '#6fd08c', '#e07b9a', '#7ab8c1'],
  border: '#5a5a5a',
  selectionBg: '#444466',
  panelBg: '#101010',
  addedBg: '#1f3a26',
  removedBg: '#46232a',
};

/** For light terminal backgrounds; all text pairs keep at least 4.5:1 contrast on white. */
const light: Theme = {
  text: '#1f1f1f',
  dim: '#5f5f5f',
  accent: '#b0304a',
  accentLight: '#8a4b00',
  caret: '#b0304a',
  user: '#1f1f1f',
  userBg: '#e6e6e6',
  error: '#b00020',
  warn: '#7a5200',
  success: '#2d6a2d',
  agentBuild: '#005a9c',
  agentPlan: '#6b2d8f',
  agentPalette: ['#8a4b00', '#226b3a', '#9c2b52', '#005f6b'],
  border: '#9a9a9a',
  selectionBg: '#d0d8f0',
  panelBg: '#ffffff',
  addedBg: '#d6f0d6',
  removedBg: '#f6d5d9',
};

/** Maximum contrast; state is never conveyed by colour alone (marks and words carry it). */
const highContrast: Theme = {
  text: '#ffffff',
  dim: '#d0d0d0',
  accent: '#ffff00',
  accentLight: '#00ffff',
  caret: '#ffff00',
  user: '#ffffff',
  userBg: '#000000',
  error: '#ff5555',
  warn: '#ffff00',
  success: '#55ff55',
  agentBuild: '#00ffff',
  agentPlan: '#ff00ff',
  agentPalette: ['#ffff00', '#55ff55', '#ff5555', '#00aaff'],
  border: '#ffffff',
  selectionBg: '#0000aa',
  panelBg: '#000000',
  addedBg: '#003300',
  removedBg: '#550000',
};

const plain: Theme = {
  text: '#ffffff',
  dim: '#ffffff',
  accent: '#ffffff',
  accentLight: '#ffffff',
  caret: '#ffffff',
  user: '#ffffff',
  userBg: '#000000',
  error: '#ffffff',
  warn: '#ffffff',
  success: '#ffffff',
  agentBuild: '#ffffff',
  agentPlan: '#ffffff',
  agentPalette: ['#ffffff'],
  border: '#ffffff',
  selectionBg: '#000000',
  panelBg: '#000000',
  addedBg: '#000000',
  removedBg: '#000000',
};

const themes = { dark, light, 'high-contrast': highContrast } as const;

/** `NO_COLOR` always wins over the configured theme. */
export function pickTheme(env: NodeJS.ProcessEnv, name: keyof typeof themes = 'dark'): Theme {
  return env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '' ? plain : themes[name];
}

/** True for the collapsed no-colour theme (NO_COLOR). Filled labels must not be emitted. */
export function isNoColorTheme(theme: Theme): boolean {
  return theme === plain;
}

/** User-supplied accent overrides from the `ui` config section. */
export type AccentOverrides = Readonly<{
  accent?: string;
  accentLight?: string;
  caret?: string;
}>;

/**
 * Applies configured accents to a picked theme without mutating the shared theme constants.
 * `NO_COLOR` is returned untouched. A missing light accent follows the effective accent so a
 * custom accent never leaves the built-in lighter shade behind, and the caret follows the
 * accent unless it has its own configured colour.
 */
export function withAccentOverrides(theme: Theme, overrides: AccentOverrides): Theme {
  if (isNoColorTheme(theme)) return theme;
  const accent = overrides.accent ?? theme.accent;
  const accentLight =
    overrides.accentLight ?? (overrides.accent === undefined ? theme.accentLight : accent);
  const caret = overrides.caret ?? accent;
  if (accent === theme.accent && accentLight === theme.accentLight && caret === theme.caret) {
    return theme;
  }
  return { ...theme, accent, accentLight, caret };
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
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`Invalid colour "${hex}"`);
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}
