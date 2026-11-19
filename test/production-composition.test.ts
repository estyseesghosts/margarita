import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createProductionAssembly,
  type ProductionAssemblyInput,
  wireServerStream,
} from '../src/app/production-assembly.ts';
import { defaultConfig } from '../src/config/config.ts';
import { memoryCredentialStore } from '../src/config/credentials.ts';
import { emptyState } from '../src/config/local-state.ts';
import { composerFrom } from '../src/domain/composer.ts';
import { directoryKey } from '../src/domain/path-identity.ts';
import type { TranscriptMessage } from '../src/domain/transcript.ts';
import { FakeBackend } from './fake-backend.ts';

/**
 * Deterministic production-composition coverage (issue #72): two servers colliding on
 * session IDs, message IDs, permission IDs, model IDs and project directory, driven through
 * the same wiring `main.ts` uses. Any dropped `backendFor`, unscoped key, or skipped host
 * restore turns these red.
 */

const sharedDir = '/work/shared';

function session(serverID: string, updatedAt: number) {
  return {
    id: 'ses_same',
    serverID,
    projectID: 'p',
    directory: sharedDir,
    createdAt: 0,
    updatedAt,
    archived: false,
  };
}

function transcript(text: string) {
  return [
    { kind: 'user' as const, id: 'msg_1', createdAt: 1, text: `prompt-${text}`, attachments: [] },
    {
      kind: 'assistant' as const,
      id: 'msg_2',
      createdAt: 2,
      completedAt: 3,
      agent: 'build',
      model: { providerID: 'test', modelID: 'model_dup' },
      parts: [{ kind: 'text' as const, text: `reply-${text}` }],
    },
  ];
}

function replyTextOf(message: TranscriptMessage | undefined) {
  if (message === undefined || message.kind !== 'assistant') return [];
  return message.parts.map((part) => (part.kind === 'text' ? part.text : ''));
}

const sharedModel = (name: string) => ({
  providerID: 'test',
  modelID: 'model_dup',
  name,
  enabled: true,
  variants: ['default'],
});

async function compositionFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'margarita-composition-'));
  const serversFile = join(directory, 'servers.json');
  await writeFile(
    serversFile,
    JSON.stringify({
      schemaVersion: 1,
      profiles: [
        {
          serverID: 'srv_b',
          shortname: 'bravo',
          baseUrl: 'http://bravo.test:4096',
          auth: 'bearer',
        },
      ],
    }),
  );
  const credentials = memoryCredentialStore();
  await credentials.set('srv_b', 'tok_b');

  const local = new FakeBackend();
  local.serverID = 'local';
  local.sessions = [session('local', 1)];
  local.messages = { ses_same: transcript('local') };
  local.permissions = [
    { id: 'per_same', sessionID: 'ses_same', action: 'local-act', resources: [], save: [] },
  ];
  local.models = [sharedModel('local-model')];

  const bravo = new FakeBackend();
  bravo.serverID = 'srv_b';
  bravo.sessions = [session('srv_b', 2)];
  bravo.messages = { ses_same: transcript('remote') };
  bravo.permissions = [
    { id: 'per_same', sessionID: 'ses_same', action: 'remote-act', resources: [], save: [] },
  ];
  bravo.models = [sharedModel('remote-model')];

  const fakes = new Map([['srv_b', bravo]]);
  const createBackend: NonNullable<ProductionAssemblyInput['createBackend']> = (
    _connection,
    options,
  ) => fakes.get(options?.serverID ?? '') ?? new FakeBackend();

  const input = (overrides: Partial<ProductionAssemblyInput> = {}): ProductionAssemblyInput => ({
    config: defaultConfig,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    paths: {
      stateFile: join(directory, 'state.json'),
      serversFile,
      stateDir: directory,
    },
    env: {},
    credentials,
    connections: [
      {
        serverID: 'local',
        connection: { baseUrl: 'http://launch.test:4096', headers: {}, origin: 'discovered' },
        backend: local,
        remoteFilesystem: false,
      },
    ],
    profiles: {
      schemaVersion: 1,
      profiles: [
        {
          serverID: 'srv_b',
          shortname: 'bravo',
          baseUrl: 'http://bravo.test:4096',
          auth: 'bearer',
        },
      ],
    },
    localState: emptyState,
    createBackend,
    requestExit: () => {},
    ...overrides,
  });
  return { directory, serversFile, credentials, local, bravo, input };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Bun.sleep(0);
}

