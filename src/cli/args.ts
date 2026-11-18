export type StartTarget =
  | { kind: 'overview' }
  | { kind: 'new'; prompt?: string }
  | { kind: 'continue'; prompt?: string }
  | { kind: 'resume'; sessionID: string; prompt?: string };

export type CliOptions = Readonly<{
  target: StartTarget;
  print: boolean;
  json: boolean;
  provider?: string;
  model?: string;
  effort?: string;
  agent?: string;
  cwd?: string;
  server?: string;
  /** Shortname of a persistent server profile to use instead of the local service. */
  remote?: string;
  /** Force the local service even when a default remote exists. */
  local: boolean;
  startServer: boolean;
  config?: string;
  debugLog?: string;
}>;

export type ParsedArgs =
  | { kind: 'run'; options: CliOptions }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

const valueFlags = new Map<string, keyof MutableValues>([
  ['--provider', 'provider'],
  ['--model', 'model'],
  ['-m', 'model'],
  ['--effort', 'effort'],
  ['--agent', 'agent'],
  ['--cwd', 'cwd'],
  ['--server', 'server'],
  ['--remote', 'remote'],
  ['--config', 'config'],
  ['--debug-log', 'debugLog'],
]);

type MutableValues = {
  provider?: string;
  model?: string;
  effort?: string;
  agent?: string;
  cwd?: string;
  server?: string;
  remote?: string;
  config?: string;
  debugLog?: string;
};

/**
 * Parses argv (without the runtime and script). A positional prompt always starts an
 * interactive session; only `--print` is noninteractive.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values: MutableValues = {};
  const positional: string[] = [];
  let print = false;
  let json = false;
  let startServer = false;
  let local = false;
  let continueLast = false;
  let resume: { id?: string } | undefined;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? '';
    if (raw === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? undefined : raw.slice(equals + 1);

    const valueKey = valueFlags.get(flag);
    if (valueKey !== undefined) {
      const value = inline ?? argv[index + 1];
      if (value === undefined || (inline === undefined && value.startsWith('-'))) {
        return { kind: 'error', message: `${flag} requires a value.` };
      }
      if (values[valueKey] !== undefined) {
        return { kind: 'error', message: `${flag} was given more than once.` };
      }
      values[valueKey] = value;
      if (inline === undefined) index += 1;
      continue;
    }
    switch (flag) {
      case '--print':
      case '-p':
        print = true;
        continue;
      case '--json':
        json = true;
        continue;
      case '--start-server':
        startServer = true;
        continue;
      case '--local':
        local = true;
        continue;
      case '--continue':
      case '-c':
        continueLast = true;
        continue;
      case '--resume':
      case '-r': {
        const next = inline ?? argv[index + 1];
        // Session IDs are recognizable; anything else is treated as the prompt.
        if (next !== undefined && next.startsWith('ses_')) {
          resume = { id: next };
          if (inline === undefined) index += 1;
        } else {
          resume = {};
        }
        continue;
      }
      case '--help':
      case '-h':
        help = true;
        continue;
      case '--version':
      case '-v':
        version = true;
        continue;
      default:
        if (raw.startsWith('-') && raw !== '-') {
          return { kind: 'error', message: `Unknown option ${flag}. See --help.` };
        }
        positional.push(raw);
    }
  }

  if (help) return { kind: 'help' };
  if (version) return { kind: 'version' };

  const prompt = positional.length === 0 ? undefined : positional.join(' ');
  if (json && !print) return { kind: 'error', message: '--json requires --print.' };
  if (continueLast && resume !== undefined) {
    return { kind: 'error', message: '--continue and --resume cannot be combined.' };
  }
  if (values.server !== undefined && startServer) {
    return { kind: 'error', message: '--server and --start-server cannot be combined.' };
  }
  if (values.remote !== undefined && local) {
    return { kind: 'error', message: '--remote and --local cannot be combined.' };
  }
  if (values.remote !== undefined && values.server !== undefined) {
    return { kind: 'error', message: '--remote and --server cannot be combined.' };
  }
  if (values.remote !== undefined && startServer) {
    return { kind: 'error', message: '--remote and --start-server cannot be combined.' };
  }
  if (local && values.server !== undefined) {
    return { kind: 'error', message: '--local and --server cannot be combined.' };
  }

  let target: StartTarget;
  if (resume !== undefined) {
    if (resume.id === undefined) {
      if (prompt !== undefined) {
        return {
          kind: 'error',
          message:
            '--resume without an ID opens the overview; drop the prompt or pass a session ID.',
        };
      }
      target = { kind: 'overview' };
    } else {
      target = {
        kind: 'resume',
        sessionID: resume.id,
        ...(prompt === undefined ? {} : { prompt }),
      };
    }
  } else if (continueLast) {
    target = { kind: 'continue', ...(prompt === undefined ? {} : { prompt }) };
  } else if (prompt !== undefined) {
    target = { kind: 'new', prompt };
  } else {
    target = { kind: 'new' };
  }

  if (print && (target.kind === 'overview' || target.prompt === undefined)) {
    return { kind: 'error', message: '--print needs a prompt.' };
  }

  return {
    kind: 'run',
    options: { ...values, target, print, json, local, startServer },
  };
}

export const helpText = `marg (margarita) — a conversation-first terminal frontend for OpenCode

Usage:
  marg [options] [prompt...]

With no prompt, opens a new session in the current directory (Left on an empty
prompt shows the overview). A prompt is sent as the first turn of that session.

Options:
  --provider <id>        Provider for --model
  -m, --model <ref>      Model ID or provider/model[#variant]
  --effort <variant>     Model variant (validated against the catalog)
  --agent <id>           Initial agent (default: build)
  --cwd <path>           Project directory for new sessions (default: current directory)
  -c, --continue         Continue the most recent session in this directory
  -r, --resume [ses_id]  Resume a session by ID, or open the overview
  -p, --print            Noninteractive: send the prompt, print the answer, exit
  --json                 With --print, print the turn's transcript messages as NDJSON once it ends (buffered, not live)
  --server <url>         Connect to a specific OpenCode server (password: MARGARITA_SERVER_PASSWORD)
  --remote <shortname>   Use a saved remote server profile
  --local                Force the local OpenCode service
  --start-server         Start \`opencode serve --service\` if none is running
  --config <path>        Alternate config file
  --debug-log <path>     Write redacted diagnostics to a file
  -h, --help             Show this help
  -v, --version          Show version

With --continue or --resume <id>, a prompt is sent as a new turn in that session.
Margarita never stops the OpenCode service; sessions keep running after you exit.
`;
