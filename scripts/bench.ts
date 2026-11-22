/**
 * Opt-in performance harness (#282).
 *
 *   bun run bench                 # representative local run
 *   bun run bench -- --smoke      # smallest CI-friendly scenario
 *   bun run bench -- --json out.json
 *
 * All fixtures are synthetic and local. No OpenCode service, model or user session is
 * contacted. Wall-clock numbers are machine-specific; compare the same machine and SHA.
 * Native TUI paint/frame counters are not exposed by @opentui/core 0.9.2, so those metrics
 * are reported as unavailable rather than fabricated.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  caretPaint,
  composerFrom,
  deleteBackward,
  insertText,
  moveLeft,
} from '../src/domain/composer.ts';
import { type ExecutionMarker, executionMarkers } from '../src/domain/execution-segment.ts';
import { activeMention } from '../src/domain/file-reference.ts';
import { groupSessions } from '../src/domain/overview-groups.ts';
import type { SessionSummary } from '../src/domain/session.ts';
import type { AssistantPart, TranscriptMessage } from '../src/domain/transcript.ts';
import { createTranscriptProjector, foldTranscript } from '../src/domain/transcript.ts';
import { projectUsage } from '../src/domain/usage-analytics.ts';
import { type BenchStats, sampleOperation } from '../src/perf/measure.ts';

type Scenario = Readonly<{
  name: string;
  size: number;
  iterations: number;
  run: () => unknown;
  note?: string;
  /** Extra machine-readable evidence captured after sampling. */
  detail?: () => unknown;
}>;

const args = new Set(Bun.argv.slice(2));
const smoke = args.has('--smoke');
const jsonIndex = Bun.argv.indexOf('--json');
const jsonPath = jsonIndex >= 0 ? Bun.argv[jsonIndex + 1] : undefined;

function messageCount(size: number): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let serial = 0;
  while (messages.length < size) {
    const turn = messages.length;
    messages.push({
      kind: 'user',
      id: `u${serial++}`,
      createdAt: turn,
      text: `request ${turn}`,
      attachments: [],
    });
    const parts: AssistantPart[] = [];
    parts.push({
      kind: 'text',
      text: `Answer ${turn}\n${Array.from({ length: 8 }, (_, row) => `row ${row}`).join('\n')}`,
    });
    if (turn % 3 === 0) {
      parts.push({
        kind: 'tool',
        tool: {
          id: `t${turn}`,
          name: 'read',
          status: 'completed',
          input: { filePath: `src/file-${turn}.ts` },
          output: Array.from({ length: 30 }, (_, row) => `line ${row}`).join('\n'),
          startedAt: turn,
          completedAt: turn + 1,
        },
      });
    }
    messages.push({
      kind: 'assistant',
      id: `a${serial++}`,
      createdAt: turn + 1,
      completedAt: turn + 2,
      agent: 'build',
      model: { providerID: 'mock', modelID: 'mock-1' },
      parts,
    });
    // Completed turns end in an idle marker, the same boundary the real execution
    // projector uses to bound incremental work.
    messages.push({
      kind: 'idle',
      id: `i${serial++}`,
      createdAt: turn + 3,
      outcome: 'succeeded',
    });
  }
  return messages.slice(0, size);
}

function markersFor(messages: readonly TranscriptMessage[]): ReadonlyMap<string, ExecutionMarker> {
  return new Map(
    executionMarkers(messages, false).map((marker) => [marker.afterMessageId, marker]),
  );
}

function sessions(size: number): SessionSummary[] {
  return Array.from({ length: size }, (_, index) => ({
    id: `ses_${index}`,
    serverID: index % 5 === 0 ? 'remote' : 'local',
    projectID: `p${index % 17}`,
    directory: index % 5 === 0 ? `/srv/project-${index % 7}` : `C:\\work\\project-${index % 7}`,
    title: `Session ${index}`,
    updatedAt: index,
    createdAt: 0,
    archived: false,
  }));
}

