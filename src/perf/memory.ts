/**
 * Approximate retained-size accounting for canonical transcript state (#289). This is a
 * deterministic estimate, not a heap measurement: it counts UTF-16 string payloads and a
 * fixed per-record overhead so cache policy can compare sessions. The benchmark's heap/RSS
 * numbers remain the authoritative measurement of process memory.
 */
import type { ToolCall, ToolCallChild, TranscriptMessage } from '../domain/transcript.ts';

export type RetainedBytes = Readonly<{
  /** Approximate retained bytes for this value, including structural overhead. */
  total: number;
  /** String payload (UTF-16) share of `total`. */
  text: number;
  /** Message/part/tool/child/file record overhead share of `total`. */
  structure: number;
}>;

const messageOverhead = 120;
const partOverhead = 72;
const toolOverhead = 160;
const childOverhead = 112;
const fileOverhead = 80;
const attachmentOverhead = 64;

function bytes(text: string | undefined): number {
  return text === undefined ? 0 : text.length * 2;
}

function inputBytes(input: Readonly<Record<string, unknown>> | undefined): number {
  if (input === undefined) return 0;
  let total = 0;
  for (const [key, value] of Object.entries(input)) {
    total += bytes(key);
    if (typeof value === 'string') total += bytes(value);
    else if (typeof value === 'number' || typeof value === 'boolean') total += 8;
    else if (value !== null && value !== undefined) total += bytes(JSON.stringify(value));
  }
  return total;
}

function childBytes(child: ToolCallChild): RetainedBytes {
  const text =
    inputBytes(child.input) + bytes(child.error) + bytes(child.output) + bytes(child.name);
  return { total: childOverhead + text, text, structure: childOverhead };
}

function toolBytes(tool: ToolCall): RetainedBytes {
  let text = bytes(tool.id) + bytes(tool.name) + inputBytes(tool.input);
  text += bytes(tool.output) + bytes(tool.diff) + bytes(tool.diffFile);
  text += bytes(tool.executionError) + bytes(tool.error);
  let structure = toolOverhead;
  for (const file of tool.files ?? []) {
    text += bytes(file.name) + bytes(file.mime) + bytes(file.uri);
    structure += fileOverhead;
  }
  for (const child of tool.children ?? []) {
    const retained = childBytes(child);
    text += retained.text;
    structure += retained.structure;
  }
  return { total: structure + text, text, structure };
}

function messageBytes(message: TranscriptMessage): RetainedBytes {
  let text = bytes(message.id);
  let structure = messageOverhead;
  switch (message.kind) {
    case 'user': {
      text += bytes(message.text);
      structure += (message.attachments.length + 1) * attachmentOverhead;
      for (const attachment of message.attachments) text += bytes(attachment);
      break;
    }
    case 'assistant': {
      text += bytes(message.agent) + bytes(message.model.providerID) + bytes(message.model.modelID);
      text += bytes(message.error);
      for (const part of message.parts) {
        structure += partOverhead;
        if (part.kind === 'text' || part.kind === 'reasoning') {
          text += bytes(part.text);
        } else {
          const retained = toolBytes(part.tool);
          text += retained.text;
          structure += retained.structure;
        }
      }
      break;
    }
    case 'shell': {
      text += bytes(message.command) + bytes(message.output) + bytes(message.shellID);
      break;
    }
    case 'agent-switched': {
      text += bytes(message.agent);
      break;
    }
    case 'model-switched': {
      text += bytes(message.model.providerID) + bytes(message.model.modelID);
      break;
    }
    case 'idle': {
      text += bytes(message.error);
      break;
    }
    case 'compaction': {
      break;
    }
    case 'note': {
      text += bytes(message.text);
      break;
    }
    default: {
      const exhaustive: never = message;
      void exhaustive;
    }
  }
  return { total: structure + text, text, structure };
}

const messageCache = new WeakMap<TranscriptMessage, RetainedBytes>();
const transcriptCache = new WeakMap<readonly TranscriptMessage[], RetainedBytes>();

export function approximateMessageBytes(message: TranscriptMessage): RetainedBytes {
  const cached = messageCache.get(message);
  if (cached !== undefined) return cached;
  const retained = messageBytes(message);
  messageCache.set(message, retained);
  return retained;
}

export function approximateTranscriptBytes(messages: readonly TranscriptMessage[]): RetainedBytes {
  const cached = transcriptCache.get(messages);
  if (cached !== undefined) return cached;
  let total = 0;
  let text = 0;
  let structure = 0;
  for (const message of messages) {
    const retained = approximateMessageBytes(message);
    total += retained.total;
    text += retained.text;
    structure += retained.structure;
  }
  const retained = { total, text, structure };
  transcriptCache.set(messages, retained);
  return retained;
}
