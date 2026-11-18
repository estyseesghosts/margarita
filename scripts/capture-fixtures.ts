/**
 * Records sanitized raw OpenCode SDK responses as versioned fixtures for the mapper
 * regression tests (`src/adapter/fixtures.test.ts`).
 *
 *   bun run capture:fixtures
 *
 * Starts the same disposable service as the writable suite (private XDG dirs, mock model,
 * own port), drives a few scripted scenarios, and writes `test/fixtures/opencode-<version>/`.
 * Never touches the user's OpenCode service, config or sessions.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { OpenCode } from '@opencode/client';

import { startDisposableService } from '../test/writable/disposable-service.ts';
import { sanitizeFixture } from '../test/writable/sanitize-fixture.ts';
import { waitFor } from '../test/writable/wait-for.ts';

const sdkVersion = '2.3.0';

async function main(): Promise<void> {
  const service = await startDisposableService();
  try {
    const client = OpenCode.make({ baseUrl: service.baseUrl, headers: { ...service.headers } });
    const captured: Record<string, unknown> = {};

    const simple = await client.session.create({ location: { directory: service.workspace } });
    captured['session'] = simple;
    await client.session.prompt({ sessionID: simple.id, text: 'first' });
    await waitFor('simple turn', async () => {
      const page = await client.message.list({ sessionID: simple.id, order: 'desc' });
      return page.data.some((message) => message.type === 'idle') ? page : undefined;
    });
    captured['messages-simple'] = await client.message.list({
      sessionID: simple.id,
      order: 'desc',
    });

    const held = await client.session.create({ location: { directory: service.workspace } });
    await client.session.prompt({ sessionID: held.id, text: 'HOLD capture' });
    await waitFor('active', async () => {
      const active = await client.session.active();
      return held.id in active ? true : undefined;
    });
    await client.session.prompt({
      sessionID: held.id,
      text: 'queued follow-up',
      delivery: 'queue',
    });
    captured['inbox-queued'] = await client.session.inbox.list({ sessionID: held.id });
    service.model.release();
    await waitFor('held turn', async () => {
      const page = await client.message.list({ sessionID: held.id, order: 'desc' });
      return page.data.some((message) => message.type === 'idle') ? page : undefined;
    });
    captured['messages-queued'] = await client.message.list({ sessionID: held.id, order: 'desc' });

    const tool = await client.session.create({ location: { directory: service.workspace } });
    const command = JSON.stringify({ command: 'echo captured', description: 'capture' });
    await client.session.prompt({ sessionID: tool.id, text: `TOOL shell ${command}` });
    const ask = await waitFor('permission', async () => {
      const pending = await client.permission.list({ sessionID: tool.id });
      return pending.length > 0 ? pending : undefined;
    });
    captured['permission-ask'] = ask;
    const first = ask[0];
    if (first === undefined) throw new Error('permission request disappeared');
    await client.permission.reply({
      sessionID: tool.id,
      requestID: first.id,
      decision: 'once',
    });
    await waitFor('tool turn', async () => {
      const page = await client.message.list({ sessionID: tool.id, order: 'desc' });
      return page.data.some((message) => message.type === 'idle') ? page : undefined;
    });
    captured['messages-tool'] = await client.message.list({ sessionID: tool.id, order: 'desc' });

    const form = await client.session.create({ location: { directory: service.workspace } });
    const question = JSON.stringify({
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
    });
    await client.session.prompt({ sessionID: form.id, text: `TOOL question ${question}` });
    captured['form-ask'] = await waitFor('form', async () => {
      const pending = await client.session.form.list({ sessionID: form.id });
      return pending.length > 0 ? pending : undefined;
    });

    const outDir = join(import.meta.dir, '..', 'test', 'fixtures', `opencode-${sdkVersion}`);
    await mkdir(outDir, { recursive: true });
    const sanitized = sanitizeFixture(captured, service.workspace);
    for (const [name, value] of Object.entries(sanitized)) {
      await writeFile(join(outDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
    }
    process.stdout.write(`wrote ${Object.keys(sanitized).length} fixtures to ${outDir}\n`);
  } finally {
    await service.stop();
  }
}

await main();
