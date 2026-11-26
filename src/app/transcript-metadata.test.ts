import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import { executionMarkers } from '../domain/execution-segment.ts';
import { payloadLimits, retainPayload } from '../domain/payload-retention.ts';
import { sessionKey } from '../domain/server-identity.ts';
import type { SessionSummary } from '../domain/session.ts';
import type { TranscriptMessage } from '../domain/transcript.ts';
import { approximateTranscriptBytes } from '../perf/memory.ts';
import { AppController } from './controller.ts';
import { asTranscriptMessageView, isTranscriptMessageView } from './transcript-store.ts';

const model = { providerID: 'p', modelID: 'm' };
const sessionID = 'ses_metadata';

function user(index: number): TranscriptMessage {
  return {
    kind: 'user',
    id: `u${index}`,
    createdAt: index * 10,
    text: `request ${index}`,
    attachments: [],
  };
}

function assistant(index: number): Extract<TranscriptMessage, { kind: 'assistant' }> {
  return {
    kind: 'assistant',
    id: `a${index}`,
    createdAt: index * 10 + 1,
    completedAt: index * 10 + 2,
    agent: 'build',
    model,
    parts: [{ kind: 'text', text: `answer ${index}` }],
  };
}

function idle(index: number): TranscriptMessage {
  return { kind: 'idle', id: `i${index}`, createdAt: index * 10 + 3, outcome: 'succeeded' };
}

function history(turns: number): TranscriptMessage[] {
  return Array.from({ length: turns }, (_, index) => [
    user(index),
    assistant(index),
    idle(index),
  ]).flat();
}

function summary(): SessionSummary {
  return {
    id: sessionID,
    serverID: 'local',
    projectID: 'p',
    directory: '/work/metadata',
    title: 'Metadata',
    createdAt: 0,
    updatedAt: 1,
    archived: false,
  };
}

function makeController(messages: readonly TranscriptMessage[]): {
  controller: AppController;
  backend: FakeBackend;
} {
  const backend = new FakeBackend();
  backend.serverID = 'local';
  backend.sessions = [summary()];
  backend.messages[sessionID] = [...messages];
  const controller = new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/metadata',
    version: '0.0.0',
    now: () => 100_000,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
  });
  return { controller, backend };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(`metadata test: ${description} did not settle`);
}

function messagesOf(controller: AppController): readonly TranscriptMessage[] {
  return controller.state.transcripts[sessionKey({ serverID: 'local', sessionID })]?.messages ?? [];
}