describe('production composition collisions (issue #72)', () => {
  test('transcripts, permissions and forks stay on the owning host for identical IDs', async () => {
    const fixture = await compositionFixture();
    const assembly = await createProductionAssembly(fixture.input());
    const { controller } = assembly;
    await controller.bootstrap();
    expect(Object.keys(controller.state.sessions).toSorted()).toEqual([
      'server:srv_b/session:ses_same',
      'ses_same',
    ]);

    controller.openSession('ses_same', 'local');
    await flush();
    expect(controller.state.transcripts['ses_same']?.messages.map((message) => message.id)).toEqual(
      ['msg_1', 'msg_2'],
    );
    expect(replyTextOf(controller.state.transcripts['ses_same']?.messages[1])).toEqual([
      'reply-local',
    ]);
    expect(controller.state.permissions['ses_same']?.map((p) => p.action)).toEqual(['local-act']);

    controller.openSession('ses_same', 'srv_b');
    await flush();
    const remote = controller.state.transcripts['server:srv_b/session:ses_same'];
    expect(remote?.messages.map((message) => message.id)).toEqual(['msg_1', 'msg_2']);
    expect(replyTextOf(remote?.messages[1])).toEqual(['reply-remote']);
    expect(
      controller.state.permissions['server:srv_b/session:ses_same']?.map((p) => p.action),
    ).toEqual(['remote-act']);

    controller.setComposer(composerFrom('/fork'));
    await controller.submit();
    await flush();
    expect(fixture.bravo.calls.filter((call) => call.name === 'forkSession')).toHaveLength(1);
    expect(fixture.local.calls.filter((call) => call.name === 'forkSession')).toHaveLength(0);

    assembly.controller.dispose();
    await assembly.servers.dispose();
  });

  test('the model catalog follows the attached host and model IDs stay identical', async () => {
    const fixture = await compositionFixture();
    fixture.local.mcpServers = ['lotus'];
    fixture.bravo.mcpServers = ['sentry'];
    const assembly = await createProductionAssembly(fixture.input());
    const { controller } = assembly;
    await controller.bootstrap();

    controller.openSession('ses_same', 'local');
    await flush();
    expect(controller.state.models.map((model) => model.name)).toEqual(['local-model']);
    expect(controller.state.models[0]?.modelID).toBe('model_dup');
    // MCP identity is part of the catalog, not the launch host's alone (issue #74).
    expect(controller.state.mcpServers).toEqual(['lotus']);

    controller.openSession('ses_same', 'srv_b');
    await flush();
    expect(controller.state.models.map((model) => model.name)).toEqual(['remote-model']);
    expect(controller.state.models[0]?.modelID).toBe('model_dup');
    expect(controller.state.mcpServers).toEqual(['sentry']);

    assembly.controller.dispose();
    await assembly.servers.dispose();
  });

  test('revert staging and commits address the attached host only', async () => {
    const fixture = await compositionFixture();
    const assembly = await createProductionAssembly(fixture.input());
    const { controller } = assembly;
    await controller.bootstrap();

    controller.openSession('ses_same', 'local');
    await flush();
    controller.setComposer(composerFrom('/revert'));
    await controller.submit();
    await flush();
    expect(fixture.local.calls.filter((call) => call.name === 'stageRevert')).toHaveLength(1);
    expect(fixture.bravo.calls.filter((call) => call.name === 'stageRevert')).toHaveLength(0);

    // Move to the remote and stage again: the remote owns its colliding ID.
    controller.openSession('ses_same', 'srv_b');
    await flush();
    controller.setComposer(composerFrom('/revert'));
    await controller.submit();
    await flush();
    expect(fixture.bravo.calls.filter((call) => call.name === 'stageRevert')).toHaveLength(1);
    expect(fixture.local.calls.filter((call) => call.name === 'stageRevert')).toHaveLength(1);

    assembly.controller.dispose();
    await assembly.servers.dispose();
  });

  test('shutdown stops every host stream and never hangs on an offline remote', async () => {
    const fixture = await compositionFixture();
    fixture.bravo.eventsHook = (signal) =>
      (async function* () {
        yield { kind: 'connected' };
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      })();
    const assembly = await createProductionAssembly(fixture.input());
    await assembly.controller.bootstrap();
    wireServerStream(assembly.servers, assembly.controller, 'srv_b');
    await Bun.sleep(75); // the pump flushes its first batch after ~50ms
    expect(assembly.servers.get('srv_b')?.state).toBe('online');
    assembly.controller.dispose();
    // An offline-capable dispose must complete, not hang on the stream.
    await assembly.servers.dispose();
  });

  // Issue #77: the first prompt of a new session carried no attachments because the
  // controller read the composer back after attaching to the fresh (empty) session.
  test('the first prompt of a new remote session keeps its image and PDF (issue #77)', async () => {
    const fixture = await compositionFixture();
    const assembly = await createProductionAssembly(fixture.input());
    const { controller } = assembly;
    await controller.bootstrap();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);
    const pngData = Buffer.from(png).toString('base64');
    const pdfData = Buffer.from(pdf).toString('base64');

    // The /new route for a directory on the remote host (the overview composer path is
    // covered in controller.test.ts; both must keep the envelope).
    controller.startNewSession(sharedDir, 'srv_b');
    controller.attachImage(png, 'image/png', 'shot.png');
    controller.attachImage(pdf, 'application/pdf', 'spec.pdf');
    controller.setComposer(composerFrom('read these'));

    await controller.submit();
    await flush();

    const prompts = fixture.bravo.calls.filter((call) => call.name === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.args[1]).toEqual({
      text: 'read these',
      files: [
        { uri: `data:image/png;base64,${pngData}`, name: 'shot.png' },
        { uri: `data:application/pdf;base64,${pdfData}`, name: 'spec.pdf' },
      ],
    });
    expect(fixture.local.calls.filter((call) => call.name === 'createSession')).toHaveLength(0);
    expect(controller.state.attachments).toEqual([]);

    assembly.controller.dispose();
    await assembly.servers.dispose();
  });
});

