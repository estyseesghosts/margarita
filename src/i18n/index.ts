import { enUsStrings } from './en_us/index.ts';
import type { LocaleStrings } from './types.ts';

export type { LocaleStrings } from './types.ts';

/**
 * The active locale catalog. Locale selection does not exist yet, so this is hardcoded.
 * Feature code reads strings from here; it never imports an `en_us` module directly.
 */
export const strings: LocaleStrings = enUsStrings;
