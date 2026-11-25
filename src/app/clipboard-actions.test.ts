import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import type { FormRequest } from '../domain/form.ts';
import type { SessionSummary } from '../domain/session.ts';
import type { TranscriptMessage } from '../domain/transcript.ts';
import type { ClipboardRead } from './clipboard.ts';
import { AppController, type ControllerDeps } from './controller.ts';

const model = { providerID: 'opencode', modelID: 'longcat' };

function session(id: string): SessionSummary {
  return {
    id,
    serverID: 'local',
    projectID: 'p',
    directory: '/work/kohjoh',
    title: `Session ${id}`,
    agent: 'build',
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  };
}

function textForm(): FormRequest {
  return {
    id: 'form_a',
    sessionID: 'ses_a',
    title: 'Answer me',
    fields: [
      { kind: 'text', key: 'answer', title: 'Answer', required: false, hidden: false, when: [] },
    ],
  };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await Bun.sleep(0);
}

function makeController(overrides: Partial<ControllerDeps> = {}, backend = new FakeBackend()) {
  return new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
    ...overrides,
  });
}

function textRead(text: string): ClipboardRead {
  return { status: 'read', bytes: new TextEncoder().encode(text), mimeType: 'text/plain' };
}

function clipboardWrites(writes: string[]): Pick<ControllerDeps, 'clipboard'> {
  return {
    clipboard: {
      writeText: async (text) => {
        writes.push(text);
        return { status: 'written', backend: 'native' };
      },
      read: async () => ({ status: 'unsupported', detail: 'test' }),
    },
  };
}

const baseMessages: TranscriptMessage[] = [
  { kind: 'user', id: 'u1', createdAt: 0, text: 'explain', attachments: [] },
  {
    kind: 'assistant',
    id: 'a1',
    createdAt: 1,
    agent: 'build',
    model,
    parts: [
      { kind: 'reasoning', text: 'private reasoning', done: true },
      { kind: 'text', text: 'First paragraph.' },
    ],
  },
  {
    kind: 'assistant',
    id: 'a2',
    createdAt: 2,
    agent: 'build',
    model,
    parts: [{ kind: 'text', text: '```ts\nconst x = 1;\n```' }],
  },
  { kind: 'idle', id: 'i1', createdAt: 3, outcome: 'succeeded' },
];

