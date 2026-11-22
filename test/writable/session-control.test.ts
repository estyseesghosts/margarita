import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { BackendError } from '../../src/adapter/backend.ts';
import { type DisposableService, startDisposableService } from './disposable-service.ts';
import { allMessages, assistantText, waitFor, waitForIdleMarkers } from './wait-for.ts';

/** Opt-in (`MARGARITA_LIVE_WRITE=1`); runs against a disposable service only. */
const enabled = process.env['MARGARITA_LIVE_WRITE'] === '1';

const bashCall = (command: string) =>
  `TOOL shell ${JSON.stringify({ command, description: 'mock command' })}`;

describe.skipIf(!enabled)('writable service: permissions, forms, switching, fork/revert', () => {
  let service: DisposableService;
  beforeAll(async () => {
    service = await startDisposableService();
  }, 60_000);
  afterAll(async () => {
    await service.stop();
  });

  const newSession = () =>
    service.backend.createSession({ directory: service.workspace, model: service.modelRef });

  /**
   * The idle marker and `activeSessionIDs` can clear just before the server accepts a revert
   * stage. Retry only the documented busy conflict, never other failures.
   */
  const stageRevertWhenReady = (sessionID: string, messageID: string) =>
    waitFor('revert stage to stop being busy', async () => {
      try {
        return await service.backend.stageRevert(sessionID, messageID);
      } catch (error) {
        if (error instanceof BackendError && error.kind === 'conflict') return undefined;
        throw error;
      }
    });

  test('permission ask: listed, answered once, and the tool then runs', async () => {
    const session = await newSession();
    await service.backend.prompt(session.id, { text: bashCall('echo permitted'), files: [] });
    const ask = await waitFor('permission request', async () => {
      const pending = await service.backend.listPermissions(session.id);
      return pending[0];
    });
    await service.backend.replyPermission(session.id, ask.id, 'once');
    const messages = await waitForIdleMarkers(service.backend, session.id, 1);
    expect(await service.backend.listPermissions(session.id)).toEqual([]);
    const tools = messages.flatMap((message) =>
      message.kind === 'assistant' ? message.parts.filter((part) => part.kind === 'tool') : [],
    );
    expect(tools[0]).toMatchObject({ kind: 'tool', tool: { name: 'shell', status: 'completed' } });
    expect(assistantText(messages.findLast((message) => message.kind === 'assistant'))).toBe(
      'tool done',
    );
  }, 30_000);

  test('permission reply conflict: a second answer is rejected, not silently accepted', async () => {
    const session = await newSession();
    await service.backend.prompt(session.id, { text: bashCall('echo twice'), files: [] });
    const ask = await waitFor('permission request', async () => {
      const pending = await service.backend.listPermissions(session.id);
      return pending[0];
    });
    await service.backend.replyPermission(session.id, ask.id, 'once');
    const second = await service.backend
      .replyPermission(session.id, ask.id, 'reject')
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(second).toBeInstanceOf(BackendError);
    expect(second instanceof BackendError && second.kind).toBe('not-found');
    await waitForIdleMarkers(service.backend, session.id, 1);
  }, 30_000);

  test('permission rejected: the tool errors and the run ends without an idle marker', async () => {
    const session = await newSession();
    await service.backend.prompt(session.id, { text: bashCall('echo denied'), files: [] });
    const ask = await waitFor('permission request', async () => {
      const pending = await service.backend.listPermissions(session.id);
      return pending[0];
    });
    await service.backend.replyPermission(session.id, ask.id, 'reject');
    const messages = await waitFor('run to stop', async () =>
      (await service.backend.activeSessionIDs()).has(session.id)
        ? undefined
        : allMessages(service.backend, session.id),
    );
    const reply = messages.findLast((message) => message.kind === 'assistant');
    const tools =
      reply?.kind === 'assistant' ? reply.parts.filter((part) => part.kind === 'tool') : [];
    expect(tools[0]).toMatchObject({ kind: 'tool', tool: { name: 'shell', status: 'error' } });
    expect(reply?.kind === 'assistant' && reply.error).toBeTruthy();
    // Observed against OpenCode 2.3.0: a declined tool call ends the run with no idle marker,
    // so consumers must not wait for one (print mode keys off the session going inactive).
    expect(messages.some((message) => message.kind === 'idle')).toBe(false);
  }, 30_000);

  test('form: an agent question is listed and answered', async () => {
    const session = await newSession();
    const question = {
      questions: [
        {
          question: 'Pick one',
          header: 'Pick',
          options: [
            { label: 'alpha', description: 'first' },
            { label: 'beta', description: 'second' },
          ],
        },
      ],
    };
    await service.backend.prompt(session.id, {
      text: `TOOL question ${JSON.stringify(question)}`,
      files: [],
    });
    const form = await waitFor('form request', async () => {
      const pending = await service.backend.listForms(session.id);
      return pending[0];
    });
    expect(form).toMatchObject({ title: 'Questions' });
    await service.backend.replyForm(session.id, form.id, { q0: 'alpha' });
    expect(await service.backend.listForms(session.id)).toEqual([]);
    const messages = await waitForIdleMarkers(service.backend, session.id, 1);
    expect(assistantText(messages.findLast((message) => message.kind === 'assistant'))).toBe(
      'tool done',
    );
  }, 30_000);

  test('model and agent switches are recorded and used by the next turn', async () => {
    const session = await newSession();
    await service.backend.switchModel(session.id, { providerID: 'mock', modelID: 'mock-2' });
    await service.backend.prompt(session.id, { text: 'after switch', files: [] });
    const messages = await waitForIdleMarkers(service.backend, session.id, 1);
    const reply = messages.findLast((message) => message.kind === 'assistant');
    expect(reply?.kind === 'assistant' && reply.model.modelID).toBe('mock-2');
  }, 30_000);

  test('agent switch applies to the next provider turn even when the summary omits agent', async () => {
    const session = await newSession();
    const agents = (await service.backend.listAgents(service.workspace)).filter(
      (agent) => !agent.hidden && agent.mode !== 'subagent',
    );
    const current = (await service.backend.getSession(session.id)).agent;
    const target = agents.find((agent) => agent.id !== current)?.id;
    if (target === undefined) throw new Error('no second selectable agent in disposable service');

    // `session.switchAgent` is a POST with 204 NoContent, so success is authoritative even
    // when the optional summary field is omitted (#256). The next assistant message must
    // name the selected agent.
    await service.backend.switchAgent(session.id, target);
    const summary = await service.backend.getSession(session.id);
    if (summary.agent !== undefined) expect(summary.agent).toBe(target);
    await service.backend.prompt(session.id, { text: 'after agent switch', files: [] });
    const messages = await waitForIdleMarkers(service.backend, session.id, 1);
    const reply = messages.findLast((message) => message.kind === 'assistant');
    expect(reply?.kind === 'assistant' && reply.agent).toBe(target);
  }, 30_000);

  test('fork copies history up to a message; revert stages, clears and commits', async () => {
    const session = await newSession();
    await service.backend.prompt(session.id, { text: 'one', files: [] });
    await waitForIdleMarkers(service.backend, session.id, 1);
    await service.backend.prompt(session.id, { text: 'two', files: [] });
    await waitForIdleMarkers(service.backend, session.id, 2);
    // The idle marker lands slightly before the session stops being busy for revert.
    await waitFor('session to stop', async () =>
      (await service.backend.activeSessionIDs()).has(session.id) ? undefined : true,
    );
    const all = await allMessages(service.backend, session.id);
    const secondUser = all.filter((m) => m.kind === 'user')[1];
    if (secondUser === undefined) throw new Error('second user message missing');

    const fork = await service.backend.forkSession(session.id, secondUser.id);
    const forked = await allMessages(service.backend, fork.id);
    expect(fork.id).not.toBe(session.id);
    expect(
      forked.filter((m) => m.kind === 'user').map((m) => (m.kind === 'user' ? m.text : '')),
    ).toEqual(['one']);

    const files = await stageRevertWhenReady(session.id, secondUser.id);
    expect(Array.isArray(files)).toBe(true);
    await service.backend.clearRevert(session.id);
    await stageRevertWhenReady(session.id, secondUser.id);
    await service.backend.commitRevert(session.id);
    const after = await allMessages(service.backend, session.id);
    expect(after.filter((m) => m.kind === 'user')).toHaveLength(1);
  }, 60_000);
});
