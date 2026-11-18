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
}>;

/**
 * Single-line footer, degrading with width. Tokens and spend are dropped last.
 * Token figures are cumulative session usage (input/output), not context occupancy.
 */
export function formatFooter(facts: FooterFacts, width: number): string {
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
  const agent = facts.agent ?? '—';
  const model =
    facts.model === undefined
      ? 'default model'
      : `${facts.model.modelID}${facts.model.variant === undefined ? '' : `#${facts.model.variant}`}`;
  const variant = facts.model?.variant;
  const queued = facts.queued > 0 ? `${facts.queued} queued` : undefined;

  const candidates: (string | undefined)[][] = [
    [`${agent} (shift+tab)`, model, facts.state, queued, tokensLong, cost],
    [agent, model, facts.state, queued, tokensLong, cost],
    [agent, model, facts.state, tokensShort, cost],
    [agent, variant, facts.state, tokensShort, cost],
    [agent, tokensShort, cost],
    [tokensShort, cost],
  ];
  for (const parts of candidates) {
    const line = parts.filter((part) => part !== undefined && part !== '').join(' · ');
    if (line.length <= width) return line;
  }
  return `${tokensShort} · ${cost}`.slice(0, Math.max(0, width));
}
