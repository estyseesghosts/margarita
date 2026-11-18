/**
 * Read-only compatibility probe against an already-running OpenCode service.
 * Never starts, stops or mutates the service. Usage: `bun scripts/audit-sdk.ts`.
 */
import { createBackend } from '../src/adapter/backend.ts';
import { connect } from '../src/adapter/connection.ts';
import { formatModelRef } from '../src/domain/model-ref.ts';

const connection = await connect({ startServer: false });
const backend = createBackend(connection);
const directory = process.cwd();
console.log('endpoint', connection.origin, connection.baseUrl);

const page = await backend.listSessions({ limit: 5 });
console.log(
  `session.list ${page.sessions.length} sessions, more: ${page.nextCursor !== undefined}`,
);
for (const session of page.sessions) {
  console.log(
    ' ',
    session.id,
    session.directory,
    session.agent ?? '-',
    session.model === undefined ? '-' : formatModelRef(session.model),
    session.cost ?? '-',
    (session.title ?? '').slice(0, 40),
  );
}
const agents = await backend.listAgents(directory);
console.log('agent.list', agents.map((agent) => `${agent.id}:${agent.mode}`).join(' '));
const models = await backend.listModels(directory);
console.log('model.list', models.length);
const fallback = await backend.defaultModel(directory);
console.log('model.default', fallback === undefined ? 'none' : formatModelRef(fallback));
console.log('session.active', (await backend.activeSessionIDs()).size);
console.log('command.list', (await backend.listCommands(directory)).map((c) => c.name).join(' '));
const first = page.sessions[0];
if (first !== undefined) {
  const messages = await backend.listMessages(first.id, 10);
  console.log('message.list', messages.messages.map((message) => message.kind).join(','));
  console.log('inbox', (await backend.listInbox(first.id)).length);
  console.log('permission', (await backend.listPermissions(first.id)).length);
  console.log('form', (await backend.listForms(first.id)).length);
}