function scenarios(): Scenario[] {
  const sizes = smoke ? [120] : [120, 1000, 10_000];
  const result: Scenario[] = [];
  for (const size of sizes) {
    const messages = messageCount(size);
    result.push({
      name: 'foldTranscript',
      size,
      iterations: smoke ? 1 : size >= 10_000 ? 3 : 8,
      run: () =>
        foldTranscript(messages, {
          detailed: false,
          expandedGroups: new Set(),
          expandedDiffs: new Set(),
          mcpServers: ['lotus'],
          markers: markersFor(messages),
        }),
      note: 'compact fold of the loaded history',
    });
    let projected = messages;
    const projector = createTranscriptProjector();
    const foldOptions = {
      detailed: false,
      expandedGroups: new Set<string>(),
      expandedDiffs: new Set<string>(),
      mcpServers: ['lotus'],
    };
    projector.project(projected, { ...foldOptions, markers: markersFor(projected) });
    let updateSerial = 0;
    result.push({
      name: 'projectorTailUpdate',
      size,
      iterations: smoke ? 1 : size >= 10_000 ? 3 : 8,
      run: () => {
        updateSerial += 1;
        const index = projected.findLastIndex((message) => message.kind === 'assistant');
        const target = projected[index];
        if (target?.kind !== 'assistant') {
          return projector.project(projected, { ...foldOptions, markers: markersFor(projected) });
        }
        const next = [...projected];
        next[index] = {
          ...target,
          parts: [...target.parts, { kind: 'text', text: `update ${updateSerial}` }],
        };
        projected = next;
        return projector.project(projected, { ...foldOptions, markers: markersFor(projected) });
      },
      note: 'one appended assistant part in the newest turn',
      detail: () => projector.lastStats(),
    });
    result.push({
      name: 'projectUsage',
      size,
      iterations: smoke ? 1 : size >= 10_000 ? 3 : 8,
      run: () =>
        projectUsage({
          serverID: 'local',
          sessionID: 'ses_bench',
          messages,
          catalog: [],
        }),
    });
  }
  for (const size of smoke ? [50] : [1, 50, 500]) {
    const rows = sessions(size);
    result.push({
      name: 'overviewGroups',
      size,
      iterations: smoke ? 1 : 20,
      run: () =>
        groupSessions(rows, {
          platformFor: (serverID) => (serverID === 'local' ? 'win32' : 'linux'),
          showArchived: false,
          showChildren: false,
          activityOf: (session) => session.updatedAt,
        }),
    });
  }
  for (const draftSize of smoke ? [500] : [40, 500, 5000, 50_000]) {
    const chunk = 'ab😀e\u0301 line\n';
    let draftText = '';
    while (draftText.length < draftSize) draftText += chunk;
    const draft = composerFrom(draftText);
    const mentioned = composerFrom(`${draft.text.replace(/\n$/, '')} @src`);
    result.push({
      name: 'composerEdit',
      size: draft.text.length,
      iterations: smoke ? 1 : draftSize >= 50_000 ? 10 : 50,
      run: () => moveLeft(insertText(draft, 'y')),
      note: 'insert at end plus one grapheme-back',
    });
    result.push({
      name: 'composerBackspace',
      size: draft.text.length,
      iterations: smoke ? 1 : draftSize >= 50_000 ? 10 : 50,
      run: () => deleteBackward(draft),
      note: 'delete one grapheme at end of a mixed emoji/combining draft',
    });
    result.push({
      name: 'composerCaret',
      size: draft.text.length,
      iterations: smoke ? 1 : draftSize >= 50_000 ? 10 : 50,
      run: () => caretPaint(draft, true),
      note: 'caret paint at end (marks the last grapheme)',
    });
    result.push({
      name: 'composerMention',
      size: mentioned.text.length,
      iterations: smoke ? 1 : draftSize >= 50_000 ? 10 : 50,
      run: () => activeMention(mentioned.text, mentioned.cursor),
      note: 'active @src token after the draft',
    });
    result.push({
      name: 'composerNoMention',
      size: draft.text.length,
      iterations: smoke ? 1 : draftSize >= 50_000 ? 10 : 50,
      run: () => activeMention(draft.text, draft.cursor),
      note: 'ordinary typing with no @ on the cursor line',
    });
  }
  return result;
}

const before = process.memoryUsage();
const reports: {
  name: string;
  size: number;
  stats: BenchStats;
  heapUsedBytes: number;
  rssBytes: number;
  note?: string;
  detail?: unknown;
}[] = [];
for (const scenario of scenarios()) {
  const stats = await sampleOperation(scenario.run, scenario.iterations, smoke ? 0 : 1);
  const memory = process.memoryUsage();
  reports.push({
    name: scenario.name,
    size: scenario.size,
    stats,
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
    ...(scenario.note === undefined ? {} : { note: scenario.note }),
    ...(scenario.detail === undefined ? {} : { detail: scenario.detail() }),
  });
}

const report = {
  kind: 'margarita-performance' as const,
  version: 1,
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  bun: Bun.version,
  smoke,
  before: { heapUsedBytes: before.heapUsed, rssBytes: before.rss },
  scenarios: reports,
  unavailable: [
    'event-receipt-to-paint latency (requires a live TTY/PTY trace)',
    'OpenTUI native frame/cell counters (@opentui/core 0.9.2 exposes no stable API)',
    'dropped-frame count (not exposed by the test renderer)',
  ],
};

if (jsonPath !== undefined) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

console.log(
  JSON.stringify(
    {
      kind: report.kind,
      platform: report.platform,
      bun: report.bun,
      smoke: report.smoke,
      scenarios: reports.map((entry) => ({
        name: entry.name,
        size: entry.size,
        p50Ms: Number(entry.stats.p50Ms.toFixed(3)),
        p95Ms: Number(entry.stats.p95Ms.toFixed(3)),
        heapUsedBytes: entry.heapUsedBytes,
      })),
    },
    null,
    2,
  ),
);
