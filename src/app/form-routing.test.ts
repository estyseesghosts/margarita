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

function harness() {
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
  });
  return { controller, local, remote, backends };
}

const submit = { name: 'return', shift: false, ctrl: false };
const decline = { name: 'x', shift: false, ctrl: true };
const close = { name: 'escape', shift: false, ctrl: false };

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
    expect(controller.state.forms[sessionID]).toHaveLength(0);
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
