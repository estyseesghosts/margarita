import { describe, expect, test } from 'bun:test';

import { createBackend } from '../src/adapter/backend.ts';
import { connect } from '../src/adapter/connection.ts';
import {
  type CompatConfig,
  compatConfig,
  type CompatTarget,
  disposableSetupErrors,
  recordResult,
  result,
  waitFor,
} from './live-compat-harness.ts';

/**
 * Opt-in live compatibility smoke (#148). Default CI records `not run` and skips every case:
 * no network, no service discovery, no writes. With MARGARITA_LIVE=1 and explicit disposable
 * v2.3.1/v2.3.2 URLs + an isolated workdir/model, the same cases run against those servers only.
 */
const config = compatConfig();

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCase(
  settings: CompatConfig,
  target: CompatTarget,
  caseID: string,
  body: () => Promise<string>,
): Promise<void> {
  try {
    await recordResult(settings, result(caseID, target.version, 'live pass', await body()));
  } catch (error) {
    await recordResult(
      settings,
      result(caseID, target.version, 'live failure', describeError(error)),
    );
    throw error;
  }
}

describe('live compatibility smoke harness (#148)', () => {
  test('is inert without opt-in configuration', () => {
    const off = compatConfig({});
    expect(off.enabled).toBe(false);
    expect(off.targets).toEqual([]);
    expect(result('C1', 'v2.3.1', 'not run', 'no disposable server', () => 0)).toEqual({
      case: 'C1',
      version: 'v2.3.1',
      status: 'not run',
      detail: 'no disposable server',
      observedAt: new Date(0).toISOString(),
    });
  });

  test('refuses a duplicate/default endpoint and missing isolation settings', () => {
    const unsafe = compatConfig({
      MARGARITA_LIVE: '1',
      MARGARITA_COMPAT_V231_URL: 'http://localhost:4096',
      MARGARITA_COMPAT_V232_URL: 'http://localhost:4096',
    });
    const errors = disposableSetupErrors(unsafe);
    expect(errors).toContain('targets must use distinct URLs');
    expect(errors.some((error) => error.includes('MARGARITA_COMPAT_DIRECTORY'))).toBe(true);
    expect(errors.some((error) => error.includes('MARGARITA_COMPAT_MODEL'))).toBe(true);
  });

  test('accepts two distinct explicit disposable targets when fully configured', () => {
    const ready = compatConfig({
      MARGARITA_LIVE: '1',
      MARGARITA_COMPAT_V231_URL: 'http://127.0.0.1:5101',
      MARGARITA_COMPAT_V232_URL: 'http://127.0.0.1:5102',
      MARGARITA_COMPAT_DIRECTORY: '/tmp/opencode-disposable',
      MARGARITA_COMPAT_MODEL: 'openai/gpt-6.2-astra',
    });
    expect(disposableSetupErrors(ready)).toEqual([]);
    expect(ready.model).toEqual({ providerID: 'openai', modelID: 'gpt-6.2-astra' });
  });
});

describe.skipIf(!config.enabled)('live disposable compatibility smoke (#148)', () => {
  for (const target of config.targets) {
    test(`${target.version}: C1/C2/C3, reconnect and permission/form on an explicit disposable service`, async () => {
      const errors = disposableSetupErrors(config);
      if (errors.length > 0) {
        for (const caseID of ['C1', 'C2', 'C3', 'reconnect', 'permission-form']) {
          await recordResult(config, result(caseID, target.version, 'not run', errors.join('; ')));
        }
        throw new Error(`Live smoke is not safely configured: ${errors.join('; ')}`);
      }
      const directory = config.directory;
      const model = config.model;
      if (directory === undefined || model === undefined) return;

      // Explicit URL only: origin must be 'remote', never a discovered/started user service.
      const connection = await connect({ server: target.url, startServer: false });
      expect(connection.origin).toBe('remote');
      const backend = createBackend(connection);
      const session = await backend.createSession({ directory, model });

      await runCase(config, target, 'C1', async () => {
        await backend.runShell(session.id, 'sleep 120');
        const shell = await waitFor('a timed-out shell', async () => {
          const page = await backend.listMessages(session.id, 50);
          const found = page.messages.find(
            (message) => message.kind === 'shell' && message.status === 'timeout',
          );
          return found?.kind === 'shell' ? found : undefined;
        });
        const jobs = await backend.listShellJobs(session.id);
        expect(jobs.some((job) => job.status === 'running')).toBe(true);
        return `shell ${shell.id} timed out with a server-confirmed running job`;
      });

      await runCase(config, target, 'C2', async () => {
        await backend.compactSession(session.id);
        const compaction = await waitFor('background compaction to finish', async () => {
          const page = await backend.listMessages(session.id, 50);
          const found = page.messages.find(
            (message) => message.kind === 'compaction' && message.state === 'completed',
          );
          return found?.kind === 'compaction' ? found : undefined;
        });
        await backend.prompt(session.id, {
          text: 'After compaction, reply with OK.',
          files: [],
        });
        await waitFor('a post-compaction user message', async () => {
          const page = await backend.listMessages(session.id, 50);
          return page.messages.find(
            (message) => message.kind === 'user' && message.text.includes('After compaction'),
          );
        });
        return `compaction ${compaction.id} completed and a follow-up was admitted`;
      });

      await runCase(config, target, 'C3', async () => {
        await backend.prompt(session.id, { text: 'Reply with OK.', files: [] });
        const assistant = await waitFor('assistant usage on a prompted session', async () => {
          const page = await backend.listMessages(session.id, 50);
          const found = page.messages.find(
            (message) => message.kind === 'assistant' && message.usage !== undefined,
          );
          return found?.kind === 'assistant' ? found : undefined;
        });
        expect(assistant.usage?.input).toBeGreaterThanOrEqual(0);
        expect(assistant.usage?.output).toBeGreaterThanOrEqual(0);
        return `assistant usage recorded (input ${assistant.usage?.input}, output ${assistant.usage?.output})`;
      });

      await runCase(config, target, 'reconnect', async () => {
        const again = await connect({ server: target.url, startServer: false });
        expect(again.origin).toBe('remote');
        const reconnected = createBackend(again);
        const page = await reconnected.listMessages(session.id, 50);
        expect(page.messages.length).toBeGreaterThan(0);
        return `reconnect read ${page.messages.length} canonical messages`;
      });

      await runCase(config, target, 'permission-form', async () => {
        const permissions = await backend.listPermissions(session.id);
        const forms = await backend.listForms(session.id);
        return `permission/form reads succeeded (${permissions.length}/${forms.length})`;
      });
    }, 180_000);
  }
});
