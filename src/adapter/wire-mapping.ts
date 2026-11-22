import type {
  AgentInfo,
  FileDiffInfo,
  FormField as WireFormField,
  FormInfo,
  ModelInfo,
  PermissionRequest,
  SessionInboxInfo,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
} from '@opencode/client';

import type { AgentDescriptor } from '../domain/agent-cycle.ts';
import { type Attachment, attachmentFromBase64 } from '../domain/attachment.ts';
import { isRecord, readTokens } from '../domain/backend-event.ts';
import type { FileDiff } from '../domain/diff.ts';
import type { FormField, FormRequest } from '../domain/form.ts';
import { effectiveVariant, type ModelSelection } from '../domain/model-ref.ts';
import type { CatalogModel } from '../domain/model-resolution.ts';
import { sanitizeSingleLine, sanitizeTerminalText } from '../domain/sanitize-text.ts';
import { localServerID } from '../domain/server-identity.ts';
import type { SessionSummary, StagedRevert } from '../domain/session.ts';
import type { ShellJob } from '../domain/shell-job.ts';
import type {
  AssistantPart,
  ToolCall,
  ToolCallChild,
  ToolFileReference,
  ToolResultPayload,
  ToolStatus,
  TranscriptMessage,
} from '../domain/transcript.ts';
import type { WorkerJob, WorkerStatus } from '../domain/worker.ts';

/**
 * Maps SDK wire values into domain types. The SDK does not validate responses at
 * runtime, so every mapper checks the fields it relies on and drops what it can't trust.
 */

export class WireFormatError extends Error {
  override readonly name = 'WireFormatError';
}

export function toModelSelection(value: unknown): ModelSelection | undefined {
  if (!isRecord(value)) return undefined;
  const id = value['id'];
  const providerID = value['providerID'];
  const variant = value['variant'];
  if (typeof id !== 'string' || typeof providerID !== 'string') return undefined;
  return {
    providerID,
    modelID: id,
    // The server reports its default as `variant: "default"`; keep one stable representation.
    ...(typeof variant === 'string' && effectiveVariant(variant) !== undefined ? { variant } : {}),
  };
}

export function toSessionSummary(
  info: SessionInfo,
  serverID: string = localServerID,
): SessionSummary {
  const raw: unknown = info;
  if (!isRecord(raw) || typeof raw['id'] !== 'string' || !isRecord(raw['location'])) {
    throw new WireFormatError('Session payload is missing id or location.');
  }
  const directory = raw['location']['directory'];
  const time = isRecord(raw['time']) ? raw['time'] : {};
  const created = typeof time['created'] === 'number' ? time['created'] : 0;
  const updated = typeof time['updated'] === 'number' ? time['updated'] : created;
  const model = toModelSelection(info.model);
  const tokens = readTokens(info.tokens);
  return {
    id: info.id,
    serverID,
    projectID: typeof info.projectID === 'string' ? info.projectID : '',
    directory: typeof directory === 'string' ? directory : '',
    createdAt: created,
    updatedAt: updated,
    archived: typeof time['archived'] === 'number',
    ...(typeof info.parentID === 'string' ? { parentID: info.parentID } : {}),
    ...(typeof info.title === 'string' && info.title !== '' ? { title: info.title } : {}),
    ...(typeof info.agent === 'string' ? { agent: info.agent } : {}),
    ...(model === undefined ? {} : { model }),
    ...(typeof info.cost === 'number' ? { cost: info.cost } : {}),
    ...(tokens === undefined ? {} : { tokens }),
    ...(info.outcome === undefined ? {} : { outcome: info.outcome }),
    ...toStagedRevert(info.revert),
  };
}

function toStagedRevert(value: unknown): { revert?: StagedRevert } {
  if (!isRecord(value) || typeof value['messageID'] !== 'string') return {};
  const files = Array.isArray(value['files']) ? value['files'].map(toFileDiff) : undefined;
  return {
    revert: {
      messageID: value['messageID'],
      ...(files === undefined || files.length === 0 ? {} : { files }),
    },
  };
}

export function toAgentDescriptor(agent: AgentInfo): AgentDescriptor {
  return {
    id: agent.id,
    name: agent.name,
    mode: agent.mode,
    hidden: agent.hidden,
    ...(agent.description === undefined ? {} : { description: agent.description }),
  };
}