describe('controller transcript metadata (#349, #350)', () => {
  test('appended messages reuse completed markers and keep incremental bytes exact', async () => {
    const { controller, backend } = makeController(history(40));
    const key = sessionKey({ serverID: 'local', sessionID });
    try {
      await controller.bootstrap();
      controller.openSession(sessionID);
      await waitFor(() => messagesOf(controller).length === 120, 'initial transcript');
      const initial = messagesOf(controller);
      expect(controller.markersFor(sessionID)).toEqual(
        executionMarkers(initial, controller.state.running[key] === true),
      );
      expect(controller.transcriptAccountingOf(sessionID)?.bytes).toBe(
        approximateTranscriptBytes(initial).total,
      );

      backend.messages[sessionID]?.push({
        ...assistant(40),
        id: 'a40-new',
        parts: [{ kind: 'text', text: 'streamed tail' }],
      });
      controller.onEvents('local', [{ kind: 'transcript-changed', sessionID }], false);
      await waitFor(
        () => messagesOf(controller).some((message) => message.id === 'a40-new'),
        'appended message',
      );
      const messages = messagesOf(controller);
      expect(controller.markersFor(sessionID)).toEqual(
        executionMarkers(messages, controller.state.running[key] === true),
      );
      const stats = controller.markerStatsOf(sessionID);
      expect(stats?.messagesScanned ?? Infinity).toBeLessThan(messages.length);
      expect(controller.transcriptAccountingOf(sessionID)?.bytes).toBe(
        approximateTranscriptBytes(messages).total,
      );
    } finally {
      controller.dispose();
    }
  });

  test('older-page prepend keeps markers correct and rescans less than the full history', async () => {
    const { controller } = makeController(history(60));
    const key = sessionKey({ serverID: 'local', sessionID });
    try {
      await controller.bootstrap();
      controller.openSession(sessionID);
      await waitFor(() => messagesOf(controller).length === 120, 'first page');
      await controller.loadOlder(sessionID);
      await waitFor(() => messagesOf(controller).length === 180, 'older page');
      const messages = messagesOf(controller);
      expect(controller.markersFor(sessionID)).toEqual(
        executionMarkers(messages, controller.state.running[key] === true),
      );
      const stats = controller.markerStatsOf(sessionID);
      expect(stats?.messagesScanned ?? Infinity).toBeLessThan(messages.length);
      expect(stats?.segmentsReused ?? 0).toBeGreaterThan(0);
      expect(controller.transcriptAccountingOf(sessionID)?.bytes).toBe(
        approximateTranscriptBytes(messages).total,
      );
    } finally {
      controller.dispose();
    }
  });

  test('a running-state change rewrites only the open segment', async () => {
    const { controller } = makeController(history(40));
    const key = sessionKey({ serverID: 'local', sessionID });
    try {
      await controller.bootstrap();
      controller.openSession(sessionID);
      await waitFor(() => messagesOf(controller).length === 120, 'initial transcript');
      const before = controller.markerStatsOf(sessionID)?.messagesScanned;
      controller.onEvents('local', [{ kind: 'execution', sessionID, state: 'started' }], false);
      await waitFor(() => controller.state.running[key] === true, 'running event');
      expect(controller.markersFor(sessionID)).toEqual(
        executionMarkers(messagesOf(controller), true),
      );
      const stats = controller.markerStatsOf(sessionID);
      expect(stats?.messagesScanned ?? Infinity).toBeLessThanOrEqual(3);
      expect(stats?.messagesScanned ?? Infinity).toBeLessThan(before ?? Infinity);
    } finally {
      controller.dispose();
    }
  });

  describe('execution-marker lookup is incremental (#audit-2 task 5)', () => {
    test('repeated presentation reuses the cached lookup map instead of rebuilding it', async () => {
      const { controller } = makeController(history(40));
      try {
        await controller.bootstrap();
        controller.openSession(sessionID);
        await waitFor(() => messagesOf(controller).length === 120, 'initial transcript');

        const firstLookup = controller.markerLookupFor(sessionID);
        controller.presentationFor(sessionID);
        const secondLookup = controller.markerLookupFor(sessionID);
        // The lookup map lives in the marker cache and is reused across projections; it is
        // not rebuilt into a new N-entry map on every presentationFor() call.
        expect(secondLookup).toBe(firstLookup);
        expect(firstLookup.size).toBeGreaterThan(0);

        // Every marker is reachable by its afterMessageId and references the same object.
        for (const marker of controller.markersFor(sessionID)) {
          expect(firstLookup.get(marker.afterMessageId)).toBe(marker);
        }
      } finally {
        controller.dispose();
      }
    });

    test('a running-state change keeps the same marker objects in the cached lookup', async () => {
      const { controller } = makeController(history(40));
      try {
        await controller.bootstrap();
        controller.openSession(sessionID);
        await waitFor(() => messagesOf(controller).length === 120, 'initial transcript');

        const before = controller.markerLookupFor(sessionID);
        controller.onEvents('local', [{ kind: 'execution', sessionID, state: 'started' }], false);
        await waitFor(
          () => controller.state.running[sessionKey({ serverID: 'local', sessionID })] === true,
          'running',
        );

        const after = controller.markerLookupFor(sessionID);
        // The running-state change rewrites only the open segment; closed markers keep their
        // identity, so the lookup reuses the same ExecutionMarker objects.
        expect(after.size).toBe(before.size);
        for (const marker of controller.markersFor(sessionID)) {
          if (marker.phase === 'completed') {
            expect(after.get(marker.afterMessageId)).toBe(marker);
          }
        }
      } finally {
        controller.dispose();
      }
    });
  });

  test('presentation index resolves every node key without flattening the view (#audit-2 task 6)', async () => {
    const { controller } = makeController(history(40));
    try {
      await controller.bootstrap();
      controller.openSession(sessionID);
      await waitFor(() => messagesOf(controller).length === 120, 'initial transcript');

      const index = controller.presentationIndexFor(sessionID);
      const view = controller.presentationFor(sessionID);
      expect(index.length).toBe(view.length);
      expect(index.length).toBeGreaterThan(0);

      // Every node key resolves to a stable, in-bounds index; the index is built by walking
      // the chunked view once, not by flattening it with `toArray()`.
      for (let i = 0; i < view.length; i += 1) {
        const node = view.at(i)!;
        expect(index.keyToIndex.get(node.key)).toBe(i);
      }
      expect(Array.from(index.keyToIndex.values()).toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: view.length }, (_, i) => i),
      );
    } finally {
      controller.dispose();
    }
  });

  test('canonical state keeps paged chunks across a latest-page refresh (slow.txt task 8)', async () => {
    const { controller, backend } = makeController(history(120));
    try {
      await controller.bootstrap();
      controller.openSession(sessionID);
      await waitFor(() => messagesOf(controller).length === 120, 'initial transcript');
      await controller.loadOlder(sessionID);
      await controller.loadOlder(sessionID);
      await waitFor(() => messagesOf(controller).length === 360, 'older pages');
      const before = asTranscriptMessageView(messagesOf(controller));
      expect(isTranscriptMessageView(before)).toBe(true);
      const chunks = before.chunks().slice();
      expect(chunks.length).toBeGreaterThan(1);

      const messages = backend.messages[sessionID];
      expect(messages).toBeDefined();
      messages?.push({ ...assistant(120), id: 'a_new', createdAt: 100_000 });
      controller.onEvents('local', [{ kind: 'transcript-changed', sessionID }], false);
      await waitFor(() => messagesOf(controller).at(-1)?.id === 'a_new', 'latest-page refresh');
      const after = asTranscriptMessageView(messagesOf(controller));
      expect(isTranscriptMessageView(after)).toBe(true);
      expect(after.chunkCount()).toBeLessThanOrEqual(chunks.length + 1);
      expect(after.chunks()[0]).toBe(chunks[0]);
      expect(after.revision).toBeGreaterThan(before.revision);
    } finally {
      controller.dispose();
    }
  });

  test('presentation index reuses prefix entries after a tail append (slow.txt task 9)', async () => {
    const { controller, backend } = makeController(history(40));
    try {
      await controller.bootstrap();
      controller.openSession(sessionID);
      await waitFor(() => messagesOf(controller).length === 120, 'initial transcript');
      const before = controller.presentationIndexFor(sessionID);
      const groupsBefore = controller.toolGroups();
      const collapsibleBefore = controller.collapsibleItems();
      const firstKey = controller.presentationFor(sessionID).at(0)?.key;
      expect(firstKey).toBeDefined();

      const messages = backend.messages[sessionID];
      expect(messages).toBeDefined();
      messages?.push(user(40), assistant(40), idle(40));
      controller.onEvents('local', [{ kind: 'transcript-changed', sessionID }], false);
      await waitFor(() => messagesOf(controller).length === 123, 'tail append');

      const after = controller.presentationIndexFor(sessionID);
      expect(after).not.toBe(before);
      expect(after.keyToIndex.get(firstKey ?? '')).toBe(0);
      for (const group of groupsBefore) expect(controller.toolGroups()).toContain(group);
      for (const item of collapsibleBefore) {
        expect(after.collapsiblePositions.get(item.key)).toBeDefined();
      }
      expect(after.collapsiblePositions.size).toBe(controller.collapsibleItems().length);
    } finally {
      controller.dispose();
    }
  });

  test('navigation reads one cached projection instead of re-folding', async () => {
    const { controller } = makeController(history(40));
    try {
      await controller.bootstrap();
      controller.openSession(sessionID);
      await waitFor(() => messagesOf(controller).length === 120, 'initial transcript');
      const view = controller.presentationFor(sessionID);
      expect(view.length).toBeGreaterThan(0);
      const stats = controller.presentationStatsOf(sessionID);
      expect(stats).toBeDefined();
      controller.collapsibleItems();
      controller.toolGroups();
      expect(controller.presentationStatsOf(sessionID)).toBe(stats);
      const key = view.at(0)?.key;
      if (key === undefined) throw new Error('projection is empty');
      expect(controller.ensureTranscriptNodeVisible(sessionID, key)).toBe(true);
      expect(controller.presentationStatsOf(sessionID)).toBe(stats);
    } finally {
      controller.dispose();
    }
  });
});