describe('remote launch path style (issue #84)', () => {
  test('a remote launch host does not inherit the frontend OS', async () => {
    const fixture = await compositionFixture();
    // Windows frontend, remote launch: connection carries no platform.
    const assembly = await createProductionAssembly({
      ...fixture.input({
        platform: 'win32',
        remoteFilesystem: true,
        connections: [
          {
            serverID: 'local',
            connection: { baseUrl: 'http://launch.test:4096', headers: {}, origin: 'remote' },
            backend: fixture.local,
            remoteFilesystem: true,
          },
        ],
      }),
    });
    expect(assembly.controller.platformFor('local')).toBe('linux');
    expect(directoryKey('/srv/App', 'linux')).not.toBe(directoryKey('/srv/app', 'linux'));
    assembly.controller.dispose();
    await assembly.servers.dispose();
  });

  test('a remote launch host keeps the platform recorded in its profile', async () => {
    const fixture = await compositionFixture();
    const assembly = await createProductionAssembly({
      ...fixture.input({
        platform: 'linux',
        remoteFilesystem: true,
        connections: [
          {
            serverID: 'local',
            connection: { baseUrl: 'http://launch.test:4096', headers: {}, origin: 'remote' },
            backend: fixture.local,
            remoteFilesystem: true,
            platform: 'win32',
          },
        ],
      }),
    });
    expect(assembly.controller.platformFor('local')).toBe('win32');
    expect(directoryKey('C:\\Users\\u\\proj', 'win32')).toBe(
      directoryKey('c:\\USERS\\u\\PROJ', 'win32'),
    );
    assembly.controller.dispose();
    await assembly.servers.dispose();
  });

  test('a local launch host still uses the frontend OS', async () => {
    const fixture = await compositionFixture();
    const assembly = await createProductionAssembly(fixture.input({ platform: 'win32' }));
    expect(assembly.controller.platformFor('local')).toBe('win32');
    assembly.controller.dispose();
    await assembly.servers.dispose();
  });
});
