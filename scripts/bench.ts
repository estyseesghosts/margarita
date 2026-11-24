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
import { dirname, join } from 'node:path';

import type { SessionMessageInfo } from '@opencode/client';

import { toTranscriptMessage } from '../src/adapter/wire-mapping.ts';
import { mergeLatest } from '../src/app/controller.ts';
import { SessionFetcher } from '../src/app/session-fetch.ts';
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
import { payloadLimits, retainedPayload, retainPayload } from '../src/domain/payload-retention.ts';
import type { SessionSummary } from '../src/domain/session.ts';
import type { AssistantPart, TranscriptMessage } from '../src/domain/transcript.ts';
import { createTranscriptProjector, foldTranscript } from '../src/domain/transcript.ts';
import { projectUsage } from '../src/domain/usage-analytics.ts';
import { type BenchStats, sampleOperation } from '../src/perf/measure.ts';
import { approximateTranscriptBytes } from '../src/perf/memory.ts';
import { FakeBackend } from '../test/fake-backend.ts';

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

/** Synthetic retained history: 64k tool previews every tenth message plus a large diff. */
function retainedTranscript(size: number, tag: string): TranscriptMessage[] {
  const output = 'x'.repeat(64_000);
  const diff = Array.from({ length: 500 }, (_, row) => `+line ${row}`).join('\n');
  const messages: TranscriptMessage[] = [];
  for (let index = 0; index < size; index += 1) {
    const ordinal = Math.floor(index / 2);
    if (index % 2 === 0) {
      messages.push({
        kind: 'user',
        id: `${tag}-u${ordinal}`,
        createdAt: index,
        text: `request ${ordinal}`,
        attachments: [],
      });
      continue;
    }
    const parts: AssistantPart[] = [{ kind: 'text', text: `Answer ${ordinal}` }];
    if (ordinal % 10 === 0) {
      parts.push({
        kind: 'tool',
        tool: {
          id: `${tag}-t${ordinal}`,
          name: 'edit',
          status: 'completed',
          input: { path: `src/file-${ordinal}.ts` },
          output,
          diff,
          startedAt: index,
          completedAt: index + 1,
        },
      });
    }
    messages.push({
      kind: 'assistant',
      id: `${tag}-a${ordinal}`,
      createdAt: index,
      completedAt: index + 1,
      agent: 'build',
      model: { providerID: 'mock', modelID: 'mock-1' },
      parts,
    });
  }
  return messages;
}

async function memoryReport(): Promise<unknown> {
  const sizes = smoke ? [20] : [20, 1000, 10_000];
  const before = process.memoryUsage();
  const retained = sizes.map((size) => {
    const transcript = retainedTranscript(size, `mem${size}`);
    return {
      size,
      ...approximateTranscriptBytes(transcript),
    };
  });
  // Eight cached sessions are the controller's current count bound; measure the payload
  // separately from the process's transient allocation peak.
  let eight = Array.from({ length: 8 }, (_, index) => retainedTranscript(1000, `eight${index}`));
  const eightRetained = eight.reduce(
    (total, transcript) => total + approximateTranscriptBytes(transcript).total,
    0,
  );
  const afterAlloc = process.memoryUsage();
  const gcPause = await sampleOperation(() => Bun.gc(true), smoke ? 1 : 5, 0);
  const afterGc = process.memoryUsage();
  eight = [];
  Bun.gc(true);
  const afterRelease = process.memoryUsage();
  return {
    sizes: retained,
    eightSessions: { messagesEach: 1000, retainedBytes: eightRetained },
    heap: {
      before: { heapUsedBytes: before.heapUsed, rssBytes: before.rss },
      afterAlloc: { heapUsedBytes: afterAlloc.heapUsed, rssBytes: afterAlloc.rss },
      afterGc: { heapUsedBytes: afterGc.heapUsed, rssBytes: afterGc.rss },
      afterRelease: { heapUsedBytes: afterRelease.heapUsed, rssBytes: afterRelease.rss },
    },
    gcPauseMs: gcPause,
    note: 'JS heap only; native OpenTUI allocations and retained-object snapshots are not attributed here',
  };
}

/** Profiling evidence for the large-payload thresholds (#356). */
function payloadRetentionReport(): unknown {
  const cases = [
    { kind: 'prose', full: 'word '.repeat(200_000), limit: payloadLimits.text },
    { kind: 'reasoning', full: 'reason '.repeat(150_000), limit: payloadLimits.text },
    { kind: 'diff', full: '+line\n'.repeat(300_000), limit: payloadLimits.diff },
    { kind: 'repeated-64k', full: 'x'.repeat(64_000), limit: payloadLimits.text },
  ];
  return cases.map((entry) => {
    const owner = {};
    const preview = retainPayload(owner, entry.full, entry.limit);
    return {
      kind: entry.kind,
      sourceChars: entry.full.length,
      previewChars: preview.length,
      exactFullRetained: retainedPayload(owner, preview) === entry.full,
    };
  });
}

/**
 * Progressive session-index benchmark (#347): 50/500/2,500 rows at 50 rows per page with a
 * deterministic 5 ms latency per response. Reports the first usable page separately from the
 * complete index, because startup readiness now depends on the former only.
 */