describe('large payload reclamation (#356)', () => {
  test('evicting a cached transcript releases its canonical payload', async () => {
    const backend = new FakeBackend();
    backend.serverID = 'local';
    const ids = Array.from({ length: 9 }, (_, index) => `ses_reclaim_${index}`);
    backend.sessions = ids.map((id, index) => ({
      id,
      serverID: 'local',
      projectID: 'p',
      directory: `/work/reclaim-${index}`,
      title: `Reclaim ${index}`,
      createdAt: 0,
      updatedAt: 1,
      archived: false,
    }));
    const full = 'x'.repeat(1_000_000);
    let firstOwner: WeakRef<object> | undefined;
    for (const [index, id] of ids.entries()) {
      const part = { kind: 'text' as const, text: '' };
      part.text = retainPayload(part, full, payloadLimits.text);
      const message: Extract<TranscriptMessage, { kind: 'assistant' }> = {
        ...assistant(index),
        parts: [part],
      };
      backend.messages[id] = [user(index), message, idle(index)];
      if (index === 0) firstOwner = new WeakRef(part);
    }
    const controller = new AppController({
      backend,
      config: defaultConfig,
      localState: emptyState,
      platform: 'linux',
      cwd: '/work/reclaim',
      version: '0.0.0',
      now: () => 100_000,
      saveLocalState: async () => {},
      listFiles: async () => [],
      requestExit: () => {},
    });
    try {
      await controller.bootstrap();
      for (const id of ids) {
        controller.openSession(id);
        await waitFor(
          () =>
            controller.state.transcripts[sessionKey({ serverID: 'local', sessionID: id })]?.messages
              .length === 3,
          `load ${id}`,
        );
      }
      await Bun.sleep(1);
      const firstID = ids[0];
      if (firstID === undefined) throw new Error('missing first eviction fixture');
      const firstKey = sessionKey({ serverID: 'local', sessionID: firstID });
      expect(controller.state.transcripts[firstKey]).toBeUndefined();
      // The backend also held the canonical objects; eviction from the controller cannot
      // reclaim them until the fixture copy is dropped.
      delete backend.messages[firstID];
      if (firstOwner === undefined) throw new Error('missing reclamation reference');
      for (let attempt = 0; attempt < 20 && firstOwner.deref() !== undefined; attempt += 1) {
        Bun.gc(true);
      }
      expect(firstOwner.deref()).toBeUndefined();
    } finally {
      controller.dispose();
    }
  });
});
