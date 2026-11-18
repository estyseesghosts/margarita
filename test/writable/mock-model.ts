/**
 * Deterministic OpenAI-compatible chat-completions server. The disposable OpenCode service
 * is configured to use it, so the writable suite never needs credentials or paid models.
 *
 * The reply is chosen from the text of the last user message:
 *   `HOLD ...`   streams a first chunk, then stays open until `release()` or the client aborts
 *   `FAIL ...`   answers HTTP 400 (not retried by the service)
 *   `TOOL <name> <json>`  answers with that tool call (first request only; the follow-up
 *                         request after the tool result gets a plain text reply)
 *   anything else echoes `ok: <text>`
 */
export type MockRequest = Readonly<{ userText: string; hasToolResult: boolean }>;

export type MockModel = Readonly<{
  url: string;
  requests: readonly MockRequest[];
  /** Resolves held streams so the turn can finish normally. */
  release: () => void;
  stop: () => Promise<void>;
}>;

const encoder = new TextEncoder();

function sse(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock-1',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (const message of messages.toReversed()) {
    if (typeof message !== 'object' || message === null) continue;
    if (!('role' in message) || message.role !== 'user') continue;
    if (!('content' in message)) continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part: unknown) =>
          typeof part === 'object' &&
          part !== null &&
          'text' in part &&
          typeof part.text === 'string'
            ? part.text
            : '',
        )
        .join('');
    }
  }
  return '';
}

function hasToolResult(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  const last: unknown = messages.at(-1);
  return typeof last === 'object' && last !== null && 'role' in last && last.role === 'tool';
}

export function startMockModel(): MockModel {
  const requests: MockRequest[] = [];
  let released = Promise.withResolvers<void>();

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 });
      }
      const body: unknown = await request.json();
      const messages =
        typeof body === 'object' && body !== null && 'messages' in body ? body.messages : [];
      const userText = lastUserText(messages);
      const toolResult = hasToolResult(messages);
      requests.push({ userText, hasToolResult: toolResult });

      if (userText.startsWith('FAIL')) {
        return new Response(JSON.stringify({ error: { message: 'mock failure' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }

      const holdUntil = userText.startsWith('HOLD') ? released.promise : undefined;
      const toolMatch = /^TOOL (\w+) (.+)$/s.exec(userText);
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const closed = Promise.withResolvers<void>();
          request.signal.addEventListener('abort', () => closed.resolve());
          controller.enqueue(sse(chunk({ role: 'assistant', content: '' })));
          if (toolMatch !== null && !toolResult) {
            controller.enqueue(
              sse(
                chunk({
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_mock_1',
                      type: 'function',
                      function: {
                        name: toolMatch[1],
                        arguments: toolMatch[2],
                      },
                    },
                  ],
                }),
              ),
            );
            controller.enqueue(sse(chunk({}, 'tool_calls')));
          } else {
            controller.enqueue(sse(chunk({ content: holdUntil === undefined ? '' : 'working' })));
            if (holdUntil !== undefined) await Promise.race([holdUntil, closed.promise]);
            const reply = toolResult ? 'tool done' : `ok: ${userText}`;
            controller.enqueue(sse(chunk({ content: reply })));
            controller.enqueue(sse(chunk({}, 'stop')));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    release: () => {
      released.resolve();
      released = Promise.withResolvers<void>();
    },
    stop: () => server.stop(true),
  };
}
