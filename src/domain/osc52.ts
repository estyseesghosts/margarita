/**
 * OSC 52 clipboard escape sequence. Nothing is sent to a network service: the terminal
 * writes the bytes directly to its own system clipboard. Chunking keeps large payloads
 * within terminal caps; every chunk is a whole number of base64 quartets so the receiver
 * can concatenate the decoded bytes without gaps.
 */
export function osc52Clipboard(text: string, chunkChars = 4096): string {
  const width = Math.max(4, Math.floor(chunkChars / 4) * 4);
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const chunks: string[] = [];
  for (let index = 0; index < encoded.length; index += width) {
    chunks.push(`\u001b]52;c;${encoded.slice(index, index + width)}\u001b\\`);
  }
  return chunks.join('');
}
