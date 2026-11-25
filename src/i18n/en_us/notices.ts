import type { NoticesStrings } from '../types.ts';

/** English (United States) controller notices. Tone stays in controller logic. */
export const noticesEnUs = {
  clipboard: {
    empty: 'The clipboard is empty.',
    cannotRead: (detail) => `Cannot read the clipboard: ${detail}.`,
    cannotPaste: (detail) => `Cannot paste: ${detail}.`,
    readFailed: (detail) => `Clipboard read failed: ${detail}.`,
    copyFailed: (detail) => `Copy failed: ${detail}`,
    copied: (label, suffix) => `Copied ${label} to the system clipboard${suffix}.`,
    unconfirmed: (label, suffix) =>
      `Clipboard sequence emitted for ${label}${suffix} (no terminal acknowledgement).`,
    savedToFile: (label, path, suffix) =>
      `Clipboard unavailable; saved ${label} to ${path}${suffix}.`,
    unavailable: (label, detail, suffix) =>
      `Clipboard unavailable for ${label}: ${detail}${suffix}. Nothing was copied.`,
    failed: (suffix) => `Copy failed${suffix}.`,
    noSelection: 'No text is selected.',
    noSession: 'Open a session before copying a response.',
    noCompleteResponseHistory:
      'No complete response is fully loaded; earlier history remains. Scroll to the top to load it.',
    noCompleteResponse: 'No complete agent response in this session yet.',
  },
  attachments: {
    notText: 'Pasted data is not text.',
    notTextOrImage: 'Pasted data is not text or a supported image.',
    questionsTextOnly: 'Questions accept pasted text only; attach files from the composer.',
    dialogTextOnly: 'This dialog accepts pasted text only.',
    questionChangedClipboard:
      'The dialog changed before the clipboard paste landed; nothing was inserted.',
    questionChanged: 'Question changed before the paste landed; nothing was inserted.',
    answeredOrWithdrawn: 'This question was answered or withdrawn.',
    pasteTruncated: (limit) => `Paste truncated to ${limit.toLocaleString('en-US')} characters.`,
    pasteStashedImages: (count) =>
      `Paste stashed: the route changed while reading ${count} attachment(s); they await in the originating draft.`,
    pasteStashedText:
      'Paste stashed: the route changed before the text landed; it awaits in the originating draft.',
    unsupportedType: (type) => `Unsupported attachment type ${type}`,
    emptyAttachment: 'The attachment is empty',
    tooLarge: (limit) => `The attachment is larger than ${limit}`,
    removed: (label) => `${label} removed`,
    attachedOne: (name) => `${name} attached`,
    attachedMany: (count) => `${count} files attached`,
    externalSaved: (origin) => `External edit saved to the ${origin} draft.`,
    externalNotApplied: (origin, path) =>
      `External edit for ${origin} was not applied (its draft changed or disappeared); saved to ${path}.`,
    externalFailed: (origin, detail) =>
      `External edit for ${origin} was not applied and could not be saved: ${detail}`,
  },
  session: {
    localStateWarning: (detail) => `Local state warning: ${detail}`,
    localStateNotSaved: (detail) => `Could not persist local state: ${detail}`,
    projectCatalogFailed: (detail) => `Could not load project catalog: ${detail}`,
    sessionIndexFailed: (detail) => `Session index: ${detail}`,
    deleted: 'This session was deleted on the server.',
    connectionLost: 'Connection lost · retrying',
    queueOutOfDate: (detail) => `Queue is out of date; refresh failed: ${detail}`,
    draftStashed: 'Draft stashed · Ctrl+S to restore',
    unknownCommand: (name) => `Unknown command /${name}. Type / to see commands.`,
    noActiveSession: 'Start a session before running commands.',
    stillLoading: 'Still loading sessions and the project catalog. Try again in a moment.',
    sendInFlight:
      'A prompt is still being sent from this session. Wait for confirmation before sending again.',
    creatingSession:
      'A new session is already being created for this project. Wait for confirmation before sending again.',
    queuedParked: 'Queued message parked · Ctrl+S to restore',
    queuedCancelled:
      'Queued message cancelled and kept aside · clear the composer, then Ctrl+S to restore',
    alreadyDelivered: 'Already delivered; it could not be cancelled.',
    exitHint: (key) => `Press ${key} again to exit · sessions keep running`,
    unresolvedReference: (where, detail) =>
      `Could not resolve${where}: ${detail}. The reference was not sent.`,
    sessionCreatedModelUnconfirmed: (sessionID, model, detail) =>
      `Session ${sessionID} created, but model ${model} was not confirmed. Prompt not sent: ${detail}`,
    sessionCreatedPromptNotSent: (sessionID) =>
      `Session ${sessionID} was created but the prompt was not sent. The original is preserved separately; the edited draft was kept.`,
    unreachable: 'Could not reach the server',
    originalServerGone: 'The original server is no longer available. No prompt was sent.',
    originalServerGoneSession: (sessionID) =>
      `Session ${sessionID} was created on the original server, but that server is no longer available here. No prompt was sent.`,
    deliveryUncertain: (sessionID) =>
      `Session ${sessionID} was created; the prompt may or may not have been delivered. Check the transcript before resending.`,
    promptNotSent: (sessionID) => `Session ${sessionID} was created but the prompt was not sent.`,
    localFailure: (effect, detail) =>
      `The prompt was sent, but the local ${effect} update failed: ${detail}`,
  },
  delivery: {
    cancelled: 'Queued message cancelled.',
    cancelFailed: (detail) => `Could not cancel the queued message: ${detail}`,
    steerUsage: 'Usage: /steer <text>',
    unknown: 'Delivery unknown (connection problem). Check the transcript before resending.',
  },
  pairing: {
    unavailable: 'Pairing is not available in this build.',
    pairing: (label) => `Pairing ${label}…`,
    paired: (label) => `Paired ${label}.`,
    unknownServer: (label) => `Unknown server "${label}".`,
    invalidArgs: 'Invalid /pair arguments.',
    credentialsRejected:
      'The server rejected those credentials. Check MARGARITA_SERVER_PASSWORD and pair again.',
    credentialsRequired:
      'The server requires credentials. Set MARGARITA_SERVER_PASSWORD and pair again.',
  },
  servers: {
    managementUnavailable: 'Server management is not available in this build.',
    renameUsage: 'Usage: /servers rename <old> <new>',
    renamed: (from, to) => `Renamed ${from} to ${to}.`,
    renameFailed: (detail) => `Rename failed: ${detail}`,
    unpairUsage: 'Usage: /unpair <name>',
    unpairedCredentialFailed: (label, detail) =>
      `Unpaired ${label}, but its stored credential could not be deleted (${detail}); deletion will be retried on next launch.`,
    unpaired: (label) =>
      `Unpaired ${label}. Remote sessions keep running; this only removed local access.`,
    unpairFailed: (detail) => `Unpair failed: ${detail}`,
    cannotUnpairLaunch:
      'Cannot unpair the launch/server you are currently connected to. Switch to another host or restart margarita without it first.',
    restoreAllFailed: (detail) => `Could not restore paired servers: ${detail}`,
  },
  agent: {
    noneSelectable: 'No selectable agents on this server.',
    pending: 'Agent selection pending. Send again once the server confirms it.',
    unconfirmed: 'Agent selection is unconfirmed. Select an agent again before sending.',
    notSelectable: (id) => `Agent "${id}" is not selectable.`,
    switched: (id) => `Agent: ${id} (next turn)`,
    failed: (detail) => `Agent selection failed: ${detail}. Select an agent again before sending.`,
    unavailable: (id) =>
      `Agent "${id}" is no longer available. Choose a new agent with Shift+Tab or /agent.`,
  },
  model: {
    noSelection: 'No model selected.',
    variants: (variants) => `Variants: ${variants}`,
    noVariant: (name, available) => `No variant "${name}". Available: ${available}.`,
    variantUnavailable: (name, model) =>
      `Variant "${name}" is not available for ${model}; using the server default.`,
    pinUsage: 'Usage: /model default [show] | set [user|project] | clear [user|project]',
    newSessionsUse: (model, source) => `New sessions use: ${model} · ${source}`,
    noPin: (scope) => `No model is pinned for ${scope}.`,
    clearedPin: (scope) => `Cleared the pinned model for ${scope}; automatic selection restored.`,
    pinUnconfirmed: 'A model selection is unconfirmed. Wait for it before pinning.',
    noConfirmedModel: 'No confirmed model to pin yet. Select one with /model first.',
    pinned: (model, scope) => `Pinned ${model} as the default for ${scope}.`,
    pending: 'Model selection pending. Send again once the server confirms it.',
    unconfirmed: 'Model selection is unconfirmed. Select a model again before sending.',
    confirming: (model) => `Confirming ${model} with the server…`,
    failed: (detail) => `Model selection failed: ${detail}. Select a model again before sending.`,
    confirmed: (model) => `Model confirmed: ${model}`,
    noRecent: 'No recent models yet · Alt+P to pick one',
    nothingPinned: 'nothing pinned',
    unavailable: (model, scope, where) =>
      `Model ${model} is unavailable for ${scope} on ${where}. No prompt sent.`,
    goalResumeFailed: (detail) => `Could not resume the goal: ${detail}`,
    refreshFailed: (detail) => `Could not refresh models: ${detail}`,
  },
  export: {
    noSession: 'Open a session to export it.',
    saved: (count, path) => `Exported ${count} messages to ${path}`,
    failed: (detail) => `Export failed: ${detail}`,
    remotePathRefused: (target, shape, clientCwd) =>
      `Refusing to export to "${target}": that looks like a ${shape} path on the remote server, but exports are written locally to ${clientCwd}. Use a local path.`,
  },
  compaction: {
    usage: 'Usage: /compact',
    pending: 'Compaction already pending',
    unconfirmed: (detail) =>
      `Compaction request could not be confirmed (connection problem): ${detail}`,
    requestedRefreshFailed: (detail) => `Compaction requested, but inbox refresh failed: ${detail}`,
    requested: 'Compaction requested',
    requestedFor: (sessionID, serverID) => `Compaction requested for ${sessionID} on ${serverID}`,
  },
  forms: {
    answeredElsewhere: 'Already answered elsewhere.',
    permissionsRefreshFailed: (detail) => `Could not refresh permissions: ${detail}`,
    formsRefreshFailed: (detail) => `Could not refresh form requests: ${detail}`,
    noSessionChanges: 'Open a session to see its changes.',
    noTurnWholeSession: 'No turn yet; showing the whole session.',
    openOnlyHttp: 'Only http(s) URLs can be opened. Press c to copy the address.',
    openedBrowser: 'Opened in your browser. Opening is not an answer; the question stays pending.',
    browserFailed: (detail) => `Could not open a browser: ${detail}. Press c to copy the URL.`,
    completedInBrowser:
      'This question is completed in the browser. Opening or copying the URL is not an answer; it stays pending until the server finishes it.',
    childOwnerFailed: (detail) => `Could not verify a child question's owner: ${detail}`,
  },
  inspector: {
    nothingToInspect: 'Nothing to inspect in this conversation yet.',
    noTextToCopy: 'This result has no text to copy; file metadata is shown instead.',
    noTextToSave: 'This result has no text to save; file metadata is shown instead.',
    saved: (path, label) => `Saved ${path} · ${label}.`,
    saveFailed: (detail) => `Save failed: ${detail}`,
  },
  copy: {
    usage: 'Usage: /copy · /copy last',
    btwDesktopOnly:
      'Side questions (/btw) are desktop-only; the OpenCode HTTP API has no equivalent endpoint. Nothing was sent.',
  },
  background: {
    nothingRunning: 'Nothing running to background.',
    failed: (detail) => `Background failed: ${detail}`,
    interrupted: 'Interrupted',
    nothingWasRunning: 'Nothing was running',
  },
  rewind: {
    waitForRun: 'Wait for the current run to finish before rewinding.',
    noEarlierPrompt: 'No earlier prompt to rewind to.',
    stagedElsewhere: 'A revert was staged on this session. Confirm or cancel it.',
    resolvedElsewhere: 'The staged revert was resolved elsewhere.',
    nothingToRevert: 'Nothing to revert yet.',
    returnToConfirm: 'A revert was staged on this session. Return to it to confirm.',
    unavailable: (detail) => `Revert unavailable: ${detail}`,
    failed: (detail) => `Revert failed: ${detail}`,
    unverified: (state, detail) =>
      `Revert not ${state}: could not verify the staged revert (${detail}).`,
    changed:
      'The staged revert changed or was resolved elsewhere. Nothing was applied by this dialog.',
    reverted: 'Reverted',
    revertCancelled: 'Revert cancelled; files restored',
  },
  goals: {
    unreadable: (detail) => `Goal file unreadable: ${detail}`,
    openSessionFirst: 'Open a session first.',
    notSaved: (detail) => `Goal not saved: ${detail}`,
    conflict: (rounds) =>
      `Goal not saved after ${rounds} conflicting updates; keep your edits and retry.`,
    adoptHint: 'When the reply arrives, /plan adopt to review it.',
    noListInReply: 'No list found in the latest reply.',
    noAgentMessage: 'No agent message to link yet.',
    merged: (notice) => `${notice} · merged with a change from another window`,
  },
  rename: {
    usage: 'Usage: /rename <title>',
    renamed: (title) => `Renamed to ${title}`,
    failed: (detail) => `Rename failed: ${detail}`,
    forkFailed: (detail) => `Fork failed: ${detail}`,
    forked: 'Forked into a new session',
    forkedGoalFailed: (detail) => `Fork created, but its goal could not be saved: ${detail}`,
  },
  generic: {
    failed: (detail) => `Failed: ${detail}`,
    unavailable: (detail) => `Unavailable: ${detail}`,
    operationFailed: (label, detail) => `${label}: ${detail}`,
  },
} satisfies NoticesStrings;
