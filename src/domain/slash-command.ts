/** Frontend-local slash commands. These always win over server commands of the same name. */
export const localCommands = {
  sessions: 'Return to the session overview',
  bg: 'Return to the session overview',
  new: 'Start a new session in this project',
  resume: 'Open the overview to pick a session',
  agent: 'Switch agent: /agent <id>',
  model: 'Pick or set model: /model [provider/model#variant]',
  effort: 'Set variant for the current model: /effort <variant>',
  transcript: 'Toggle detailed transcript',
  diff: 'Files changed: /diff (session) or /diff turn (since your last message)',
  usage: 'Show token and spend breakdown',
  interrupt: 'Stop the running turn',
  queue: 'Show queued inputs',
  export: 'Save the whole chat log as JSON: /export [file]',
  criteria: 'Acceptance criteria for the session (local): /criteria a; b',
  plan: 'Plan: /plan <steps> · /plan propose · /plan adopt · /plan accept|reject|clear',
  rename: 'Rename this session: /rename <title>',
  fork: 'Fork this session into a new one',
  revert: 'Undo file changes since your last message (asks to confirm)',
  steer: 'Send text with steer delivery: /steer <text>',
  status: 'Connection and session details',
  keys: 'Show key bindings',
  help: 'Show help',
  quit: 'Exit (the session keeps running on the server)',
  server: 'Run a server command explicitly: /server <name> [args]',
} as const;

export type LocalCommandName = keyof typeof localCommands;

export type ParsedInput =
  | { kind: 'prompt'; text: string }
  | { kind: 'shell'; command: string }
  | { kind: 'local'; name: LocalCommandName; args: string }
  | { kind: 'server'; name: string; args: string }
  | { kind: 'unknown-command'; name: string };

/**
 * Classifies submitted composer text. `/name` is only a command at the very start;
 * `!` at the start is user shell mode. A local verb is never sent as a model prompt.
 */
export function parseInput(text: string, serverCommands: ReadonlySet<string>): ParsedInput {
  if (text.startsWith('!')) return { kind: 'shell', command: text.slice(1).trim() };
  if (!text.startsWith('/')) return { kind: 'prompt', text };
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  if (match === null) return { kind: 'prompt', text };
  const name = match[1] ?? '';
  const args = (match[2] ?? '').trim();
  if (isLocalCommand(name)) {
    if (name === 'server') {
      const inner = /^(\S+)\s*([\s\S]*)$/.exec(args);
      if (inner === null) return { kind: 'unknown-command', name: 'server' };
      return { kind: 'server', name: inner[1] ?? '', args: (inner[2] ?? '').trim() };
    }
    return { kind: 'local', name, args };
  }
  if (serverCommands.has(name)) return { kind: 'server', name, args };
  return { kind: 'unknown-command', name };
}

export function isLocalCommand(name: string): name is LocalCommandName {
  return Object.hasOwn(localCommands, name);
}

/** Completion candidates for a `/prefix` typed at the start of the composer. */
export function completeCommand(
  text: string,
  serverCommands: readonly { name: string; description?: string }[],
): { name: string; description: string }[] {
  if (!text.startsWith('/') || /\s/.test(text)) return [];
  const prefix = text.slice(1);
  const local = Object.entries(localCommands)
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, description]) => ({ name, description }));
  const server = serverCommands
    .filter((command) => command.name.startsWith(prefix) && !isLocalCommand(command.name))
    .map((command) => ({
      name: command.name,
      description: command.description ?? 'server command',
    }));
  return [...local, ...server];
}
