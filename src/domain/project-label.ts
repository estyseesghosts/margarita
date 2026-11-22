import { localServerID } from './server-identity.ts';

/** Solid label colour plus a contrast-checked foreground. */
export type ProjectLabel = Readonly<{
  background: string;
  foreground: '#000000' | '#ffffff';
}>;

/** Small stable string hash; assignment must not depend on order, names, or recency. */
function hash(value: string | undefined): number {
  let result = 2166136261;
  for (const char of value ?? '') {
    result ^= char.codePointAt(0) ?? 0;
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor((((hue % 360) + 360) % 360) / 60);
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector] ?? [0, 0, 0];
  const channel = (value: number) =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r ?? 0)}${channel(g ?? 0)}${channel(b ?? 0)}`;
}

/** Parses one generated `#rrggbb` channel; the generator above makes this a local invariant. */
function hexChannel(hex: string, offset: number): number {
  const pair = hex.slice(offset, offset + 2);
  if (!/^[0-9a-f]{2}$/i.test(pair)) {
    throw new Error(`Invalid colour channel "${pair}" in "${hex}"`);
  }
  return Number.parseInt(pair, 16);
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => hexChannel(hex, offset) / 255);
  const linear = channels.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

/** Hue family per server; local gets a blue family, remotes get stable distinct families. */
export function serverFamilyHue(serverID: string | undefined): number {
  if (serverID === undefined || serverID === localServerID) return 214;
  const family = hash(serverID) % 20;
  return family * 18;
}

/**
 * Colour for a project. Derived only from immutable `(serverID, directoryKey)`, so renames,
 * restarts, reconnects, tab switches, and pagination never recolour existing entries.
 * Saturation/lightness stay in a readable band; foreground is chosen by relative luminance.
 */
export function projectLabel(serverID: string | undefined, directoryKey: string): ProjectLabel {
  const family = serverFamilyHue(serverID);
  const shade = hash(`${serverID}\u0000${directoryKey}`);
  const hue = (family + (shade % 5) * 6 - 12 + 360) % 360;
  const saturation = 46 + (shade % 4) * 6;
  const lightness = 42 + ((shade >>> 3) % 4) * 4;
  const background = hslToHex(hue, saturation, lightness);
  return { background, foreground: luminance(background) > 0.45 ? '#000000' : '#ffffff' };
}

/** Whitespace-only block used in ASCII/NO_COLOR mode; identity stays textual. */
export function projectLabelBlock(label: ProjectLabel | undefined, ascii: boolean): string {
  if (ascii || label === undefined) return '';
  return '\u2588';
}
