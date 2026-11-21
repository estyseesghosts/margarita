/**
 * OSC 52 clipboard escape sequence. Nothing is sent to a network service: the terminal
 * writes the bytes directly to its own system clipboard.
 *
 * #131: a single set operation is emitted for payloads within an explicit encoded-byte limit.
 * Multiple OSC 52 "set clipboard" sequences are NOT appended by receivers — they would leave
 * only the last fragment. An oversized payload returns `undefined` so the caller can use a
 * verified local-file fallback instead of silently truncating.
 */
export function osc52Clipboard(text: string, maxEncodedBytes = 4096): string | undefined {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  if (encoded.length > maxEncodedBytes) return undefined;
  return `\u001b]52;c;${encoded}\u001b\\`;
}
