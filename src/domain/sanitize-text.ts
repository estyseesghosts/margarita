// Matches CSI, OSC (BEL or ST terminated), and other two-byte ESC sequences.
const escapeSequence =
  // eslint-disable-next-line no-control-regex -- deliberately matching terminal control bytes
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
// C0/C1 controls except tab and newline, plus DEL.
// eslint-disable-next-line no-control-regex -- deliberately matching terminal control bytes
const controlCharacters = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Bidirectional overrides/isolates that can visually reorder text.
const bidiControls = /[‪-‮⁦-⁩‎‏؜]/g;

/**
 * Makes untrusted model/tool text safe to paint: removes escape sequences that could
 * move the cursor, retitle the terminal or write the clipboard, plus bidi overrides.
 */
export function sanitizeTerminalText(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replace(escapeSequence, '')
    .replaceAll('\r', '\n')
    .replace(controlCharacters, '')
    .replace(bidiControls, '');
}

/** First `maxLines` lines plus a count of what was cut, for capped previews. */
export function previewLines(
  text: string,
  maxLines: number,
): { lines: string[]; hiddenLines: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { lines, hiddenLines: 0 };
  return { lines: lines.slice(0, maxLines), hiddenLines: lines.length - maxLines };
}