describe('clipboard paste entry point (issue #2)', () => {
  test('Ctrl+V-style paste inserts multiline text at the cursor, one undo step, no submit', async () => {
    const backend = new FakeBackend();
    backend.sessions = [session('ses_a')];
    backend.messages = { ses_a: baseMessages };
    const controller = makeController(
      {
        clipboard: {
          writeText: async () => ({ status: 'written', backend: 'native' }),
          read: async () => textRead('first\nsecond'),
        },
      },
      backend,
    );
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    controller.setComposer({ text: 'ab', cursor: 1 });

    await controller.pasteFromClipboard();

    expect(controller.state.composer.text).toBe('afirst\nsecondb');
    expect(backend.calls.filter((call) => call.name === 'prompt')).toHaveLength(0);
    controller.undo();
    expect(controller.state.composer.text).toBe('ab');
    controller.dispose();
  });

  test('a route switch during the read stashes text in the originating draft', async () => {
    const backend = new FakeBackend();
    backend.sessions = [session('ses_a'), session('ses_b')];
    backend.messages = { ses_a: baseMessages, ses_b: [] };
    let release: ((value: ClipboardRead) => void) | undefined;
    const controller = makeController(
      {
        clipboard: {
          writeText: async () => ({ status: 'written', backend: 'native' }),
          read: () =>
            new Promise<ClipboardRead>((resolve) => {
              release = resolve;
            }),
        },
      },
      backend,
    );
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    const pending = controller.pasteFromClipboard();
    controller.openSession('ses_b');
    await flush();
    release?.(textRead('originating text'));
    await pending;

    expect(controller.state.composer.text).toBe('');
    expect(controller.state.drafts['ses_a']?.text).toBe('originating text');
    expect(controller.state.notice?.text).toContain('originating draft');
    controller.dispose();
  });

  test('a terminal that also emits bracketed paste inserts the bytes once', async () => {
    const backend = new FakeBackend();
    backend.sessions = [session('ses_a')];
    backend.messages = { ses_a: baseMessages };
    const controller = makeController(
      {
        clipboard: {
          writeText: async () => ({ status: 'written', backend: 'native' }),
          read: async () => textRead('duplicate text'),
        },
      },
      backend,
    );
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    await controller.pasteBytes(new TextEncoder().encode('duplicate text'), { kind: 'text' });
    await controller.pasteFromClipboard();
    expect(controller.state.composer.text).toBe('duplicate text');
    controller.dispose();
  });

  test('pasting into a searchable overlay keeps one line and the draft untouched (#239)', async () => {
    const backend = new FakeBackend();
    backend.sessions = [session('ses_a')];
    backend.messages = { ses_a: baseMessages };
    backend.models = [
      { providerID: 'opencode', modelID: 'longcat', name: 'Longcat', enabled: true, variants: [] },
    ];
    const controller = makeController(
      {
        clipboard: {
          writeText: async () => ({ status: 'written', backend: 'native' }),
          read: async () => textRead('Long\nCat'),
        },
      },
      backend,
    );
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    controller.setComposer({ text: 'draft', cursor: 0 });
    void controller.openModelPicker();
    await flush();
    await controller.pasteFromClipboard();
    const overlay = controller.state.overlay;
    expect(overlay.kind).toBe('model-picker');
    expect(overlay.kind === 'model-picker' && overlay.query).toBe('Long Cat');
    expect(controller.state.composer.text).toBe('draft');
    controller.dispose();
  });

  test('pasting into a pending question keeps newlines and never submits an answer', async () => {
    const backend = new FakeBackend();
    backend.sessions = [session('ses_a')];
    backend.messages = { ses_a: baseMessages };
    backend.forms = [textForm()];
    const controller = makeController(
      {
        clipboard: {
          writeText: async () => ({ status: 'written', backend: 'native' }),
          read: async () => textRead('line one\nline two'),
        },
      },
      backend,
    );
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    controller.openForm();
    await controller.pasteFromClipboard();
    const overlay = controller.state.overlay;
    if (overlay.kind !== 'form') throw new Error('form overlay not open');
    expect(overlay.editor.text).toBe('line one\nline two');
    expect(backend.calls.filter((call) => call.name === 'replyForm')).toHaveLength(0);
    controller.dispose();
  });

  test('an unavailable clipboard reports the reason instead of swallowing the paste', async () => {
    const backend = new FakeBackend();
    backend.sessions = [session('ses_a')];
    backend.messages = { ses_a: baseMessages };
    const controller = makeController(
      {
        clipboard: {
          writeText: async () => ({ status: 'written', backend: 'native' }),
          read: async () => ({ status: 'unsupported', detail: 'no desktop clipboard' }),
        },
      },
      backend,
    );
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    await controller.pasteFromClipboard();
    expect(controller.state.composer.text).toBe('');
    expect(controller.state.notice?.text).toContain('no desktop clipboard');
    controller.dispose();
  });

  test('native CRLF text pastes as LF and an image attaches without entering the draft', async () => {
    const backend = new FakeBackend();
    backend.sessions = [session('ses_a')];
    backend.messages = { ses_a: baseMessages };
    let result: ClipboardRead = {
      status: 'read',
      bytes: new TextEncoder().encode('one\r\ntwo'),
      mimeType: 'text/plain',
    };
    const controller = makeController(
      {
        clipboard: {
          writeText: async () => ({ status: 'written', backend: 'native' }),
          read: async () => result,
        },
      },
      backend,
    );
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    await controller.pasteFromClipboard();
    expect(controller.state.composer.text).toBe('one\ntwo');

    result = {
      status: 'read',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
      mimeType: 'image/png',
    };
    await controller.pasteFromClipboard();
    expect(controller.state.attachments.map((entry) => entry.name)).toEqual(['clipboard.png']);
    expect(controller.state.composer.text).toBe('one\ntwo');
    controller.dispose();
  });
});

