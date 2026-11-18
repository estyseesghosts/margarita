export type AgentDescriptor = Readonly<{
  id: string;
  name: string;
  mode: 'primary' | 'subagent' | 'all';
  hidden: boolean;
  description?: string;
}>;

/**
 * Selectable agents in cycle order: configured order first (default `build`, `plan`),
 * then remaining primary agents alphabetically. Hidden and subagent-only entries are excluded.
 */
export function selectableAgents(
  agents: readonly AgentDescriptor[],
  preferredOrder: readonly string[],
): AgentDescriptor[] {
  const selectable = agents.filter((agent) => !agent.hidden && agent.mode !== 'subagent');
  const preferred = preferredOrder.flatMap((id) => selectable.filter((agent) => agent.id === id));
  const rest = selectable
    .filter((agent) => !preferredOrder.includes(agent.id))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  return [...preferred, ...rest];
}

/** Next agent after `current`, wrapping. Unknown current starts at the first agent. */
export function nextAgent(
  agents: readonly AgentDescriptor[],
  current: string | undefined,
  direction: 1 | -1 = 1,
): AgentDescriptor | undefined {
  if (agents.length === 0) return undefined;
  const index = agents.findIndex((agent) => agent.id === current);
  if (index === -1) return agents[0];
  return agents[(index + direction + agents.length) % agents.length];
}

/** `build` if available, otherwise the first selectable agent. */
export function defaultAgent(
  agents: readonly AgentDescriptor[],
  preferred: string,
): AgentDescriptor | undefined {
  return agents.find((agent) => agent.id === preferred) ?? agents[0];
}
