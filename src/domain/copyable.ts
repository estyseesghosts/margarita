import { completeResponses } from './complete-response.ts';
import { sanitizeSingleLine, sanitizeTerminalText } from './sanitize-text.ts';
import { truncatePrompt } from './sticky-prompt.ts';
import type { TranscriptMessage } from './transcript.ts';

export type CopyKind = 'output' | 'diff' | 'error' | 'code' | 'shell' | 'response';
export type CopyTruncation = 'none' | 'frontend' | 'server';

/** Exact, UI-independent payload offered by the copy picker. */
export type Copyable = Readonly<{
  key: string;
  label: string;
  kind: CopyKind;
  /** Sanitized exact source text: newlines and code preserved, no display prefixes. */
  text: string;
  /** Whether the payload is complete, clipped by the frontend, or truncated by the server. */
  truncation: CopyTruncation;
}>;

const fencedCode = /```([^\n`]*)\n([\s\S]*?)```/g;

function truncationNote(truncation: CopyTruncation): string {
  if (truncation === 'frontend') return ' · UI cap — full text not retained';
  if (truncation === 'server') return ' · server truncated — raw text available via server RPC';
  return '';
}

/** One picker row for a whole completed response, named by its first displayable line. */
function responseLabel(text: string): string {
  const firstLine = sanitizeTerminalText(text)
    .split('\n')
    .find((line) => line.trim() !== '');
  const preview = firstLine === undefined ? '' : sanitizeSingleLine(firstLine).trim();
  return preview === '' ? 'Response' : `Response · ${truncatePrompt(preview, 48)}`;
}

/**
 * Projects loaded transcript messages into copyable payloads. This is deliberately separate
 * from rendering: the copied bytes are the underlying tool output, diff, error, fenced code
 * block or complete assistant response, never styled/wrapped terminal rows. Clipping and
 * truncation are reported, not hidden.
 */
export function copyableFromMessages(messages: readonly TranscriptMessage[]): Copyable[] {
  const items: Copyable[] = [];
  const add = (
    key: string,
    label: string,
    kind: CopyKind,
    raw: string,
    truncation: CopyTruncation,
  ) => {
    items.push({
      key,
      label: `${label}${truncationNote(truncation)}`,
      kind,
      text: sanitizeTerminalText(raw),
      truncation,
    });
  };

  for (const message of messages) {
    if (message.kind === 'shell') {
      if (message.output !== undefined)
        add(
          `${message.id}:shell`,
          `Shell output · ${message.command.slice(0, 48)}`,
          'shell',
          message.output,
          message.outputTruncated ?? 'none',
        );
      continue;
    }
    if (message.kind !== 'assistant') continue;
    message.parts.forEach((part, partIndex) => {
      if (part.kind === 'text') {
        const blocks = [...part.text.matchAll(fencedCode)];
        blocks.forEach((match, blockIndex) => {
          const language = (match[1] ?? '').trim();
          add(
            `${message.id}:code:${partIndex}:${blockIndex}`,
            `Code block${language === '' ? '' : ` · ${language}`}`,
            'code',
            match[2] ?? '',
            'none',
          );
        });
        return;
      }
      if (part.kind !== 'tool') return;
      const tool = part.tool;
      if (tool.output !== undefined)
        add(
          `${tool.id}:output`,
          `Output · ${tool.name}`,
          'output',
          tool.output,
          tool.outputTruncated ?? 'none',
        );
      if (tool.diff !== undefined)
        add(`${tool.id}:diff`, `Diff · ${tool.name}`, 'diff', tool.diff, 'none');
      if (tool.error !== undefined)
        add(`${tool.id}:error`, `Error · ${tool.name}`, 'error', tool.error, 'none');
    });
  }

  // Whole responses are an additional category: canonical text only, never rendered rows.
  for (const response of completeResponses(messages)) {
    add(`response:${response.id}`, responseLabel(response.text), 'response', response.text, 'none');
  }
  return items;
}