describe('copy last complete response (issue #5)', () => {
  test('copies canonical Markdown across model steps and excludes reasoning', async () => {
    const backend = new FakeBackend();
    backend.sessions = [session('ses_a')];
    backend.messages = { ses_a: baseMessages };
    const writes: string[] = [];
    const controller = makeController(clipboardWrites(writes), backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    await controller.copyLastResponse();
    expect(writes).toEqual(['First paragraph.\n\n```ts\nconst x = 1;\n```']);
    expect(controller.state.notice?.text).toContain('last complete response');
    controller.dispose();
  });

  test('during streaming the previous completed response is copied and named as such', async () => {
    const backend = new FakeBackend();
    backend.sessions = [session('ses_a')];
    backend.messages = {
      ses_a: [
        ...baseMessages,
        { kind: 'user', id: 'u2', createdAt: 4, text: 'next', attachments: [] },
        {
          kind: 'assistant',
          id: 'a3',
          createdAt: 5,
          agent: 'build',
          model,
          parts: [{ kind: 'text', text: 'streaming…' }],
        },
      ],
    };
    const writes: string[] = [];
    const controller = makeController(clipboardWrites(writes), backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    await controller.copyLastResponse();
    expect(writes).toEqual(['First paragraph.\n\n```ts\nconst x = 1;\n```']);
    expect(controller.state.notice?.text).toContain('has not produced a complete response');
    controller.dispose();
  });

  test('reports incomplete history honestly instead of copying a partial turn', async () => {
    const backend = new FakeBackend();
    backend.sessions = [session('ses_a')];
    backend.messages = {
      ses_a: [
        {
          kind: 'assistant',
          id: 'a1',
          createdAt: 0,
          agent: 'build',
          model,
          parts: [{ kind: 'text', text: 'tail without its prompt' }],
        },
        { kind: 'idle', id: 'i1', createdAt: 1, outcome: 'succeeded' },
      ],
    };
    const writes: string[] = [];
    const controller = makeController(clipboardWrites(writes), backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    await controller.copyLastResponse();
    expect(writes).toEqual([]);
    expect(controller.state.notice?.text).toContain('no full agent messages');
    controller.dispose();
  });
});

describe('copy slash-command routing (issue #6)', () => {
  test('/copy last copies the response and /copy opens the exact-text picker', async () => {
    const backend = new FakeBackend();
    backend.sessions = [session('ses_a')];
    backend.messages = { ses_a: baseMessages };
    const writes: string[] = [];
    const controller = makeController(clipboardWrites(writes), backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();

    controller.setComposer({ text: '/copy last', cursor: 10 });
    await controller.submit();
    expect(writes).toEqual(['First paragraph.\n\n```ts\nconst x = 1;\n```']);

    controller.setComposer({ text: '/copy', cursor: 5 });
    await controller.submit();
    expect(controller.state.overlay).toEqual({ kind: 'copy-picker', query: '', index: 0 });

    controller.setComposer({ text: '/copy nonsense', cursor: 14 });
    await controller.submit();
    expect(controller.state.notice?.text).toContain('Usage: /copy');
    controller.dispose();
  });
});

describe('selection copy outcomes (issues #1, #4)', () => {
  test('autocopy never writes a fallback file; explicit copy may', async () => {
    const backend = new FakeBackend();
    backend.sessions = [session('ses_a')];
    backend.messages = { ses_a: baseMessages };
    const written: string[] = [];
    const controller = makeController(
      { writeFile: async (path) => void written.push(path) },
      backend,
    );
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();

    await controller.copySelection('dragged text', 'autocopy');
    expect(written).toEqual([]);
    expect(controller.state.notice?.text).toContain('nothing was copied');

    await controller.copySelection('dragged text', 'explicit');
    expect(written).toHaveLength(1);
    expect(controller.state.notice?.text).toContain('saved the selection');
    controller.dispose();
  });

  test('an empty selection reports it and never overwrites the clipboard', async () => {
    const backend = new FakeBackend();
    backend.sessions = [session('ses_a')];
    backend.messages = { ses_a: baseMessages };
    const writes: string[] = [];
    const controller = makeController(clipboardWrites(writes), backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    await controller.copySelection('', 'explicit');
    expect(writes).toEqual([]);
    expect(controller.state.notice?.text).toContain('no text selected');
    await controller.copySelection('', 'autocopy');
    expect(controller.state.notice?.text).toContain('no text selected');
    controller.dispose();
  });
});