export function toCatalogModel(model: ModelInfo): CatalogModel {
  const contextLimit = finite(model.limit?.context);
  return {
    providerID: model.providerID,
    modelID: model.id,
    name: model.name,
    enabled: model.enabled,
    variants: model.variants.map((variant) => variant.id),
    ...(contextLimit === undefined ? {} : { contextLimit }),
  };
}

export type PermissionPrompt = Readonly<{
  id: string;
  sessionID: string;
  action: string;
  resources: readonly string[];
  /** Patterns `always` would save; empty means `always` is not offered. */
  save: readonly string[];
  message?: string;
}>;

export function toPermissionPrompt(request: PermissionRequest): PermissionPrompt {
  return {
    id: request.id,
    sessionID: request.sessionID,
    action: sanitizeTerminalText(request.action),
    resources: request.resources.map(sanitizeTerminalText),
    save: (request.save ?? []).map(sanitizeTerminalText),
    ...(request.message === undefined ? {} : { message: sanitizeTerminalText(request.message) }),
  };
}

export type QueuedInput = Readonly<{
  id: string;
  kind: 'user' | 'synthetic' | 'compaction' | 'move';
  delivery: 'queue' | 'steer';
  text: string;
  createdAt: number;
  /** Inline files the queued message carries, so recalling it does not drop them. */
  attachments?: readonly Attachment[];
}>;

export function toQueuedInput(item: SessionInboxInfo): QueuedInput {
  const payload: unknown = item.payload;
  const text = isRecord(payload) && typeof payload['text'] === 'string' ? payload['text'] : '';
  const files = isRecord(payload) && Array.isArray(payload['files']) ? payload['files'] : [];
  const attachments = files.flatMap((file: unknown, index: number) => {
    if (!isRecord(file)) return [];
    const data = file['data'];
    const mime = file['mime'];
    if (typeof data !== 'string' || typeof mime !== 'string') return [];
    const name = typeof file['name'] === 'string' ? file['name'] : '';
    const attachment = attachmentFromBase64(name, mime, data, `inbox:${item.id}:${index}`);
    return attachment === undefined ? [] : [attachment];
  });
  return {
    id: item.id,
    kind: item.type,
    delivery: item.delivery,
    text,
    createdAt: item.time.created,
    attachments,
  };
}

/** Default cap for tool output retained in the transcript (head+tail are both kept). */
export const maxToolOutputChars = 64_000;

/** Describes one file content part without ever retaining `data:` payload bytes (#218). */
function toolFile(entry: Record<string, unknown>): ToolFileReference | undefined {
  const rawUri = typeof entry['uri'] === 'string' ? entry['uri'] : undefined;
  const rawName = typeof entry['name'] === 'string' ? entry['name'].trim() : '';
  const rawMime = typeof entry['mime'] === 'string' ? entry['mime'].trim() : '';
  if (rawUri !== undefined && rawUri.startsWith('data:')) {
    const comma = rawUri.indexOf(',');
    const header = comma === -1 ? rawUri.slice(5) : rawUri.slice(5, comma);
    const parts = header.split(';');
    const declaredMime = parts[0]?.trim() ?? '';
    const mime = rawMime === '' ? (declaredMime === '' ? undefined : declaredMime) : rawMime;
    const payload = comma === -1 ? '' : rawUri.slice(comma + 1);
    const base64 = parts.slice(1).some((part) => part.trim().toLowerCase() === 'base64');
    let size: number | undefined;
    if (base64) {
      const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
      size = Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
    } else if (comma !== -1) {
      try {
        size = new TextEncoder().encode(decodeURIComponent(payload)).length;
      } catch {
        size = undefined;
      }
    }
    const name = rawName !== '' ? rawName : (mime ?? 'file');
    return {
      name: sanitizeSingleLine(name),
      ...(mime === undefined ? {} : { mime: sanitizeSingleLine(mime) }),
      ...(size === undefined ? {} : { size }),
    };
  }
  const uri = rawUri === undefined ? '' : sanitizeSingleLine(rawUri);
  const fileName = uri === '' ? '' : (uri.split(/[\\/]/).at(-1) ?? '');
  const name = rawName !== '' ? rawName : fileName !== '' ? fileName : rawMime || 'file';
  return {
    name: sanitizeSingleLine(name),
    ...(rawMime === '' ? {} : { mime: sanitizeSingleLine(rawMime) }),
    ...(uri === '' ? {} : { uri }),
  };
}

