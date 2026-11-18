import type { TokenUsage } from './session.ts';

/**
 * Normalized server events the frontend reacts to. Everything else is ignored.
 * Events are hints: the canonical state is always re-read from the server.
 */
export type BackendEvent =
  | { kind: 'connected' }
  | { kind: 'session-changed'; sessionID: string }
  | { kind: 'session-deleted'; sessionID: string }
  | { kind: 'usage'; sessionID: string; cost: number; tokens: TokenUsage }
  | {
      kind: 'execution';
      sessionID: string;
      state: 'started' | 'succeeded' | 'failed' | 'interrupted';
      error?: string;
    }
  | { kind: 'transcript-changed'; sessionID: string }
  | { kind: 'inbox-changed'; sessionID: string }
  | { kind: 'input-requests-changed'; sessionID: string }
  | {
      kind: 'revert-changed';
      sessionID: string;
      action: 'staged' | 'cleared' | 'committed';
    }
  | { kind: 'catalog-changed' };

const transcriptEvents = new Set([
  'session.step.started',
  'session.step.ended',
  'session.step.failed',
  'session.step.first-token',
  'session.text.started',
  'session.text.delta',
  'session.text.ended',
  'session.reasoning.started',
  'session.reasoning.delta',
  'session.reasoning.ended',
  'session.tool.input.started',
  'session.tool.input.ended',
  'session.tool.called',
  'session.tool.progress',
  'session.tool.success',
  'session.tool.failed',
  'session.shell.started',
  'session.shell.ended',
  'session.compaction.started',
  'session.compaction.ended',
  'session.compaction.failed',
  'session.synthetic',
  'session.retry.scheduled',
  'session.message.content.updated',
  'session.idle',
]);

const summaryEvents = new Set([
  'session.created',
  'session.renamed',
  'session.moved',
  'session.archived',
  'session.unarchived',
  'session.agent.selected',
  'session.model.selected',
  'session.forked',
  'session.metadata.updated',
]);

const inboxEvents = new Set([
  'session.inbox.enqueued',
  'session.inbox.delivered',
  'session.inbox.cancelled',
  'session.inbox.delivery.changed',
]);

const requestEvents = new Set([
  'permission.asked',
  'permission.replied',
  'form.created',
  'form.replied',
  'form.cancelled',
]);

const catalogEvents = new Set(['agent.updated', 'model.updated', 'provider.updated']);

/**
 * Validates and normalizes one raw stream event. Unknown or malformed events yield
 * `undefined`; they must never mutate state (e.g. reset usage to zero).
 */
export function normalizeEvent(raw: unknown): BackendEvent | undefined {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') return undefined;
  const type = raw['type'];
  if (type === 'server.connected') return { kind: 'connected' };
  if (catalogEvents.has(type)) return { kind: 'catalog-changed' };
  const data = raw['data'];
  if (!isRecord(data)) return undefined;
  const sessionID = data['sessionID'];
  if (typeof sessionID !== 'string') return undefined;

  if (type === 'session.usage.updated') {
    const tokens = readTokens(data['tokens']);
    const cost = data['cost'];
    if (tokens === undefined || typeof cost !== 'number') return undefined;
    return { kind: 'usage', sessionID, cost, tokens };
  }
  if (type === 'session.deleted') return { kind: 'session-deleted', sessionID };
  if (type.startsWith('session.execution.')) {
    const state = type.slice('session.execution.'.length);
    if (
      state !== 'started' &&
      state !== 'succeeded' &&
      state !== 'failed' &&
      state !== 'interrupted'
    ) {
      return undefined;
    }
    const error = isRecord(data['error']) ? data['error']['message'] : undefined;
    return {
      kind: 'execution',
      sessionID,
      state,
      ...(typeof error === 'string' ? { error } : {}),
    };
  }
  if (transcriptEvents.has(type)) return { kind: 'transcript-changed', sessionID };
  if (summaryEvents.has(type)) return { kind: 'session-changed', sessionID };
  if (type === 'session.revert.staged') {
    return { kind: 'revert-changed', sessionID, action: 'staged' };
  }
  if (type === 'session.revert.cleared') {
    return { kind: 'revert-changed', sessionID, action: 'cleared' };
  }
  if (type === 'session.revert.committed') {
    return { kind: 'revert-changed', sessionID, action: 'committed' };
  }
  if (inboxEvents.has(type)) return { kind: 'inbox-changed', sessionID };
  if (requestEvents.has(type)) return { kind: 'input-requests-changed', sessionID };
  return undefined;
}

export function readTokens(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const cache = isRecord(value['cache']) ? value['cache'] : {};
  const input = value['input'];
  const output = value['output'];
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  return {
    input,
    output,
    reasoning: numberOr(value['reasoning'], 0),
    cacheRead: numberOr(cache['read'], 0),
    cacheWrite: numberOr(cache['write'], 0),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
