/**
 * Client-local URL opening for external MCP elicitations (#233). Only http(s) is ever
 * accepted; the URL is passed as one argv element, never through a shell, and opening is
 * never treated as a form reply.
 */

export type OpenUrlResult = { ok: true } | { ok: false; error: string };

/** A safe external URL, or undefined for malformed input and non-web schemes. */
export function parseExternalUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Platform opener invoked without a shell so URL punctuation cannot become a command. */
export async function openExternalUrl(url: URL, platform: NodeJS.Platform): Promise<OpenUrlResult> {
  const target = url.toString();
  const command =
    platform === 'win32'
      ? ['rundll32.exe', 'url.dll,FileProtocolHandler', target]
      : platform === 'darwin'
        ? ['open', target]
        : ['xdg-open', target];
  try {
    const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    const code = await child.exited;
    return code === 0 ? { ok: true } : { ok: false, error: `opener exited ${code}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
