/**
 * Prints the clipboard-acquisition notice fragments the executable PTY smoke must accept, as a
 * JSON array. Deriving them from the authoritative i18n module keeps the smoke test from
 * duplicating copy that has since changed (#audit-2 task 1).
 */
import { noticesEnUs } from '../src/i18n/en_us/notices.ts';

/** Marks the interpolated `detail` argument so the static fragments can be recovered. */
const detailMarker = '\u0000detail\u0000';

function staticFragments(template: string): string[] {
  return template
    .split(detailMarker)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.replace(/[^a-z]/gi, '').length >= 4);
}

const clipboard = noticesEnUs.clipboard;
const expectations = [
  clipboard.empty,
  ...staticFragments(clipboard.cannotRead(detailMarker)),
  ...staticFragments(clipboard.cannotPaste(detailMarker)),
  ...staticFragments(clipboard.readFailed(detailMarker)),
];

console.log(JSON.stringify([...new Set(expectations)]));
