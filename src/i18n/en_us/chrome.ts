import type { ChromeStrings } from '../types.ts';

/** English (United States) composer, welcome panel and footer chrome. */
export const chromeEnUs = {
  productVersion: (version) => `margarita v${version}`,
  welcome: {
    loadingModel: 'Loading model…',
    modelUnavailable: 'model unavailable',
    agentUnavailable: 'agent unavailable',
    overviewHint: '← overview (empty prompt)',
    modelHint: 'Alt+P model',
    detailsHint: 'Ctrl+O details · F1 help',
  },
  composer: {
    newSessionIn: (directory) => `New session in ${directory}`,
    newSessionWithOverview: (directory) => `New session in ${directory} · ← overview`,
    conversationPlaceholder: '← overview · Shift+Tab agent · Ctrl+O details',
    externalEditorMissing: 'Set $VISUAL or $EDITOR to edit prompts externally.',
    editorExited: (code) => `Editor exited with code ${code}.`,
  },
  footer: {
    loadingModel: 'Loading model…',
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
