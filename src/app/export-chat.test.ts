import { expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import type { MessagePage } from '../adapter/backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import type { SessionSummary } from '../domain/session.ts';
import type { TranscriptMessage } from '../domain/transcript.ts';
import { AppController } from './controller.ts';

function session(serverID: string): SessionSummary {
  return {
    id: 'ses_shared',
    serverID,
    projectID: 'project',
    directory: '/srv/project',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  };
}

function message(id: string): TranscriptMessage {
  return { kind: 'user', id, createdAt: 1, text: id, attachments: [] };
}

async function setup(platform: NodeJS.Platform = 'linux', clientCwd = '/local/client') {
  const a = new FakeBackend();
  const b = new FakeBackend();
  a.sessions = [session('a')];
  b.sessions = [session('b')];
  Object.defineProperty(a, 'baseUrl', { value: 'https://a.example' });
  Object.defineProperty(b, 'baseUrl', { value: 'https://b.example' });
  const writes: { path: string; text: string }[] = [];
  const controller = new AppController({
    backend: a,
    backendFor: (id) => (id === 'a' ? a : id === 'b' ? b : undefined),
    serverIDs: () => ['a', 'b'],
    serverID: 'a',
    config: defaultConfig,
    localState: emptyState,
    platform,
    cwd: '/srv/project',
    clientCwd,
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
    writeFile: async (path, text) => void writes.push({ path, text }),
  });
  await controller.bootstrap();
  controller.openSession('ses_shared', 'a');
  for (let round = 0; round < 5; round += 1) await Bun.sleep(0);
  return { a, b, controller, writes };
}

test('export retains its origin through navigation and deduplicates page boundaries', async () => {
  const { a, b, controller, writes } = await setup();
  const firstPage = Promise.withResolvers<MessagePage>();
  const cursors: (string | undefined)[] = [];
  a.listMessages = async (_id, _limit, cursor) => {
    cursors.push(cursor);
    if (cursor === undefined) return firstPage.promise;
    return { messages: [message('old'), message('boundary')], hasEarlier: false };
  };
  b.listMessages = async () => ({ messages: [message('wrong host')], hasEarlier: false });
  try {
    const exporting = controller.exportChat('chat.json');
    controller.openSession('ses_shared', 'b');
    firstPage.resolve({
      messages: [message('boundary'), message('new')],
      olderCursor: 'older',
      hasEarlier: true,
    });
    await exporting;
    expect(cursors).toEqual([undefined, 'older']);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/local/client/chat.json');
    const log = JSON.parse(writes[0]?.text ?? '{}');
    expect(log.server).toBe('https://a.example');
    expect(log.session.serverID).toBe('a');
    expect(log.messages.map((entry: TranscriptMessage) => entry.id)).toEqual([
      'old',
      'boundary',
      'new',
    ]);
  } finally {
    controller.dispose();
  }
});

test('export refuses repeated cursors and pagination failures without writing a partial file', async () => {
  const { a, controller, writes } = await setup();
  try {
    a.listMessages = async () => ({
      messages: [message('m')],
      olderCursor: 'same',
      hasEarlier: true,
    });
    await controller.exportChat('');
    expect(writes).toHaveLength(0);
    expect(controller.state.notice?.text).toContain('repeated a transcript cursor');
    a.listMessages = async (_id, _limit, cursor) => {
      if (cursor === undefined)
        return { messages: [message('m')], olderCursor: 'older', hasEarlier: true };
      throw new Error('connection lost');
    };
    await controller.exportChat('');
    expect(writes).toHaveLength(0);
    expect(controller.state.notice?.text).toContain('connection lost');
    a.listMessages = async (_id, _limit, cursor) => {
      if (cursor === undefined) {
        return { messages: [message('later')], olderCursor: 'older', hasEarlier: true };
      }
      return { messages: [message('later'), message('old')], hasEarlier: false };
    };
    await controller.exportChat('');
    expect(writes).toHaveLength(0);
    expect(controller.state.notice?.text).toContain('inconsistent order');
  } finally {
    controller.dispose();
  }
});

test('remote exports resolve default and relative names against the client launch directory', async () => {
  const { controller, writes } = await setup('win32', 'C:\\local\\client');
  try {
    await controller.exportChat('');
    await controller.exportChat('relative.json');
    await controller.exportChat('D:\\exports\\chat.json');
    await controller.exportChat('/srv/project/chat.json');
    expect(writes.map((entry) => entry.path)).toEqual([
      'C:\\local\\client\\marg-ses_shared.json',
      'C:\\local\\client\\relative.json',
      'D:\\exports\\chat.json',
    ]);
    expect(controller.state.notice?.text).toContain('Refusing to export');
  } finally {
    controller.dispose();
  }
});

test('a remote POSIX project directory does not become the local export directory', async () => {
  const { controller, writes } = await setup();
  try {
    await controller.exportChat('');
    expect(writes[0]?.path).toBe('/local/client/marg-ses_shared.json');
  } finally {
    controller.dispose();
  }
});
