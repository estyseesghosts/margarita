import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { BackendError } from '../adapter/backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import type { FormRequest, FormValue } from '../domain/form.ts';
import type { SessionSummary } from '../domain/session.ts';
import { AppController } from './controller.ts';

const sessionID = 'ses_same';
const formID = 'form_same';
const remoteKey = 'server:remote/session:ses_same';

function session(serverID: string): SessionSummary {
  return {
    id: sessionID,
    serverID,
    projectID: 'project',
    directory: '/work',
    createdAt: 0,
    updatedAt: 1,
    archived: false,
  };
}

function form(title: string): FormRequest {
  return {
    id: formID,
    sessionID,
    title,
    fields: [
      { kind: 'text', key: 'answer', title: 'Answer', required: false, hidden: false, when: [] },
    ],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Bun.sleep(0);
}

type HarnessOverrides = Partial<{
  openUrl: (url: URL) => Promise<{ ok: true } | { ok: false; error: string }>;
  copyText: (text: string) => Promise<{ method: 'clipboard' | 'file'; path?: string }>;
}>;

function harness(overrides: HarnessOverrides = {}) {
  const local = new FakeBackend();
  const remote = new FakeBackend();
  local.sessions = [session('local')];
  remote.sessions = [session('remote')];
  local.forms = [form('local')];
  remote.forms = [form('remote')];
  const backends = new Map([
    ['local', local],
    ['remote', remote],
  ]);
  const controller = new AppController({
    backend: local,
    backendFor: (serverID) => backends.get(serverID),
    serverIDs: () => [...backends.keys()],
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work',
    version: 'test',
    now: () => 100,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
    ...overrides,
  });
  return { controller, local, remote, backends };
}

const submit = { name: 'return', shift: false, ctrl: false };
const decline = { name: 'x', shift: false, ctrl: true };
const close = { name: 'escape', shift: false, ctrl: false };

function choiceForm(): FormRequest {
  return {
    id: formID,
    sessionID,
    title: 'Branch',
    fields: [
      {
        kind: 'choice',
        key: 'branch',
        title: 'Branch',
        required: false,
        hidden: false,
        when: [],
        custom: true,
        options: [
          { value: 'main', label: 'main' },
          { value: 'develop', label: 'develop' },
        ],
      },
    ],
  };
}

describe('custom-choice focus stays separate from the reply source (#269)', () => {
  test('caret movement over a listed option still replies with that option', async () => {
    const { controller, local } = harness();
    local.forms = [choiceForm()];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();
    controller.formKey({ name: 'letter', text: 'old', shift: false, ctrl: false });
    controller.formKey({ name: 'down', shift: false, ctrl: false });
    for (const name of ['left', 'right', 'home', 'end']) {
      controller.formKey({ name, shift: false, ctrl: false });
    }
    controller.formKey(submit);
    await flush();
    const reply = local.calls.find((call) => call.name === 'replyForm');
    expect(reply?.args[2]).toEqual({ branch: 'develop' });
  });

  test('Ctrl+E returns from custom text to the listed option that is submitted', async () => {
    const { controller, local } = harness();
    local.forms = [choiceForm()];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();
    controller.formKey({ name: 'down', shift: false, ctrl: false });
    controller.formKey({ name: 'letter', text: 'x', shift: false, ctrl: false });
    controller.formKey({ name: 'e', shift: false, ctrl: true });
    controller.formKey(submit);
    await flush();
    const reply = local.calls.find((call) => call.name === 'replyForm');
    expect(reply?.args[2]).toEqual({ branch: 'develop' });
  });
});

describe('form reply ownership (issue #171)', () => {
  test('concurrent colliding forms stay on their hosts and an old reply cannot dismiss a new form', async () => {
    const { controller, local, remote } = harness();
    const held = Promise.withResolvers<void>();
    const localReply = local.replyForm.bind(local);
    const remoteForms = remote.listForms.bind(remote);
    let remoteRefreshes = 0;
    remote.listForms = async (id: string) => {
      remoteRefreshes += 1;
      return remoteForms(id);
    };
    local.replyForm = async (id: string, request: string, answer: Record<string, FormValue>) => {
      await held.promise;
      await localReply(id, request, answer);
    };
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();
    controller.formKey(submit);
    controller.formKey(submit);

    controller.openSession(sessionID, 'remote');
    await flush();
    controller.openForm();
    controller.formKey({ name: 'a', text: 'b', ctrl: false, shift: false });
    const beforeCompletion = remoteRefreshes;
    held.resolve();
    await flush();
    expect(remoteRefreshes).toBe(beforeCompletion);
    expect(controller.openFormRequest()?.title).toBe('remote');
    expect(controller.state.overlay.kind === 'form' && controller.state.overlay.editor.text).toBe(
      'b',
    );
    expect(controller.state.forms[sessionID]).toHaveLength(0);
    expect(controller.state.forms[remoteKey]).toHaveLength(1);
    expect(local.calls.filter((call) => call.name === 'replyForm')).toHaveLength(1);

    controller.formKey(decline);
    await flush();
    expect(remote.calls.filter((call) => call.name === 'cancelForm')).toHaveLength(1);
    expect(controller.state.overlay.kind).toBe('none');
    controller.dispose();
  });

  test('a form on another host may be submitted while the first reply is pending', async () => {
    const { controller, local, remote } = harness();
    const held = Promise.withResolvers<void>();
    const cancel = local.cancelForm.bind(local);
    local.cancelForm = async (id: string, request: string) => {
      await held.promise;
      await cancel(id, request);
    };
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();
    controller.formKey(decline);
    controller.openSession(sessionID, 'remote');
    await flush();
    controller.openForm();
    controller.formKey(submit);
    await flush();
    expect(remote.calls.filter((call) => call.name === 'replyForm')).toHaveLength(1);
    held.resolve();
    await flush();
    expect(local.calls.filter((call) => call.name === 'cancelForm')).toHaveLength(1);
    controller.dispose();
  });

  test('a reopened form is not dismissed by its previous reply, including an already-answered error', async () => {
    const { controller, local } = harness();
    const held = Promise.withResolvers<void>();
    local.replyForm = async () => {
      await held.promise;
      throw new BackendError('conflict', 'form.reply', 'already answered');
    };
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();
    controller.formKey(submit);
    controller.formKey(close);
    controller.openForm();
    const token = controller.state.overlay.kind === 'form' && controller.state.overlay.requestToken;
    held.resolve();
    await flush();
    expect(controller.state.overlay.kind === 'form' && controller.state.overlay.requestToken).toBe(
      token,
    );
    expect(controller.state.notice?.text).toContain('Already answered');
    controller.dispose();
  });

  test('a transport error leaves the form open for retry', async () => {
    const { controller, local } = harness();
    local.replyForm = async () => {
      throw new BackendError('transport', 'form.reply', 'disconnected');
    };
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();
    controller.formKey(submit);
    await flush();
    expect(controller.state.overlay.kind).toBe('form');
    expect(controller.state.notice?.text).toContain('disconnected');
    expect(controller.openFormRequest()?.id).toBe(formID);
    controller.dispose();
  });

  test('an unpaired origin cannot refresh through the currently viewed host', async () => {
    const { controller, local, remote, backends } = harness();
    const held = Promise.withResolvers<void>();
    const cancel = remote.cancelForm.bind(remote);
    remote.cancelForm = async (id: string, request: string) => {
      await held.promise;
      await cancel(id, request);
    };
    let localRefreshes = 0;
    const listForms = local.listForms.bind(local);
    local.listForms = async (id: string) => {
      localRefreshes += 1;
      return listForms(id);
    };
    await controller.bootstrap();
    controller.openSession(sessionID, 'remote');
    await flush();
    controller.openForm();
    controller.formKey(decline);
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();
    backends.delete('remote');
    const beforeCompletion = localRefreshes;
    held.resolve();
    await flush();
    expect(localRefreshes).toBe(beforeCompletion);
    expect(controller.openFormRequest()?.title).toBe('local');
    expect(controller.state.notice?.text).toContain('Could not refresh form requests');
    controller.dispose();
  });

  test('an older input refresh cannot restore a form after a newer refresh', async () => {
    const { controller, remote } = harness();
    await controller.bootstrap();
    controller.openSession(sessionID, 'remote');
    await flush();
    const held = Promise.withResolvers<FormRequest[]>();
    let first = true;
    remote.listForms = async () => {
      if (first) {
        first = false;
        return held.promise;
      }
      return [];
    };
    controller.onEvents('remote', [{ kind: 'input-requests-changed', sessionID }], false);
    await flush();
    controller.onEvents('remote', [{ kind: 'input-requests-changed', sessionID }], false);
    await flush();
    held.resolve([form('stale')]);
    await flush();
    expect(controller.state.forms[remoteKey]).toHaveLength(0);
    controller.dispose();
  });

  test('a failed form listing never hides a permission retrieved independently (#214)', async () => {
    const { controller, local } = harness();
    local.permissions = [{ id: 'perm_1', sessionID, action: 'shell', resources: [], save: [] }];
    local.forms = [];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    local.listForms = async () => {
      throw new BackendError('transport', 'session.form.list', 'offline');
    };
    controller.onEvents('local', [{ kind: 'input-requests-changed', sessionID }], false);
    await flush();
    expect(controller.pendingPermission()?.id).toBe('perm_1');
    expect(controller.state.requestErrors[sessionID]?.forms).toContain('offline');
    expect(controller.state.requestErrors[sessionID]?.permissions).toBeUndefined();
    controller.dispose();
  });

  test('location-wide forms survive a failed per-session listing (#258)', async () => {
    const { controller, local } = harness();
    local.sessions.push({ ...session('local'), id: 'ses_child', parentID: sessionID });
    local.forms = [
      { ...form('global question'), id: 'form_global', sessionID: 'global' },
      { ...form('child question'), id: 'form_child', sessionID: 'ses_child' },
    ];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    local.listForms = async () => {
      throw new BackendError('transport', 'session.form.list', 'offline');
    };
    controller.onEvents('local', [{ kind: 'input-requests-changed', sessionID: 'global' }], false);
    await flush();
    expect(controller.state.forms[sessionID]?.map((entry) => entry.id)).toEqual([
      'form_global',
      'form_child',
    ]);
    expect(controller.pendingForm()?.id).toBe('form_global');
    expect(controller.state.requestErrors[sessionID]?.forms).toContain('offline');
    controller.dispose();
  });

  test('an empty location snapshot does not erase a cached form when session listing fails (#258)', async () => {
    const { controller, local } = harness();
    local.forms = [form('cached question')];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    expect(controller.state.forms[sessionID]?.map((entry) => entry.title)).toEqual([
      'cached question',
    ]);

    local.listForms = async () => {
      throw new BackendError('transport', 'session.form.list', 'offline');
    };
    local.forms = [];
    controller.onEvents('local', [{ kind: 'input-requests-changed', sessionID }], false);
    await flush();
    expect(controller.state.forms[sessionID]?.map((entry) => entry.title)).toEqual([
      'cached question',
    ]);
    expect(controller.pendingForm()?.title).toBe('cached question');
    expect(controller.state.requestErrors[sessionID]?.forms).toContain('offline');
    controller.dispose();
  });

  test('a global MCP elicitation is surfaced and answered on its real session (#209)', async () => {
    const { controller, local } = harness();
    local.forms = [{ ...form('global question'), id: 'form_global', sessionID: 'global' }];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    expect(controller.pendingForm()?.id).toBe('form_global');
    controller.openForm();
    controller.formKey(submit);
    await flush();
    const reply = local.calls.find((call) => call.name === 'replyForm');
    expect(reply?.args[0]).toBe('global');
    // A location-owned form must carry its directory; the SDK sends it as a header (#227).
    expect(reply?.args[3]).toBe('/work');
    expect(controller.state.forms[sessionID]).toHaveLength(0);
    controller.dispose();
  });

  test('a declined global form cancels with its owning location (#227)', async () => {
    const { controller, local } = harness();
    local.forms = [{ ...form('global question'), id: 'form_global', sessionID: 'global' }];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();
    controller.formKey(decline);
    await flush();
    const cancel = local.calls.find((call) => call.name === 'cancelForm');
    expect(cancel?.args).toEqual(['global', 'form_global', '/work']);
    controller.dispose();
  });

  test('global and child form events refresh the viewed parent conversation (#226)', async () => {
    const local = new FakeBackend();
    local.sessions = [
      session('local'),
      { ...session('local'), id: 'ses_child', parentID: sessionID },
    ];
    local.forms = [];
    const controller = new AppController({
      backend: local,
      config: defaultConfig,
      localState: emptyState,
      platform: 'linux',
      cwd: '/work',
      version: 'test',
      now: () => 100,
      saveLocalState: async () => {},
      listFiles: async () => [],
      requestExit: () => {},
    });
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    expect(controller.pendingForm()).toBeUndefined();

    // A global elicitation arrives while the conversation is already open.
    local.forms = [{ ...form('global'), id: 'form_global', sessionID: 'global' }];
    controller.onEvents('local', [{ kind: 'input-requests-changed', sessionID: 'global' }], false);
    await flush();
    expect(controller.pendingForm()?.id).toBe('form_global');
    expect(controller.state.forms[sessionID]?.map((entry) => entry.id)).toContain('form_global');

    // A descendant's question is presented by the attached parent, not its own bucket.
    local.forms = [{ ...form('child'), id: 'form_child', sessionID: 'ses_child' }];
    controller.onEvents(
      'local',
      [{ kind: 'input-requests-changed', sessionID: 'ses_child' }],
      false,
    );
    await flush();
    expect(controller.state.forms[sessionID]?.map((entry) => entry.id)).toEqual(['form_child']);
    expect(controller.pendingForm()?.id).toBe('form_child');
    controller.dispose();
  });

  test('a queued paste stays bound to the form active when it arrived (#229)', async () => {
    const { controller, local } = harness();
    const first = { ...form('first question'), id: 'form_first' };
    const second = { ...form('second question'), id: 'form_second' };
    local.forms = [first, second];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();

    controller.openForm();
    expect(controller.state.overlay.kind === 'form' && controller.state.overlay.editor.formID).toBe(
      'form_first',
    );
    // Capture synchronously, then replace the active question before the queue runs.
    const pending = controller.pasteBytes(new TextEncoder().encode('must not move'));
    controller.closeOverlay();
    local.forms = [second];
    controller.retryInputRequests();
    await flush();
    await pending;
    controller.openForm();
    expect(controller.state.overlay.kind === 'form' && controller.state.overlay.editor.formID).toBe(
      'form_second',
    );
    const overlay = controller.state.overlay;
    expect(overlay.kind === 'form' && overlay.editor.text).toBe('');
    expect(controller.state.composer.text).toBe('');
    expect(controller.state.notice?.text).toContain('Question changed');
    expect(local.calls.filter((call) => call.name === 'replyForm')).toHaveLength(0);
    controller.dispose();
  });

  test('a text paste lands in the active question field, not the composer (#210)', async () => {
    const { controller, local } = harness();
    local.forms = [form('paste target')];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();
    await controller.pasteBytes(new TextEncoder().encode('line one\nline two'));
    expect(controller.state.overlay.kind === 'form' && controller.state.overlay.editor.text).toBe(
      'line one\nline two',
    );
    expect(controller.state.composer.text).toBe('');
    expect(local.calls.filter((call) => call.name === 'replyForm')).toHaveLength(0);
    controller.dispose();
  });
});

function externalForm(url: string): FormRequest {
  return {
    id: 'form_ext',
    sessionID,
    title: 'Authorize',
    fields: [
      {
        kind: 'external',
        key: 'auth',
        title: 'Authorize',
        required: true,
        hidden: false,
        when: [],
        url,
      },
    ],
  };
}

describe('external MCP elicitation actions (#233)', () => {
  test('o and c act on the URL without submitting or closing the question', async () => {
    const opened: string[] = [];
    const copied: string[] = [];
    const { controller, local } = harness({
      openUrl: async (url) => {
        opened.push(url.toString());
        return { ok: true };
      },
      copyText: async (text) => {
        copied.push(text);
        return { method: 'clipboard' };
      },
    });
    const url = 'https://example.test/auth?client=margarita&x=1';
    local.forms = [externalForm(url)];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();

    controller.formKey({ name: 'o', text: 'o', ctrl: false, shift: false });
    await flush();
    expect(opened).toEqual([url]);
    expect(controller.state.overlay.kind).toBe('form');
    expect(local.calls.filter((call) => call.name === 'replyForm')).toHaveLength(0);

    controller.formKey({ name: 'c', text: 'c', ctrl: false, shift: false });
    await flush();
    expect(copied).toEqual([url]);
    expect(controller.state.overlay.kind).toBe('form');
    expect(local.calls.filter((call) => call.name === 'replyForm')).toHaveLength(0);
    controller.dispose();
  });

  test('Enter on an external-only question never submits an empty answer (#257)', async () => {
    const { controller, local } = harness();
    local.forms = [externalForm('https://example.test/auth')];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();

    controller.formKey({ name: 'return', ctrl: false, shift: false });
    await flush();
    expect(local.calls.filter((call) => call.name === 'replyForm')).toHaveLength(0);
    expect(controller.state.overlay.kind).toBe('form');
    expect(controller.state.notice?.text).toContain('not an answer');
    controller.dispose();
  });

  test('a conditionally hidden text field does not make an external-only step answerable (#266)', async () => {
    const { controller, local } = harness();
    local.forms = [
      {
        id: 'form_conditional',
        sessionID,
        title: 'Authorize',
        fields: [
          {
            kind: 'external',
            key: 'auth',
            title: 'Authorize',
            required: true,
            hidden: false,
            when: [],
            url: 'https://example.test/auth',
          },
          {
            kind: 'text',
            key: 'note',
            title: 'Note',
            required: true,
            hidden: false,
            when: [{ key: 'mode', op: 'eq', value: 'advanced' }],
          },
        ],
      },
    ];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();

    controller.formKey({ name: 'return', ctrl: false, shift: false });
    await flush();
    // The hidden conditional field is not answerable, so Enter must not send `{}`.
    expect(local.calls.filter((call) => call.name === 'replyForm')).toHaveLength(0);
    expect(controller.state.overlay.kind).toBe('form');
    expect(controller.state.notice?.text).toContain('not an answer');
    controller.dispose();
  });

  test('non-http(s) addresses are refused without leaving the question', async () => {
    const opened: string[] = [];
    const { controller, local } = harness({
      openUrl: async (url) => {
        opened.push(url.toString());
        return { ok: true };
      },
    });
    local.forms = [externalForm('javascript:alert(1)')];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();
    controller.formKey({ name: 'o', text: 'o', ctrl: false, shift: false });
    await flush();
    expect(opened).toEqual([]);
    expect(controller.state.notice?.text).toContain('http(s)');
    expect(controller.state.overlay.kind).toBe('form');
    controller.dispose();
  });

  test('a failed browser launch preserves the question and points to copy', async () => {
    const { controller, local } = harness({
      openUrl: async () => ({ ok: false, error: 'no browser' }),
    });
    local.forms = [externalForm('https://example.test/auth')];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    controller.openForm();
    controller.formKey({ name: 'o', text: 'o', ctrl: false, shift: false });
    await flush();
    expect(controller.state.notice?.text).toContain('no browser');
    expect(controller.state.notice?.text).toContain('copy');
    expect(controller.state.overlay.kind).toBe('form');
    controller.dispose();
  });
});

describe('partial location refresh (#264)', () => {
  test('a failed location listing keeps previously confirmed global and child forms', async () => {
    const { controller, local } = harness();
    local.sessions.push({ ...session('local'), id: 'ses_child', parentID: sessionID });
    local.forms = [
      { ...form('parent question'), id: 'form_parent' },
      { ...form('global question'), id: 'form_global', sessionID: 'global' },
      { ...form('child question'), id: 'form_child', sessionID: 'ses_child' },
    ];
    await controller.bootstrap();
    controller.openSession(sessionID, 'local');
    await flush();
    expect(controller.state.forms[sessionID]?.map((entry) => entry.id)).toEqual([
      'form_parent',
      'form_global',
      'form_child',
    ]);

    // The per-session route still works, but the location-owned listing is down. That is
    // not proof the global/child questions were settled: keep the last confirmed cards.
    local.listForms = async () => local.forms.filter((entry) => entry.sessionID === sessionID);
    const locationForms = local.listLocationForms.bind(local);
    local.listLocationForms = async () => {
      throw new BackendError('transport', 'form.list', 'location offline');
    };
    controller.onEvents('local', [{ kind: 'input-requests-changed', sessionID }], false);
    await flush();
    expect(controller.state.forms[sessionID]?.map((entry) => entry.id)).toEqual([
      'form_parent',
      'form_global',
      'form_child',
    ]);
    expect(controller.state.requestErrors[sessionID]?.forms).toContain('location offline');

    // A successful location snapshot removes the settled global question.
    local.forms = local.forms.filter((entry) => entry.id !== 'form_global');
    local.listLocationForms = locationForms;
    controller.onEvents('local', [{ kind: 'input-requests-changed', sessionID }], false);
    await flush();
    expect(controller.state.forms[sessionID]?.map((entry) => entry.id)).toEqual([
      'form_parent',
      'form_child',
    ]);
    controller.dispose();
  });
});
