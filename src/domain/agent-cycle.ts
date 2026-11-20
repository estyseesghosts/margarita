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
  // Backend result order is not a contract. De-duplicate by ID and sort the remainder so
  // cycling and the picker are stable across refreshes, hosts and catalog ordering (#123).
  const byID = new Map<string, AgentDescriptor>();
  for (const agent of agents) {
    if (agent.hidden || agent.mode === 'subagent') continue;
    if (!byID.has(agent.id)) byID.set(agent.id, agent);
  }
  const preferred = preferredOrder.flatMap((id) => {
    const agent = byID.get(id);
    return agent === undefined ? [] : [agent];
  });
  const rest = [...byID.values()]
    .filter((agent) => !preferredOrder.includes(agent.id))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  return [...preferred, ...rest];
}

/** Picker rows matching all whitespace-separated query tokens, in stable cycle order. */
export function filterAgents(agents: readonly AgentDescriptor[], query: string): AgentDescriptor[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== '');
  if (tokens.length === 0) return [...agents];
  return agents.filter((agent) => {
    const haystack = `${agent.id} ${agent.name} ${agent.description ?? ''}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
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