function toolContent(
  content: unknown,
  maxChars: number,
): { text: string; truncated: boolean; files: ToolFileReference[] } | undefined {
  if (!Array.isArray(content)) return undefined;
  const files: ToolFileReference[] = [];
  const textParts: string[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    if (entry['type'] === 'text' && typeof entry['text'] === 'string')
      textParts.push(entry['text']);
    if (entry['type'] === 'file') {
      const file = toolFile(entry);
      if (file !== undefined) files.push(file);
    }
  }
  const total = textParts.reduce(
    (length, part, index) => length + part.length + (index === 0 ? 0 : 1),
    0,
  );
  if (total <= maxChars) {
    return { text: sanitizeTerminalText(textParts.join('\n')), truncated: false, files };
  }
  // Bounded, but keep both ends: failures usually live in the tail. Build the head and tail
  // across the parts directly instead of joining a potentially huge upstream payload first
  // (#289); the omission banner still states the true total length.
  const headBudget = Math.floor(maxChars / 2);
  const tailBudget = maxChars - headBudget;
  let head = '';
  let remaining = headBudget;
  for (let index = 0; index < textParts.length && remaining > 0; index += 1) {
    if (index > 0) {
      head += '\n';
      remaining -= 1;
      if (remaining <= 0) break;
    }
    const piece = safePrefix(textParts[index] ?? '', remaining);
    head += piece;
    remaining -= piece.length;
  }
  let tail = '';
  remaining = tailBudget;
  for (let index = textParts.length - 1; index >= 0 && remaining > 0; index -= 1) {
    if (index < textParts.length - 1) {
      tail = `\n${tail}`;
      remaining -= 1;
      if (remaining <= 0) break;
    }
    const piece = safeSuffix(textParts[index] ?? '', remaining);
    tail = piece + tail;
    remaining -= piece.length;
  }
  const omitted = total - head.length - tail.length;
  const capped = `${head}\n… ${omitted} characters omitted from the middle of this output (${total} chars total) …\n${tail}`;
  return { text: sanitizeTerminalText(capped), truncated: true, files };
}

/** A UTF-16 prefix that never ends between a high and a low surrogate. */
function safePrefix(text: string, max: number): string {
  if (max <= 0) return '';
  if (max >= text.length) return text;
  let end = max;
  const unit = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return text.slice(0, end);
}

