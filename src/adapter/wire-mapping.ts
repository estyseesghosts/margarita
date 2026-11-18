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
import { isRecord, readTokens } from '../domain/backend-event.ts';
import type { FileDiff } from '../domain/diff.ts';
import type { FormField, FormRequest } from '../domain/form.ts';
import type { ModelSelection } from '../domain/model-ref.ts';
import type { CatalogModel } from '../domain/model-resolution.ts';
import { sanitizeTerminalText } from '../domain/sanitize-text.ts';
import type { SessionSummary } from '../domain/session.ts';
import type { AssistantPart, ToolCall, TranscriptMessage } from '../domain/transcript.ts';

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
    ...(typeof variant === 'string' && variant !== '' ? { variant } : {}),
  };
}

export function toSessionSummary(info: SessionInfo): SessionSummary {
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
  return {
    providerID: model.providerID,
    modelID: model.id,
    name: model.name,
    enabled: model.enabled,
    variants: model.variants.map((variant) => variant.id),
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
}>;

export function toQueuedInput(item: SessionInboxInfo): QueuedInput {
  const payload: unknown = item.payload;
  const text = isRecord(payload) && typeof payload['text'] === 'string' ? payload['text'] : '';
  return {
    id: item.id,
    kind: item.type,
    delivery: item.delivery,
    text,
    createdAt: item.time.created,
  };
}

const maxToolOutputChars = 64_000;

function toolText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((entry: unknown) => {
      if (!isRecord(entry)) return '';
      if (entry['type'] === 'text' && typeof entry['text'] === 'string') return entry['text'];
      if (entry['type'] === 'file' && typeof entry['uri'] === 'string') {
        return `[file ${entry['uri']}]`;
      }
      return '';
    })
    .join('\n');
  // Bounded: transcripts must not hold unbounded tool output in memory.
  const capped =
    text.length > maxToolOutputChars
      ? `${text.slice(0, maxToolOutputChars)}\n… output truncated (${text.length} chars)`
      : text;
  return sanitizeTerminalText(capped);
}

function toToolCall(
  part: Extract<SessionMessageAssistant['content'][number], { type: 'tool' }>,
): ToolCall {
  const state: unknown = part.state;
  const status = isRecord(state) ? state['status'] : undefined;
  const normalized =
    status === 'streaming' || status === 'running' || status === 'completed' || status === 'error'
      ? status
      : 'running';
  const input = isRecord(state) && isRecord(state['input']) ? state['input'] : {};
  const output = isRecord(state) ? toolText(state['content']) : undefined;
  const error =
    isRecord(state) && isRecord(state['error']) && typeof state['error']['message'] === 'string'
      ? sanitizeTerminalText(state['error']['message'])
      : undefined;
  const metadata = isRecord(state) && isRecord(state['metadata']) ? state['metadata'] : {};
  const diff = typeof metadata['diff'] === 'string' ? metadata['diff'] : undefined;
  return {
    id: part.id,
    name: sanitizeTerminalText(part.name),
    status: normalized,
    input,
    startedAt: part.time.created,
    ...(part.time.completed === undefined ? {} : { completedAt: part.time.completed }),
    ...(output === undefined || output === '' ? {} : { output }),
    ...(error === undefined ? {} : { error }),
    ...(diff === undefined || diff === '' ? {} : { diff }),
  };
}

function toAssistantParts(message: SessionMessageAssistant): AssistantPart[] {
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
        parts.push({ kind: 'tool', tool: toToolCall(part) });
        break;
      default:
        // Unknown part types from newer servers are skipped, not guessed at.
        break;
    }
  }
  return parts;
}

/** Returns `undefined` for message kinds this frontend does not render. */
export function toTranscriptMessage(message: SessionMessageInfo): TranscriptMessage | undefined {
  switch (message.type) {
    case 'user':
      return {
        kind: 'user',
        id: message.id,
        createdAt: message.time.created,
        text: sanitizeTerminalText(message.text),
        attachments: (message.files ?? []).map((file) => file.name ?? file.mime),
      };
    case 'assistant': {
      const model = toModelSelection(message.model) ?? { providerID: '?', modelID: '?' };
      return {
        kind: 'assistant',
        id: message.id,
        createdAt: message.time.created,
        agent: message.agent,
        model,
        parts: toAssistantParts(message),
        ...(message.time.completed === undefined ? {} : { completedAt: message.time.completed }),
        ...(message.tokens === undefined ? {} : { reasoningTokens: message.tokens.reasoning }),
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
        createdAt: message.time.created,
        command: sanitizeTerminalText(message.command),
        status: message.status,
        ...(exit === undefined ? {} : { exitCode: exit }),
        ...(message.output === undefined
          ? {}
          : { output: sanitizeTerminalText(message.output.output) }),
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
    when: ('when' in field ? (field.when ?? []) : []).flatMap((condition) =>
      typeof condition.value === 'string' ||
      typeof condition.value === 'number' ||
      typeof condition.value === 'boolean'
        ? [{ key: condition.key, op: condition.op, value: condition.value }]
        : [],
    ),
  };
  switch (field.type) {
    case 'string':
      if (field.options !== undefined && field.options.length > 0) {
        return {
          ...base,
          kind: 'choice',
          options: options(field.options),
          custom: field.custom === true,
          ...(field.default === undefined ? {} : { default: field.default }),
        };
      }
      return {
        ...base,
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
