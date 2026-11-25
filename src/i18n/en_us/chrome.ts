import type { ChromeStrings } from '../types.ts';

/** English (United States) composer, welcome panel and footer chrome. */
export const chromeEnUs = {
  productVersion: (version) => `margarita v${version}`,
  welcome: {
    loadingModel: 'connecting…',
    modelUnavailable: 'model unavailable',
    agentUnavailable: 'agent unavailable',
    overviewHint: '← overview',
    modelHint: 'alt+p model',
    detailsHint: 'ctrl+o full transcript · f1 binds',
  },
  composer: {
    newSessionIn: (directory) => `working in ${directory}`,
    newSessionWithOverview: (directory) => `working in ${directory} · ← overview`,
    conversationPlaceholder: '← overview',
    externalEditorMissing: 'set $VISUAL or $EDITOR to edit prompts externally.',
    editorExited: (code) => `Editor exited with code ${code}.`,
  },
  footer: {
    loadingModel: 'connecting…',
    modelUnavailable: 'model unavailable',
    queued: (count) => `${count} queued`,
    contextPercent: (percent) => `${percent}% context`,
    contextTokens: (count) => `${count} ctx`,
    tokensInOut: (mark, input, output) => `${mark}${input} in · ${output} out`,
    tokensTotal: (mark, total) => `${mark}${total}`,
    tokensUnknown: '— tok',
  },
  execution: {
    idle: 'idle',
    failed: 'failed',
    interrupted: 'interrupted',
    working: 'working',
    'needs-input': 'needs input',
    reconnecting: 'reconnecting',
    unknown: '…',
  },
  goalBadge: {
    statusWords: {
      active: 'goal',
      paused: 'goal paused',
      complete: 'goal complete',
    },
    stale: (glyph) => `${glyph} goal · stale`,
    followUp: (glyph) => `${glyph} goal · follow-up`,
    active: (glyph, rounds) => `${glyph} goal · round ${rounds}`,
    status: (glyph, word) => `${glyph} ${word}`,
  },
} satisfies ChromeStrings;
