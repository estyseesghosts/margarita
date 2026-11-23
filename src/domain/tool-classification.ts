/**
 * Pure tool identity and classification (#319).
 *
 * This module has no transcript, store, network or renderer dependencies. It is
 * shared by folding, previews and summaries so an MCP call is never mistaken for
 * a built-in tool in one of those paths.
 */

/** The display/activity category of one tool call. */
export type ToolCategory =
  'read' | 'search' | 'edit' | 'shell' | 'code' | 'web' | 'delegate' | 'other';

const categoryByName: Readonly<Record<string, ToolCategory>> = {
  read: 'read',
  view: 'read',
  list: 'search',
  ls: 'search',
  glob: 'search',
  grep: 'search',
  search: 'search',
  codesearch: 'search',
  edit: 'edit',
  write: 'edit',
  patch: 'edit',
  apply_patch: 'edit',
  multiedit: 'edit',
  bash: 'shell',
  shell: 'shell',
  // Code Mode is a script host, not a shell; nested calls carry the real activity (#217).
  execute: 'code',
  webfetch: 'web',
  websearch: 'web',
  fetch: 'web',
  task: 'delegate',
  agent: 'delegate',
  subagent: 'delegate',
};

const builtinCategories = new Set(Object.keys(categoryByName));

/**
 * What one call is. Built-ins are matched by name. OpenCode v2 registers MCP tools as
 * `<normalizedName(server)>_<normalizedName(tool)>`, so a configured server's flattened
 * prefix recovers the server; a call matching no configured server stays honestly
 * external instead of being attributed to one (issue #74).
 */
export type ToolIdentity =
  | Readonly<{ kind: 'builtin'; category: ToolCategory }>
  | Readonly<{ kind: 'mcp'; server: string; tool: string }>
  | Readonly<{ kind: 'external' }>;

/** The flattened registry namespace for an MCP server name (upstream `normalizedName`). */
export function mcpNamespace(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** True when the name is one of the built-in tools Margarita knows how to categorise. */
export function isBuiltinToolName(name: string): boolean {
  return builtinCategories.has(name.toLowerCase());
}

/** The longest matching configured server prefix wins; servers `a` and `a_b` stay distinct. */
export function toolIdentity(name: string, mcpServers: readonly string[] = []): ToolIdentity {
  const builtin = categoryByName[name.toLowerCase()];
  if (builtin !== undefined) return { kind: 'builtin', category: builtin };
  const matched = mcpServers
    .flatMap((server) => {
      const namespace = mcpNamespace(server);
      return [
        { server, prefix: `${namespace}_` },
        // Code Mode reports nested calls with a qualified `<server>.<tool>` name.
        { server, prefix: `${namespace}.` },
      ];
    })
    .filter((entry) => entry.prefix.length > 1 && name.startsWith(entry.prefix))
    .toSorted((left, right) => right.prefix.length - left.prefix.length)[0];
  if (matched === undefined) return { kind: 'external' };
  return { kind: 'mcp', server: matched.server, tool: name.slice(matched.prefix.length) };
}

/** Maps a built-in tool name to its category, or `other` for MCP/external tools. */
export function classifyTool(name: string): ToolCategory {
  return categoryByName[name.toLowerCase()] ?? 'other';
}