async function sessionPaginationReport(): Promise<unknown> {
  const sizes = smoke ? [50] : [50, 500, 2500];
  const pageSize = 50;
  const latencyMs = 5;
  const results: unknown[] = [];
  for (const size of sizes) {
    const sessionRows = Array.from({ length: size }, (_, index) => ({
      id: `ses_${index}`,
      serverID: 'local' as const,
      projectID: `p${index % 17}`,
      directory: `/work/project-${index % 7}`,
      title: `Session ${index}`,
      updatedAt: index,
      createdAt: 0,
      archived: false,
    }));
    const backend = new FakeBackend();
    backend.listSessionsHook = async (query) => {
      await Bun.sleep(latencyMs);
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      const page = sessionRows.slice(start, start + pageSize);
      const next = start + pageSize;
      return {
        sessions: page,
        ...(next < sessionRows.length ? { nextCursor: String(next) } : {}),
      };
    };
    const fetcher = new SessionFetcher({
      backendFor: () => backend,
      keyFor: (serverID, sessionID) => `${serverID}/${sessionID}`,
      pageLimit: 5,
      concurrency: 4,
    });
    const started = performance.now();
    const first = await fetcher.loadPage('local');
    const firstPageMs = performance.now() - started;
    let cursor = first.nextCursor;
    let pages = 1;
    let rows = first.sessions.length;
    while (cursor !== undefined) {
      const page = await fetcher.loadPage('local', cursor);
      pages += 1;
      rows += page.sessions.length;
      cursor = page.nextCursor;
    }
    results.push({
      size,
      pageSize,
      latencyPerPageMs: latencyMs,
      firstPageMs,
      completeIndexMs: performance.now() - started,
      pages,
      rows,
    });
  }
  return {
    note: 'fetcher-only progressive read; controller publication is covered by UI/startup benchmarks',
    results,
  };
}

async function scenarios(): Promise<Scenario[]> {
  const sizes = smoke ? [120] : [120, 1000, 10_000];
  const result: Scenario[] = [];
  for (const size of sizes) {
    const messages = messageCount(size);
    result.push({
      name: 'foldTranscript',
      size,
      iterations: smoke ? 1 : 30,
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
      iterations: smoke ? 1 : 30,
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
    const pageSize = Math.min(120, messages.length);
    const pageProjector = createTranscriptProjector();
    let pageHistory = messages;
    pageProjector.project(pageHistory, { ...foldOptions, markers: markersFor(pageHistory) });
    let pageObjectsRecreated = 0;
    result.push({
      name: 'livePageReconcile',
      size,
      iterations: smoke ? 1 : 30,
      run: () => {
        // A real latest-page fetch yields fresh DTO objects. Clone the page content into new
        // objects, change only its tail, then reconcile and project exactly as a streamed
        // update does (#301).
        const page = structuredClone(pageHistory.slice(-pageSize));
        const index = page.findLastIndex((message) => message.kind === 'assistant');
        const target = page[index];
        if (target?.kind === 'assistant') {
          page[index] = {
            ...target,
            parts: [...target.parts, { kind: 'text', text: `refreshed ${updateSerial++}` }],
          };
        }
        const next = mergeLatest(pageHistory, page);
        pageObjectsRecreated = page.length;
        pageHistory = next;
        return pageProjector.project(next, { ...foldOptions, markers: markersFor(next) });
      },
      note: 'fresh 120-message page objects through mergeLatest and the projector',
      detail: () => ({
        ...pageProjector.lastStats(),
        pageSize,
        pageObjectsRecreated,
        pageObjectsReused: 0,
      }),
    });
    result.push({
      name: 'projectUsage',
      size,
      iterations: smoke ? 1 : 30,
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
  const fixturePath = join(
    import.meta.dir,
    '..',
    'test',
    'fixtures',
    'opencode-2.3.0',
    'messages-tool.json',
  );
  const fixtureFile = Bun.file(fixturePath);
  if (await fixtureFile.exists()) {
    // Recorded from a disposable OpenCode 2.3.0 service; replay it through the real wire
    // mapper instead of hand-building domain objects (#301).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- recorded SDK response
    const fixture = (await fixtureFile.json()) as { data: SessionMessageInfo[] };
    if (fixture.data.length > 0) {
      result.push({
        name: 'wireMapPage',
        size: fixture.data.length * 40,
        iterations: smoke ? 1 : 30,
        run: () => {
          const mapped = [];
          for (let repeat = 0; repeat < 40; repeat += 1) {
            for (const raw of fixture.data) {
              const message = toTranscriptMessage(raw);
              if (message !== undefined) mapped.push(message);
            }
          }
          return mapped;
        },
        note: 'SDK DTO -> canonical transcript mapping for a 40x recorded tool turn',
      });
    }
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
for (const scenario of await scenarios()) {
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

const memory = await memoryReport();
const sessionPagination = await sessionPaginationReport();
function gitRevision(): string {
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD']);
    return result.stdout.toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
const openTuiPackage = await Bun.file('node_modules/@opentui/core/package.json')
  .json()
  .catch(() => ({ version: 'unknown' }));
const report = {
  kind: 'margarita-performance' as const,
  version: 2,
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  bun: Bun.version,
  versions: {
    bun: Bun.version,
    openTui: typeof openTuiPackage.version === 'string' ? openTuiPackage.version : 'unknown',
  },
  gitRevision: gitRevision(),
  dimensions: ['80x24', '40x12'],
  targetFps: 60,
  seed: 1,
  smoke,
  before: { heapUsedBytes: before.heapUsed, rssBytes: before.rss },
  scenarios: reports,
  memory,
  payloadRetention: payloadRetentionReport(),
  sessionPagination,
  unavailable: [
    'event-receipt-to-paint latency (requires a live TTY/PTY trace)',
    'OpenTUI native frame/cell counters (@opentui/core 0.9.2 exposes no stable API)',
    'dropped-frame count (not exposed by the test renderer)',
    'native renderer retained memory and attached heap-snapshot reports (not exposed by OpenTUI)',
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
        p99Ms: Number(entry.stats.p99Ms.toFixed(3)),
        samples: entry.stats.count,
        heapUsedBytes: entry.heapUsedBytes,
      })),
    },
    null,
    2,
  ),
);
