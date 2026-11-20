import type { ModelSelection } from './model-ref.ts';
import type { TokenUsage } from './session.ts';
import { formatCost, formatTokenCount } from './usage-format.ts';

export type FooterFacts = Readonly<{
  agent?: string;
  model?: ModelSelection;
  state: string;
  tokens?: TokenUsage;
  cost?: number;
  queued: number;
  stale: boolean;
  /** Compact native-goal badge (e.g. `◎ goal · round 2`); dropped early to fit width. */
  goal?: string;
  /**
   * Validated current-context occupancy percentage (0–100), when a source supplies one.
   * Cumulative session tokens are NOT occupancy and must never be used here.
   */
  contextOccupancy?: number;
}>;

export type FooterSegmentKind =
  'agent' | 'model' | 'state' | 'queued' | 'goal' | 'context' | 'tokens' | 'cost' | 'separator';

export type FooterSegment = Readonly<{ text: string; kind: FooterSegmentKind }>;

type Part = Readonly<{ text: string; kind: Exclude<FooterSegmentKind, 'separator'> }>;

/** Single-line footer fields, degrading with width. Token figures are cumulative session usage. */
function partsFor(facts: FooterFacts): (Part | undefined)[][] {
  const mark = facts.stale ? '~' : '';
  const tokensLong =
    facts.tokens === undefined
      ? '— tokens'
      : `${mark}${formatTokenCount(facts.tokens.input)} in · ${formatTokenCount(facts.tokens.output)} out`;
  const tokensShort =
    facts.tokens === undefined
      ? '—'
      : `${mark}${formatTokenCount(facts.tokens.input + facts.tokens.output)}`;
  const cost = `${mark}${formatCost(facts.cost)}`;
  const agent: Part = { text: facts.agent ?? '—', kind: 'agent' };
  const model: Part = {
    text:
      facts.model === undefined
        ? 'default model'
        : `${facts.model.modelID}${facts.model.variant === undefined ? '' : `#${facts.model.variant}`}`,
    kind: 'model',
  };
  const variant: Part | undefined =
    facts.model?.variant === undefined ? undefined : { text: facts.model.variant, kind: 'model' };
  const state: Part = { text: facts.state, kind: 'state' };
  const queued: Part | undefined =
    facts.queued > 0 ? { text: `${facts.queued} queued`, kind: 'queued' } : undefined;
  const goal: Part | undefined =
    facts.goal === undefined || facts.goal === '' ? undefined : { text: facts.goal, kind: 'goal' };
  const context: Part | undefined =
    facts.contextOccupancy === undefined
      ? undefined
      : { text: `${Math.round(facts.contextOccupancy)}% context`, kind: 'context' };
  const tokensLongPart: Part = { text: tokensLong, kind: 'tokens' };
  const tokensShortPart: Part = { text: tokensShort, kind: 'tokens' };
  const costPart: Part = { text: cost, kind: 'cost' };

  return [
    [agent, model, state, queued, goal, context, tokensLongPart, costPart],
    [agent, model, state, goal, tokensShortPart, costPart],
    [agent, variant, state, goal, tokensShortPart, costPart],
    [agent, goal, tokensShortPart, costPart],
    [goal, tokensShortPart, costPart],
    [agent, model, state, queued, tokensLongPart, costPart],
    [agent, model, state, tokensShortPart, costPart],
    [agent, variant, state, tokensShortPart, costPart],
    [agent, tokensShortPart, costPart],
    [tokensShortPart, costPart],
  ];
}

function join(parts: readonly Part[]): FooterSegment[] {
  const segments: FooterSegment[] = [];
  parts.forEach((part, index) => {
    if (index > 0) segments.push({ text: ' · ', kind: 'separator' });
    segments.push(part);
  });
  return segments;
}

/** Semantic segments for styled rendering; identical text to `formatFooter`. */
export function footerSegments(facts: FooterFacts, width: number): FooterSegment[] {
  for (const parts of partsFor(facts)) {
    const present = parts.filter((part): part is Part => part !== undefined && part.text !== '');
    if (present.map((part) => part.text).join(' · ').length <= width) return join(present);
  }
  const tokensShort =
    facts.tokens === undefined
      ? '—'
      : `${facts.stale ? '~' : ''}${formatTokenCount(facts.tokens.input + facts.tokens.output)}`;
  const cost = `${facts.stale ? '~' : ''}${formatCost(facts.cost)}`;
  const line = `${tokensShort} · ${cost}`.slice(0, Math.max(0, width));
  const split = line.indexOf(' · ');
  if (split < 0) return [{ text: line, kind: 'tokens' }];
  return [
    { text: line.slice(0, split), kind: 'tokens' },
    { text: ' · ', kind: 'separator' },
    { text: line.slice(split + 3), kind: 'cost' },
  ];
}

/** Single-line footer, degrading with width. */
export function formatFooter(facts: FooterFacts, width: number): string {
  return footerSegments(facts, width)
    .map((segment) => segment.text)
    .join('');
}
