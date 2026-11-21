/**
 * Minimal disposable stand-in for an OpenCode v2 service, used only by the executable PTY
 * smoke test. It answers the startup reads with empty catalogs so the renderer can paint its
 * welcome screen; it never talks to a real service or a model.
 *
 * Usage: `bun test/smoke/stub-server.ts <port-file>`; the chosen port is written to the file.
 */
import { appendFile, writeFile } from 'node:fs/promises';

const portFile = process.argv[2];
const logFile = process.env['STUB_LOG'];

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (logFile !== undefined) void appendFile(logFile, `${request.method} ${pathname}
`);
    if (pathname.endsWith('/event') || pathname.includes('/stream')) {
      return new Response(new ReadableStream({ start() {} }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    const listLike = /(list|agent|model|command|session|mcp|job|permission|form)s?$/.test(pathname);

    if (pathname === '/api/session') return Response.json({ data: [], cursor: {} });
    return Response.json(listLike ? { data: [] } : { data: {} });
  },
});

if (portFile !== undefined) await writeFile(portFile, String(server.port));
console.log(`stub listening on ${server.port}`);
