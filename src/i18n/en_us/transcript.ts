import type { TranscriptStrings } from '../types.ts';

/** English (United States) transcript, tool-summary and streaming-status language. */
export const transcriptEnUs = {
  completeness: {
    complete: 'complete',
    frontendElided: 'preview only — the middle was elided by this client',
    serverTruncated: 'truncated by the server',
  },
  meta: {
    agentSwitched: (agent) => `agent → ${agent}`,
    modelSwitched: (model, variant) =>
      `model → ${model}${variant === undefined ? '' : ` · ${variant}`}`,
  },
  notices: {
    runFailed: (error) => `Run failed${error === undefined ? '' : `: ${error}`}`,
    interrupted: 'Interrupted',
    compactionFailed: 'Compaction failed',
    compacted: 'Conversation compacted',
  },
  tools: {
    read: (count) => `Read ${count} ${count === 1 ? 'file' : 'files'}`,
    search: (count) => `Searched for ${count} ${count === 1 ? 'pattern' : 'patterns'}`,
    edit: (count) => `Edited ${count} ${count === 1 ? 'file' : 'files'}`,
    shell: (count) => `Ran ${count} shell ${count === 1 ? 'command' : 'commands'}`,
    code: (count) => `Ran ${count} code ${count === 1 ? 'script' : 'scripts'}`,
    web: (count) => `Fetched ${count} ${count === 1 ? 'page' : 'pages'}`,
    delegate: (count) => `Delegated ${count} ${count === 1 ? 'task' : 'tasks'}`,
    other: (count) => `Ran ${count} other ${count === 1 ? 'tool' : 'tools'}`,
    externalCalls: (count) => `Called ${count} external ${count === 1 ? 'tool' : 'tools'}`,
    serverCalls: (server, count) => `Called ${server} ${count} ${count === 1 ? 'time' : 'times'}`,
  },
  live: {
    read: 'Reading',
    search: 'Searching',
    edit: 'Editing',
    shell: 'Running',
    code: 'Running script',
    web: 'Fetching',
    delegate: 'Delegating',
    other: 'Working',
  },
  history: {
    loadingEarlier: ' … loading earlier messages',
    checkFailed: ' … earlier history check failed · PageUp at the top to retry',
    hidden: ' … earlier messages · PageUp at the top to show them',
    loadingConversation: ' Loading conversation…',
  },
  background: {
    retained: (detail) => `  background jobs may be out of date · ${detail}`,
    unavailable: (detail) => `  background job state unavailable · ${detail}`,
    refreshFailed: 'refresh failed',
  },
  reasoning: {
    done: '∴ Reasoning (model-provided)',
    inProgress: '∴ Reasoning (in progress…)',
    unavailable: (tokens) => `  Reasoning text not available (${tokens} tokens reported)`,
    hiddenRows: (rows) => `… ${rows} more rows · inspect to read the rest`,
  },
  shell: {
    stillRunning: ' · still running in background',
    lastReportedRunning: ' · last reported running · connection unavailable',
    status: (status, exitCode) =>
      `  └ ${status}${exitCode === undefined ? '' : ` (exit ${exitCode})`}`,
    hiddenRows: (rows, action) => `    … ${rows} more rows · ${action} to read the rest`,
    outputTruncated: '  └ output truncated by the server; full text not shown',
  },
  tool: {
    write: 'Write',
    update: 'Update',
    changed: (name) => `Changed(${name})`,
    scriptFailed: (text) => `  └ script failed: ${text}`,
    scriptRowsHidden: (rows) =>
      `    … ${rows} earlier error rows hidden · inspect for the full script error`,
    moreFiles: (files) =>
      `    … ${files} more ${files === 1 ? 'file' : 'files'} · inspect for the full metadata`,
    diffUnavailable: '  └ diff unavailable for this change',
    moreRows: (rows) => `    … ${rows} more rows · inspect to read the rest`,
    earlierRowsHidden: (rows) => `    … ${rows} earlier rows hidden · inspect for the full error`,
    childMissingReason: '    ↳ the server did not report a separate reason for this child',
    childSummary: (shown, total, counts) =>
      `  … showing ${shown} of ${total} nested calls${counts === '' ? '' : ` · ${counts}`}`,
    childPage: (page, pages, keys) => `    page ${page} of ${pages}${keys}`,
    failedCount: (failed, shown) =>
      shown === undefined || shown === failed
        ? `${failed} failed`
        : `${failed} failed (${shown} shown)`,
    runningCount: (running) => `${running} running`,
    completedCount: (completed) => `${completed} completed`,
    pageKeys: (previous, next) => ` · ${previous}/${next} page`,
    changeSummary: (added, removed) => `Added ${added}, removed ${removed}`,
    clamps: {
      detailed: (lines) => `… ${lines} more lines · inspect to read the rest`,
      compact: (lines) => `… ${lines} more lines · Enter to expand`,
    },
    outputTruncated: '  └ output truncated by the server; the full text is not available here',
    outputElided:
      '  └ output elided by this program (middle omitted); the full text was not retained',
  },
  marker: {
    completed: 'Completed',
    failed: 'Failed',
    interrupted: 'Interrupted',
    in: 'in',
    after: 'after',
    event: (status, preposition, elapsed) =>
      preposition === undefined ? status : `${status} ${preposition} ${elapsed}`,
    done: (event, time) => `${event} · done ${time}`,
  },
  permission: {
    title: ' Permission needed ',
    more: (count) => `  … and ${count} more`,
    focusedHints: '←/→ choose · Enter confirm · Esc reject',
    hints: 'Enter to review · Esc reject',
    allowOnce: 'Allow once',
    alwaysAllow: 'Always allow',
    reject: 'Reject',
  },
  formCard: {
    title: ' Question from the agent ',
    noQuestions: (key) =>
      `No questions to answer · ${key} to acknowledge · Enter on an empty prompt also opens it`,
    fields: (count, key) =>
      `${count} field${count === 1 ? '' : 's'} · ${key} to answer · Enter on an empty prompt also opens it`,
  },
  requests: {
    title: ' Request refresh incomplete ',
    missing: (detail) => `Some questions or permissions may be missing: ${detail}`,
    cached: (key) => `Cached requests stay visible · ${key} retry`,
  },
  backgroundHint: (key) => `${key} to move to background`,
  queued: {
    label: (key) => `  └ Queued${key === '' ? '' : ` · ${key} to steer now`}`,
    nextSteer: (key) => ` · ${key} to steer the next now`,
    more: (count) => `  └ … and ${count} more queued`,
  },
  worker: {
    line: (focus, agent, description, status, running, stale, enter) =>
      `  ${focus} ${agent} · ${description} — ${status}${running}${stale}${enter}`,
    childSession: (id) => `      child session ${id}`,
    started: (at) => `      started ${at}`,
    completed: (at) => `      completed ${at}`,
    resultLocation: '      result lives in the child session transcript',
  },
  moreRowsInspect: (rows) => `… ${rows} more rows · inspect to read the rest`,
  outputTruncatedByServer: '  └ output truncated by the server; full text not shown',
} satisfies TranscriptStrings;