/** A UTF-16 suffix that never starts between a high and a low surrogate. */
function safeSuffix(text: string, max: number): string {
  if (max <= 0) return '';
  if (max >= text.length) return text;
  let start = text.length - max;
  const unit = text.charCodeAt(start);
  const previous = text.charCodeAt(start - 1);
  if (unit >= 0xdc00 && unit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start += 1;
  return text.slice(start);
}

export type WireMappingOptions = Readonly<{
  /** Override the output cap (defaults to `maxToolOutputChars`). */
  maxToolOutputChars?: number;
}>;

const childStatuses = new Set<string>(['streaming', 'running', 'completed', 'error']);
const childInputMaxChars = 200;
const childOutputMaxChars = 1000;

function isToolStatus(value: string): value is ToolStatus {
  return childStatuses.has(value);
}

/** Bounded scalar display input from one nested call; never the enclosing script. */
function childInput(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = sanitizeTerminalText(
        entry.length > childInputMaxChars ? `${entry.slice(0, childInputMaxChars)}…` : entry,
      );
    } else if (typeof entry === 'number' || typeof entry === 'boolean') {
      result[key] = entry;
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

/** Optional per-child error, accepted only when the server actually supplied one. */
function childError(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return sanitizeTerminalText(value);
  if (isRecord(value) && typeof value['message'] === 'string' && value['message'].trim() !== '') {
    return sanitizeTerminalText(value['message']);
  }
  return undefined;
}

/** Optional per-child output/result, bounded so one child cannot flood the transcript. */
function childOutput(entry: Record<string, unknown>): {
  output?: string;
  truncated?: boolean;
} {
  const raw = entry['result'] ?? entry['output'];
  if (typeof raw !== 'string' || raw === '') return {};
  const truncated = raw.length > childOutputMaxChars;
  const text = truncated ? `${raw.slice(0, childOutputMaxChars)}…` : raw;
  return { output: sanitizeTerminalText(text), ...(truncated ? { truncated: true } : {}) };
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Optional per-child timing in either `time.started/completed` or flat fields. */
function childTiming(entry: Record<string, unknown>): {
  startedAt?: number;
  completedAt?: number;
} {
  const time = isRecord(entry['time']) ? entry['time'] : undefined;
  const startedAt = finiteTimestamp(time?.['started']) ?? finiteTimestamp(entry['startedAt']);
  const completedAt = finiteTimestamp(time?.['completed']) ?? finiteTimestamp(entry['completedAt']);
  return {
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

/**
 * Strictly reads `metadata.toolCalls`; malformed entries are skipped, never guessed (#216).
 * OpenCode v2.3.x supplies only `tool`, `status` and `input`; optional child diagnostics are
 * retained when a server provides them, but no field is invented (#231).
 */
function toolChildren(
  metadata: Record<string, unknown>,
  parentID: string,
): ToolCallChild[] | undefined {
  const raw = metadata['toolCalls'];
  if (!Array.isArray(raw)) return undefined;
  const children: ToolCallChild[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const name = typeof entry['tool'] === 'string' ? entry['tool'] : undefined;
    const status = entry['status'];
    if (name === undefined || name === '' || typeof status !== 'string') return;
    if (!isToolStatus(status)) return;
    const input = childInput(entry['input']);
    const error = childError(entry['error']);
    const result = childOutput(entry);
    const timing = childTiming(entry);
    children.push({
      id: `${parentID}:${index}`,
      parentID,
      index,
      name: sanitizeSingleLine(name),
      status,
      ...(input === undefined ? {} : { input }),
      ...(error === undefined ? {} : { error }),
      ...(result.output === undefined ? {} : { output: result.output }),
      ...(result.output === undefined || result.truncated !== true
        ? {}
        : { outputTruncated: true }),
      ...timing,
    });
  });
  return children.length === 0 ? undefined : children;
}

function executionError(metadata: Record<string, unknown>): string | undefined {
  const raw = metadata['error'];
  if (raw === true) return 'Code Mode execution failed.';
  if (typeof raw === 'string' && raw.trim() !== '') return sanitizeTerminalText(raw);
  if (isRecord(raw) && typeof raw['message'] === 'string' && raw['message'].trim() !== '') {
    return sanitizeTerminalText(raw['message']);
  }
  return undefined;
}

function toToolCall(
  part: Extract<SessionMessageAssistant['content'][number], { type: 'tool' }>,
  mapping: WireMappingOptions = {},
): ToolCall {
  const state: unknown = part.state;
  const status = isRecord(state) ? state['status'] : undefined;
  const normalized =
    status === 'streaming' || status === 'running' || status === 'completed' || status === 'error'
      ? status
      : 'running';
  const input = isRecord(state) && isRecord(state['input']) ? state['input'] : {};
  const content = isRecord(state)
    ? toolContent(state['content'], mapping.maxToolOutputChars ?? maxToolOutputChars)
    : undefined;
  const error =
    isRecord(state) && isRecord(state['error']) && typeof state['error']['message'] === 'string'
      ? sanitizeTerminalText(state['error']['message'])
      : undefined;
  const metadata = isRecord(state) && isRecord(state['metadata']) ? state['metadata'] : {};
  // OpenCode v2.3 edit/write tools report their patch as metadata.files[].patch; the patch
  // tool additionally reports metadata.diff (all files joined). Prefer the dedicated string
  // and fall back to the first file entry.
  const files = Array.isArray(metadata['files']) ? metadata['files'] : [];
  let diff =
    typeof metadata['diff'] === 'string' && metadata['diff'].trim() !== ''
      ? metadata['diff']
      : undefined;
  let diffFile =
    typeof metadata['filePath'] === 'string' && metadata['filePath'] !== ''
      ? metadata['filePath']
      : undefined;
  for (const entry of files) {
    if (!isRecord(entry)) continue;
    if (typeof entry['file'] === 'string' && entry['file'] !== '' && diffFile === undefined) {
      diffFile = entry['file'];
    }
  }
  if (diff === undefined) {
    for (const entry of files) {
      if (isRecord(entry) && typeof entry['patch'] === 'string' && entry['patch'].trim() !== '') {
        diff = entry['patch'];
        break;
      }
    }
  }
  diff = diff === undefined ? undefined : sanitizeTerminalText(diff);
  diffFile = diffFile === undefined ? undefined : sanitizeTerminalText(diffFile);
  // Servers may flag their own truncation in metadata; that takes precedence in the label.
  const serverTruncated = metadata['truncated'] === true;
  const outputTruncated = serverTruncated
    ? 'server'
    : content?.truncated === true
      ? 'frontend'
      : undefined;
  const children = toolChildren(metadata, part.id);
  const scriptError = executionError(metadata);
  return {
    id: part.id,
    name: sanitizeTerminalText(part.name),
    status: normalized,
    input,
    startedAt: part.time.created,
    ...(part.time.completed === undefined ? {} : { completedAt: part.time.completed }),
    ...(content === undefined || content.text === '' ? {} : { output: content.text }),
    ...(outputTruncated === undefined ? {} : { outputTruncated }),
    ...(content === undefined || content.files.length === 0 ? {} : { files: content.files }),
    ...(children === undefined ? {} : { children }),
    ...(scriptError === undefined ? {} : { executionError: scriptError }),
    ...(error === undefined ? {} : { error }),
    ...(diff === undefined || diff === '' ? {} : { diff }),
    ...(diffFile === undefined ? {} : { diffFile }),
  };
}

/**
 * Full retained result for one tool part, fetched on demand for the inspector (#221).
 * Uses the same mapping as the transcript but without the frontend character cap; a
 * server-declared truncation stays visible in `completeness`.
 */
export function toToolResult(
  message: SessionMessageAssistant,
  toolID: string,
): ToolResultPayload | undefined {
  const part = message.content.find(
    (entry): entry is Extract<(typeof message.content)[number], { type: 'tool' }> =>
      entry.type === 'tool' && entry.id === toolID,
  );
  if (part === undefined) return undefined;
  const tool = toToolCall(part, { maxToolOutputChars: Number.MAX_SAFE_INTEGER });
  const state: unknown = part.state;
  const metadata = isRecord(state) && isRecord(state['metadata']) ? state['metadata'] : {};
  const completeness = metadata['truncated'] === true ? 'server-truncated' : 'complete';
  return {
    ...(tool.output === undefined ? {} : { text: tool.output }),
    ...(tool.diff === undefined ? {} : { diff: tool.diff }),
    files: tool.files ?? [],
    ...(tool.executionError === undefined ? {} : { executionError: tool.executionError }),
    completeness,
  };
}

function toAssistantParts(
  message: SessionMessageAssistant,
  mapping: WireMappingOptions = {},
): AssistantPart[] {
  const parts: AssistantPart[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        parts.push({ kind: 'text', text: sanitizeTerminalText(part.text) });
        break;
      case 'reasoning':
        parts.push({
          kind: 'reasoning',
          text: sanitizeTerminalText(part.text),
          done: part.time?.completed !== undefined || message.time.completed !== undefined,
        });
        break;
      case 'tool':
        parts.push({ kind: 'tool', tool: toToolCall(part, mapping) });
        break;
      default:
        // Unknown part types from newer servers are skipped, not guessed at.
        break;
    }
  }
  return parts;
}

/** Returns `undefined` for message kinds this frontend does not render. */
export function toTranscriptMessage(
  message: SessionMessageInfo,
  mapping: WireMappingOptions = {},
): TranscriptMessage | undefined {
  switch (message.type) {
    case 'user':
      return {
        kind: 'user',
        id: message.id,
        createdAt: message.time.created,
        text: sanitizeTerminalText(message.text),
        // Attachment labels are untrusted display text, just like message bodies (#249).
        attachments: (message.files ?? []).map((file) =>
          sanitizeSingleLine(file.name ?? file.mime),
        ),
      };
    case 'assistant': {
      const model = toModelSelection(message.model) ?? { providerID: '?', modelID: '?' };
      // Keep the full per-step token categories for active-context accounting (#124) instead
      // of discarding everything but reasoning, as the footer used to.
      const usage = readTokens(message.tokens);
      return {
        kind: 'assistant',
        id: message.id,
        createdAt: message.time.created,
        agent: message.agent,
        model,
        parts: toAssistantParts(message, mapping),
        ...(message.time.completed === undefined ? {} : { completedAt: message.time.completed }),
        ...(message.tokens === undefined ? {} : { reasoningTokens: message.tokens.reasoning }),
        ...(usage === undefined ? {} : { usage }),
        ...(message.error === undefined
          ? {}
          : { error: sanitizeTerminalText(message.error.message) }),
      };
    }
    case 'shell': {
      const exit = typeof message.exit === 'number' ? message.exit : undefined;
      return {
        kind: 'shell',
        id: message.id,
        shellID: message.shellID,
        createdAt: message.time.created,
        command: sanitizeTerminalText(message.command),
        status: message.status,
        ...(exit === undefined ? {} : { exitCode: exit }),
        ...(message.output === undefined
          ? {}
          : { output: sanitizeTerminalText(message.output.output) }),
        ...(message.output?.truncated === true ? { outputTruncated: 'server' as const } : {}),
      };
    }
    case 'agent-switched':
      return {
        kind: 'agent-switched',
        id: message.id,
        createdAt: message.time.created,
        agent: message.agent,
      };
    case 'model-switched': {
      const model = toModelSelection(message.model);
      if (model === undefined) return undefined;
      return { kind: 'model-switched', id: message.id, createdAt: message.time.created, model };
    }
    case 'idle':
      return {
        kind: 'idle',
        id: message.id,
        createdAt: message.time.created,
        outcome: message.outcome,
        ...(message.error === undefined
          ? {}
          : { error: sanitizeTerminalText(message.error.message) }),
      };
    case 'compaction':
      return {
        kind: 'compaction',
        id: message.id,
        createdAt: message.time.created,
        state: message.status,
      };
    case 'synthetic':
    case 'system':
      return {
        kind: 'note',
        id: message.id,
        createdAt: message.time.created,
        text: sanitizeTerminalText(message.description ?? message.text),
        source: message.type,
      };
    default:
      return undefined;
  }
}

function options(list: readonly { value: string; label: string; description?: string }[]) {
  return list.map((option) => ({
    value: option.value,
    label: sanitizeTerminalText(option.label),
    ...(option.description === undefined
      ? {}
      : { description: sanitizeTerminalText(option.description) }),
  }));
}

/** Wire numbers may be the strings "Infinity"/"NaN"; only finite numbers are kept. */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Maps a server form; every displayed string is sanitized. Unknown field types fail closed. */
export function toFormRequest(info: FormInfo): FormRequest {
  return {
    id: info.id,
    sessionID: info.sessionID,
    title: sanitizeTerminalText(info.title),
    fields: info.fields.map(toFormField),
  };
}

function toFormField(field: WireFormField): FormField {
  const base = {
    key: field.key,
    title: sanitizeTerminalText(field.title ?? field.key),
    ...(field.description === undefined
      ? {}
      : { description: sanitizeTerminalText(field.description) }),
    required: 'required' in field && (field.required ?? false),
    hidden: 'hidden' in field ? field.hidden : false,
    when: ('when' in field ? (field.when ?? []) : []).flatMap((condition) =>
      typeof condition.value === 'string' ||
      typeof condition.value === 'number' ||
      typeof condition.value === 'boolean'
        ? [{ key: condition.key, op: condition.op, value: condition.value }]
        : [],
    ),
  };
  const stringConstraints = (): {
    format?: 'email' | 'uri' | 'date' | 'date-time';
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  } => {
    if (field.type !== 'string') return {};
    const minLength = finite(field.minLength);
    const maxLength = finite(field.maxLength);
    return {
      ...(field.format === undefined ? {} : { format: field.format }),
      ...(minLength === undefined ? {} : { minLength }),
      ...(maxLength === undefined ? {} : { maxLength }),
      ...(field.pattern === undefined ? {} : { pattern: field.pattern }),
    };
  };
  switch (field.type) {
    case 'string':
      if (field.options !== undefined && field.options.length > 0) {
        return {
          ...base,
          ...stringConstraints(),
          kind: 'choice',
          options: options(field.options),
          custom: field.custom === true,
          ...(field.default === undefined ? {} : { default: field.default }),
        };
      }
      return {
        ...base,
        ...stringConstraints(),
        kind: 'text',
        ...(field.placeholder === undefined
          ? {}
          : { placeholder: sanitizeTerminalText(field.placeholder) }),
        ...(field.default === undefined ? {} : { default: field.default }),
      };
    case 'multiselect':
      return {
        ...base,
        kind: 'multi',
        options: options(field.options),
        custom: field.custom === true,
        ...(field.minItems === undefined ? {} : { minItems: field.minItems }),
        ...(field.maxItems === undefined ? {} : { maxItems: field.maxItems }),
        ...(field.default === undefined ? {} : { default: field.default }),
      };
    case 'number':
    case 'integer': {
      const minimum = finite(field.minimum);
      const maximum = finite(field.maximum);
      const fallback = finite(field.default);
      return {
        ...base,
        kind: 'number',
        integer: field.type === 'integer',
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
        ...(fallback === undefined ? {} : { default: fallback }),
      };
    }
    case 'boolean':
      return {
        ...base,
        kind: 'boolean',
        ...(field.default === undefined ? {} : { default: field.default }),
      };
    case 'external':
      return { ...base, kind: 'external', url: sanitizeTerminalText(field.url) };
    default:
      throw new WireFormatError('Unknown form field type.');
  }
}

/** File paths are sanitized for display; patches are sanitized per line when rendered. */
export function toFileDiff(info: FileDiffInfo): FileDiff {
  return {
    file: sanitizeTerminalText(info.file),
    patch: info.patch,
    additions: info.additions,
    deletions: info.deletions,
    status: info.status,
    truncated: info.more === true,
  };
}

const workerStatuses = new Set<string>(['running', 'completed', 'error', 'cancelled']);

function isWorkerStatus(value: unknown): value is WorkerStatus {
  return typeof value === 'string' && workerStatuses.has(value);
}

/**
 * Maps one `experimental.job.list` entry into a worker row. Only the subagent variant is a
 * worker: shell/image jobs already have their own transcript treatment. A malformed or
 * future-variant entry is dropped rather than guessed into a status (#101).
 */
export function toWorkerJob(raw: unknown): WorkerJob | undefined {
  if (!isRecord(raw) || raw['kind'] !== 'subagent') return undefined;
  const id = raw['id'];
  const childSessionID = raw['childSessionID'];
  const agent = raw['agent'];
  const description = raw['description'];
  const status = raw['status'];
  const time = raw['time'];
  if (
    typeof id !== 'string' ||
    id === '' ||
    typeof childSessionID !== 'string' ||
    childSessionID === '' ||
    typeof agent !== 'string' ||
    typeof description !== 'string' ||
    !isWorkerStatus(status) ||
    !isRecord(time)
  ) {
    return undefined;
  }
  const startedAt = finite(time['started']);
  if (startedAt === undefined) return undefined;
  const title = raw['title'];
  const completedAt = finite(time['completed']);
  return {
    id,
    childSessionID,
    agent: sanitizeTerminalText(agent),
    description: sanitizeTerminalText(description),
    status,
    startedAt,
    ...(typeof title === 'string' && title !== '' ? { title: sanitizeTerminalText(title) } : {}),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

/**
 * Maps one `kind: 'shell'` job from `experimental.job.list`. v2.3.1 timed-out shells keep
 * running in the background; this is the server's authoritative confirmation (#103).
 */
export function toShellJob(raw: unknown): ShellJob | undefined {
  if (!isRecord(raw) || raw['kind'] !== 'shell') return undefined;
  const id = raw['id'];
  const shellID = raw['shellID'];
  const sessionID = raw['sessionID'];
  const status = raw['status'];
  const time = raw['time'];
  if (
    typeof id !== 'string' ||
    id === '' ||
    typeof shellID !== 'string' ||
    shellID === '' ||
    typeof sessionID !== 'string' ||
    !isWorkerStatus(status) ||
    !isRecord(time)
  ) {
    return undefined;
  }
  const startedAt = finite(time['started']);
  if (startedAt === undefined) return undefined;
  const title = raw['title'];
  const completedAt = finite(time['completed']);
  return {
    id,
    shellID,
    sessionID,
    status,
    startedAt,
    ...(typeof title === 'string' && title !== '' ? { title: sanitizeTerminalText(title) } : {}),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

/** The pending user follow-up that "send now" promotes: first queued (not steering) entry. */
export function nextQueuedUser(items: readonly QueuedInput[]): QueuedInput | undefined {
  return items.find((item) => item.kind === 'user' && item.delivery === 'queue');
}
