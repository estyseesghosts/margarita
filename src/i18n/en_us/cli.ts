import type { CliStrings } from '../types.ts';

/** English (United States) human-readable CLI output. `--json` output is never localized. */
export const cliEnUs = {
  prefix: 'marg',
  version: (version) => `marg ${version}`,
  usageHint: 'Run marg --help for usage.',
  unknownServer: (alias) => `unknown server "${alias}". Use /servers or pair it first.`,
  startingService: 'Starting OpenCode service…',
  connectFailedAdvice:
    'Start OpenCode yourself, pass --server <url>, or use --start-server to launch it.',
  couldNotLoad: (url, detail) => `could not load from ${url}: ${detail}`,
  configWarning: (warning) => `config: ${warning}`,
  keyWarning: (error) => `keys: ${error}`,
  printNeedsPrompt: '--print needs a prompt.',
  remoteNeedsCwd:
    '--remote needs --cwd <absolute path on the remote host> to start or continue a session.',
  noSessionToContinue: 'no session to continue in this project.',
  couldNotContinue: (detail) => `could not continue in this project: ${detail}`,
  localStateNotSaved: (detail) => `local state was not fully saved: ${detail}`,
  revertNotCancelled: (detail) => `could not cancel the staged revert: ${detail}`,
  postMountMaintenanceFailed: (detail) => `Post-mount maintenance failed: ${detail}`,
  sessionNotFound: (sessionID) => `session ${sessionID} not found.`,
  catalogUnavailable: (directory) => `could not load the catalog for ${directory}.`,
  modelNotConfirmed: 'The server did not confirm the requested model.',
  selectionFailed: (detail) => `could not apply the requested selection: ${detail}`,
  serverNotRegistered: (name) =>
    `Server "${name}" is not registered. Use /servers to see available hosts.`,
  resolveSessionFailed: (sessionID, detail) => `could not resolve session ${sessionID}: ${detail}`,
  sessionAmbiguous: (sessionID, servers) =>
    `Session ${sessionID} exists on multiple servers (${servers}). Use --remote <server> or --server to select one.`,
  agentNotSelectable: (requested, available) =>
    `Agent "${requested}" is not selectable. Available: ${available}.`,
  args: {
    requiresValue: (flag) => `${flag} requires a value.`,
    duplicated: (flag) => `${flag} was given more than once.`,
    unknownOption: (flag) => `Unknown option ${flag}. See --help.`,
    jsonRequiresPrint: '--json requires --print.',
    continueResumeConflict: '--continue and --resume cannot be combined.',
    serverStartServerConflict: '--server and --start-server cannot be combined.',
    remoteLocalConflict: '--remote and --local cannot be combined.',
    remoteServerConflict: '--remote and --server cannot be combined.',
    remoteStartServerConflict: '--remote and --start-server cannot be combined.',
    localServerConflict: '--local and --server cannot be combined.',
    resumeNeedsId:
      '--resume without an ID opens the overview; drop the prompt or pass a session ID.',
    printNeedsPrompt: '--print needs a prompt.',
  },
  help: `marg (margarita) — a conversation-first terminal frontend for OpenCode

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
`,
  model: {
    effortRequiresModel: '--effort requires --model.',
    providerNeedsModel: (provider, available) =>
      `--provider ${provider} needs --model; available: ${available}`,
    invalidModel: (raw) => `Invalid model "${raw}".`,
    providerMismatch: (parsed, flag) =>
      `--model names provider "${parsed}" but --provider is "${flag}".`,
    variantMismatch: (parsed, flag) =>
      `--model pins variant "${parsed}" but --effort is "${flag}".`,
    notInCatalog: (raw) => `Model "${raw}" is not in the server catalog.`,
    noCatalogMatch: 'No catalog match.',
    offeredBySeveral: (model, providers) =>
      `Model "${model}" is offered by several providers (${providers}); pass --provider.`,
    disabled: (providerID, modelID) => `Model ${providerID}/${modelID} is disabled.`,
    noVariant: (providerID, modelID, variant, available) =>
      `Model ${providerID}/${modelID} has no variant "${variant}". Available: ${available}.`,
    noneAvailable: 'none (unknown provider)',
    blocked: (selected) =>
      `${selected ? 'Selected' : 'Pinned'} model is not available for this project`,
  },
  print: {
    cancelledCreatingSession: (sessionID) =>
      `cancelled while creating the session; no prompt was submitted (session ${sessionID} may exist).`,
    cancelledSubmitting: (sessionID, detail) =>
      `cancelled while submitting to session ${sessionID}; the prompt may have been accepted and server work may continue: ${detail}`,
    cancelledAfterSubmit: (sessionID) =>
      `cancelled after the prompt was submitted to session ${sessionID}; server work may continue.`,
    sessionStopped: (cause) =>
      `session stopped before the turn finished${cause === undefined ? '' : `: ${cause}`}`,
    promptLeftQueue: 'the prompt left the queue without starting (cancelled?)',
    promptDidNotStart: (ms) => `the prompt did not start within ${ms} ms`,
    turnFinished: (outcome, detail) => `turn ${outcome}${detail}`,
  },
} satisfies CliStrings;
