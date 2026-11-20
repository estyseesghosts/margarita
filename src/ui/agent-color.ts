import type { Theme } from './theme.ts';

/**
 * Deterministic agent colour: built-ins get their fixed semantic colours, and a custom
 * agent gets a stable palette slot derived from its ID, so the same ID keeps its colour
 * across sessions, restarts and servers. This is never the only signal: the agent ID is
 * still rendered as text.
 */
export function agentColor(agent: string | undefined, theme: Theme): string {
  if (agent === undefined || agent === '' || agent === '—') return theme.dim;
  if (agent === 'build') return theme.agentBuild;
  if (agent === 'plan') return theme.agentPlan;
  const palette = theme.agentPalette;
  if (palette.length === 0) return theme.dim;
  let hash = 0;
  for (let index = 0; index < agent.length; index += 1) {
    hash = (hash * 31 + agent.charCodeAt(index)) >>> 0;
  }
  return palette[hash % palette.length]!;
}
