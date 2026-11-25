import type { OverlaysStrings } from '../types.ts';

/** English (United States) copy for the focused overlays drawn above the composer. */
export const overlaysEnUs = {
  keys: {
    unbound: 'unbound',
    left: 'Left',
    leftDetail: 'overview',
    interrupt: 'ctrl+c',
    interruptDetail: 'interrupt · clear · exit',
    helpTitle: 'keys · pgUp/pgDn scroll · esc to close',
    helpRows: (start, end, total) => `rows ${start}–${end} of ${total} · PgUp/PgDn`,
  },
  inspector: {
    title: (title) => ` Inspector · ${title} · Esc returns `,
    lineSummary: (total, first, last) => `${total} lines · showing ${first}–${last}`,
    source: (label) => ` · source: ${label}`,
    fetching: ' · fetching original…',
    hints: '/ search · Enter next match · ←/→ scroll · Ctrl+Y copy · Ctrl+S save',
    searchPrompt: (query, matches) =>
      `/${query}  · ${matches} ${matches === 1 ? 'match' : 'matches'} · Enter next · Esc clear/close`,
    noRetainedText: '  no retained text for this result',
  },
  usage: {
    title: 'Usage · session analytics',
    notApplicable: 'N/A',
    contextPending: 'Current context  pending after compaction…',
    contextUnknown: 'Current context  unknown (no valid assistant step with usage)',
    contextLine: (tokens) => `Current context  ${tokens}`,
    contextWithLimit: (tokens, limit, percent) => `${tokens} / ${limit} (${percent}%)`,
    contextLimitUnknown: (tokens) => `${tokens} · model limit unknown`,
    sessionLine: (sessionID, serverID, stale) =>
      `Session  ${sessionID === '' ? 'none' : sessionID} · ${serverID}${stale ? ' · stale' : ''}`,
    sinceCompaction: (tokens, compactions) =>
      `Since last compaction  ${tokens} · compactions ${compactions}`,
    lastCompaction: (at) => `Last compaction  ${at}`,
    lifetimeHeading: 'Lifetime server totals (never reset on compaction)',
    lifetimeUnreported: 'Token totals not reported.',
    lifetimeCounts: (input, output, reasoning) =>
      `  input ${input} · output ${output} · reasoning ${reasoning}`,
    lifetimeCache: (read, write) => `  cache read ${read} · cache write ${write}`,
    spend: (cost) => `Session spend  ${cost} · server-reported, not an invoice`,
    activityHeading: 'Activity · loaded messages only',
    toolTurns: (turns, total, percent, calls) =>
      `  tool turns ${turns}/${total} (${percent} of user turns) · tool calls ${calls}`,
    toolCategoryLine: (counts) =>
      `  read ${counts.read} · search ${counts.search} · edit ${counts.edit} · shell ${counts.shell} · code ${counts.code} · web ${counts.web} · delegate ${counts.delegate} · MCP ${counts.mcp} · other ${counts.other}`,
    outcomes: (completed, failed, running, other, percent) =>
      `  completed ${completed} · failed ${failed} · running ${running} · other ${other} · failure ${percent} of known outcomes`,
    loadedOnly: 'Tool stats cover loaded messages only; context uses the step model limit.',
    notReported: 'not reported',
  },
  status: {
    title: 'Status',
    server: (url) => `Server  ${url}`,
    stream: (stream) => `Stream  ${stream}`,
    project: (directory) => `Project ${directory}`,
    session: (id) => `Session ${id}`,
  },
  servers: {
    title: 'Servers · /servers rename <old> <new> · /unpair <name> · Esc close',
    row: (marker, label, baseUrl, state) => `${marker} ${label}  ${baseUrl}  [${state}]`,
    unpairTitle: 'Unpair · Enter confirm · Esc cancel',
    unpairConfirm: (label) => `Remove local access to "${label}" and its saved credentials?`,
    unpairDetail:
      'Remote sessions keep running. Removing local credentials does not revoke an already-issued server token.',
  },
  queue: {
    title: 'Queue · ↑↓ PgUp/PgDn · x cancel · s steer · Esc close',
    empty: 'Nothing queued.',
    row: (marker, delivery, text) => `${marker} [${delivery}] ${text}`,
    position: (index, total) => `${index} of ${total} · PgUp/PgDn move ten`,
  },
  model: {
    titleConversation: 'Model · type to filter · Enter select',
    titleNewSession: 'Model for new sessions · type to filter · Enter select',
    empty: 'No matching models.',
    position: (index, total) => `${index} of ${total} · type to filter`,
    noVariants: 'No variants available for this model.',
    effortTitle: 'Effort · type to filter · Enter select · Esc cancel',
    current: ' (current)',
    currentLabel: '(current) ',
  },
  effort: {
    titleConversation: 'Effort · type to filter · Enter select · Esc cancel',
    titleNewSession: 'Effort · type to filter · Enter select · Esc cancel',
    empty: 'No variants available for this model.',
    position: (index, total) => `${index} of ${total} · type to filter`,
    noVariants: 'No variants available for this model.',
    effortTitle: 'Effort · type to filter · Enter select · Esc cancel',
    current: ' (current)',
    currentLabel: '(current) ',
  },
  agent: {
    titleConversation: 'Agent · type to filter · Enter select',
    titleNewSession: 'Agent for new sessions · type to filter · Enter select',
    empty: 'No matching agents.',
    currentLabel: '(current) ',
    position: (index, total) => `${index} of ${total} · type to filter`,
  },
  copy: {
    title: 'Copy exact text · type to filter · Enter copy',
    empty: 'No tool output, diff or code block in this session.',
    unretainedHint: 'Unretained or server-truncated payloads are labelled above.',
    customValue: 'custom value',
    position: (index, total) => `${index} of ${total} · type to filter`,
  },
  tasks: {
    proposedTitle: 'Proposed plan · a accept · r reject · Esc close',
    title: (done, total) =>
      `Tasks ${done}/${total} · Space state · b blocked · x cancel · e evidence`,
    goal: (objective) => `Goal: ${objective}`,
    localGoal: (title) => `Local goal: ${title}`,
    nativeActive: (rounds, maxRounds) => `◎ active · round ${rounds}/${maxRounds}`,
    nativeComplete: (rounds, maxRounds) => `● complete · round ${rounds}/${maxRounds}`,
    nativePaused: (rounds, maxRounds, reason) =>
      `◌ paused · round ${rounds}/${maxRounds}${reason === '' ? '' : ` · ${reason}`}`,
    nativeUnavailable: (reason) => `status unavailable (${reason}) · not a confirmed absence`,
    nativeLastKnown: (status, reason) => `last known: ${status} · stale (${reason})`,
    selectSession: 'Select a session to view its tasks.',
    noPlan: 'No plan. /plan step one; step two · or /plan propose',
    evidence: (count) => ` · ${count} evidence`,
    position: (index, total) => `${index} of ${total} · ↑↓ PgUp/PgDn`,
    acceptance: (count) => `Acceptance${count > 4 ? ` (${count}, first 4 shown)` : ''}:`,
  },
  rewind: {
    title: 'Rewind · ↑↓ prompt · Enter stage · Esc cancel',
    promptPicker: (count, index) =>
      `Earlier prompt to revert file changes to (${count} in loaded history) · ${index} of ${count}:`,
    scope: (ordinal, summary) => `Scope: files changed after prompt #${ordinal} · ${summary}`,
    reading: 'reading…',
    scopeUnavailable: 'file scope unavailable',
    filesOnly: 'Files only — the conversation is not rewritten; the server offers no redo.',
    utc: 'Prompt times are shown in UTC.',
    staging: 'Enter stages the boundary; a separate confirmation applies it.',
  },
  revert: {
    title: 'Revert · Enter confirm · Esc restore files',
    confirm: (summary) => `Undo changes since your last message: ${summary}`,
    working: 'Working…',
  },
  diff: {
    title: (file) => `${file} · ↑↓ PgUp PgDn · ← files`,
    noPatchLines: (index, total) => `no patch lines · file ${index}/${total}`,
    position: (first, last, total, index, files) =>
      `${first}–${last}/${total} · file ${index}/${files}`,
    serverTruncated: ' · server-truncated',
    changesTitle: (scope, summary, otherScope) =>
      `Changes in ${scope} · ${summary} · t ${otherScope} · Esc close`,
    thisTurn: 'this turn',
    session: 'session',
    loading: 'Loading changes…',
    empty: 'No file changes reported.',
    noFiles: 'no files',
    noChanges: 'No changes',
    summary: (files, additions, deletions) =>
      `${files} file${files === 1 ? '' : 's'} · +${additions} −${deletions}`,
    filesPosition: (first, last, total, selected) =>
      `files ${first}–${last} of ${total} · selected ${selected}`,
  },
  form: {
    answeredOrWithdrawn: 'This question was answered or withdrawn.',
    externalStep: (url) => `External step: ${url}`,
    openUrl: '[ Open URL ]',
    copyUrl: '[ Copy URL ]',
    externalDetail:
      'Opening or copying is not an answer; keep this pending until the server completes it.',
    customEditing: 'editing custom value · Enter submits it · ↑↓ return to listed options',
    customListed: 'listed option will be submitted · Ctrl+E edit saved custom draft',
    customPrompt: '↑↓ choose a listed option · type or Ctrl+E for a custom value',
    choicePosition: (index, total) => `choice ${index} of ${total} · ↑↓ PgUp/PgDn Home/End`,
    externalHints: 'o open · c copy · Enter next · Shift+Tab back · Esc later · Ctrl+X decline',
    hints: (custom) =>
      `Enter next · Shift+Tab back · ↑↓ choose${custom ? ' · Ctrl+E custom' : ''} · Space toggle · Esc later · Ctrl+X decline`,
    multiCustomHints: 'a add custom value · x remove selected custom value',
    yes: 'Yes',
    no: 'No',
  },
  history: {
    title: (key) => `History search · ${key} older · Enter use`,
    noMatch: 'no match',
  },
} satisfies OverlaysStrings;
