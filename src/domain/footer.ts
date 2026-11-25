import { strings } from '../i18n/index.ts';
import type { ModelSelection } from './model-ref.ts';
import type { TokenUsage } from './session.ts';
import { formatCost, formatTokenCount } from './usage-format.ts';

export type FooterFacts = Readonly<{
  agent?: string;
  model?: ModelSelection;
  state: string;
  /** Why no model is shown: the scoped catalog is still loading or could not provide one. */
  modelStatus?: 'loading' | 'unavailable';
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
  /** Active-context tokens from the latest step, shown without a percentage when no limit is known. */
  contextTokens?: number;
}>;

export type FooterSegmentKind =
  'agent' | 'model' | 'state' | 'queued' | 'goal' | 'context' | 'tokens' | 'cost' | 'separator';

/** Stable identifiers for the three clickable footer controls (#124). */
export type FooterAction = 'agent' | 'model' | 'context';

export type FooterSegment = Readonly<{
  text: string;
  kind: FooterSegmentKind;
  action?: FooterAction;
}>;

type Part = Readonly<{
  text: string;
  kind: Exclude<FooterSegmentKind, 'separator'>;
  action?: FooterAction;
}>;

/** Single-line footer fields, degrading with width. Token figures are cumulative session usage. */
function partsFor(facts: FooterFacts): (Part | undefined)[][] {
  const mark = facts.stale ? '~' : '';
  // Unknown data produces no segment at all; a confirmed zero is still shown (#193).
  const tokensLongPart: Part | undefined =
    facts.tokens === undefined
      ? undefined
      : {
          text: strings.chrome.footer.tokensInOut(
            mark,
            formatTokenCount(facts.tokens.input),
            formatTokenCount(facts.tokens.output),
          ),
          kind: 'tokens',
        };
  const tokensShortPart: Part | undefined =
    facts.tokens === undefined
      ? undefined
      : {
          text: strings.chrome.footer.tokensTotal(
            mark,
            formatTokenCount(facts.tokens.input + facts.tokens.output),
          ),
          kind: 'tokens',
        };
  const costPart: Part | undefined =
    facts.cost === undefined
      ? undefined
      : { text: `${mark}${formatCost(facts.cost)}`, kind: 'cost' };
  const agent: Part | undefined =
    facts.agent === undefined ? undefined : { text: facts.agent, kind: 'agent', action: 'agent' };
  const model: Part | undefined =
    facts.model !== undefined
      ? {
          text: `${facts.model.modelID}${facts.model.variant === undefined ? '' : `#${facts.model.variant}`}`,
          kind: 'model',
          action: 'model',
        }
      : facts.modelStatus === undefined
        ? undefined
        : { text: modelStatusText[facts.modelStatus], kind: 'model', action: 'model' };
  const variant: Part | undefined =
    facts.model?.variant === undefined
      ? undefined
      : { text: facts.model.variant, kind: 'model', action: 'model' };
  const state: Part = { text: facts.state, kind: 'state' };
  const queued: Part | undefined =
    facts.queued > 0
      ? { text: strings.chrome.footer.queued(facts.queued), kind: 'queued' }
      : undefined;
  const goal: Part | undefined =
    facts.goal === undefined || facts.goal === '' ? undefined : { text: facts.goal, kind: 'goal' };
  const context: Part | undefined =
    facts.contextOccupancy !== undefined
      ? {
          text: strings.chrome.footer.contextPercent(Math.round(facts.contextOccupancy)),
          kind: 'context',
          action: 'context',
        }
      : facts.contextTokens === undefined
        ? undefined
        : {
            text: strings.chrome.footer.contextTokens(formatTokenCount(facts.contextTokens)),
            kind: 'context',
            action: 'context',
          };

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
    [agent, model, state],
    [agent, state],
    [agent],
    [state],
  ];
}

const modelStatusText = {
  loading: strings.chrome.footer.loadingModel,
  unavailable: strings.chrome.footer.modelUnavailable,
} as const;

function join(parts: readonly Part[]): FooterSegment[] {
  const segments: FooterSegment[] = [];
  parts.forEach((part, index) => {
    if (index > 0) segments.push({ text: ' · ', kind: 'separator' });
    segments.push(part);
  });
  return segments;
}

/** Semantic segments for styled rendering; identical text to `formatFooter`. */
export function footerSegments(
  facts: FooterFacts,
  width: number,
  enabled?: readonly FooterField[],
): FooterSegment[] {
  let last: Part[] = [];
  for (const parts of partsFor(facts)) {
    const present = parts.filter(
      (part): part is Part =>
        part !== undefined &&
        part.text !== '' &&
        (enabled === undefined || enabled.includes(part.kind)),
    );
    if (present.length === 0) continue;
    // Rows that drop the state exist to keep usage figures; with no usage they would only
    // lose information, so the state-bearing rows below take over (#193).
    const keepsUsage = present.some((part) => part.kind === 'tokens' || part.kind === 'cost');
    if (!keepsUsage && !present.some((part) => part.kind === 'state')) continue;
    last = present;
    if (present.map((part) => part.text).join(' · ').length <= width) return join(present);
  }
  // Nothing fits: keep the highest-priority remaining field, truncated to the width.
  const first = last[0];
  if (first === undefined) return [];
  return [{ ...first, text: first.text.slice(0, Math.max(0, width)) }];
}

/** Single-line footer, degrading with width. */
export function formatFooter(facts: FooterFacts, width: number): string {
  return footerSegments(facts, width)
    .map((segment) => segment.text)
    .join('');
}

/**
 * Configured footer fields. Omitted means all fields; filtering happens before width
 * degradation so excluded fields never consume space. `separator` is layout, not a field.
 */
export type FooterField = Exclude<FooterSegmentKind, 'separator'>;
