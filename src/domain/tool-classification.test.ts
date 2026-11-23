import { describe, expect, test } from 'bun:test';

import {
  classifyTool,
  isBuiltinToolName,
  mcpNamespace,
  toolIdentity,
} from './tool-classification.ts';
// Imported from both paths to prove the temporary transcript re-exports stay stable (#319).
import { toolIdentity as identityViaTranscript } from './transcript.ts';

describe('tool identity and classification (#319)', () => {
  test('normalizes MCP server names to flattened registry namespaces', () => {
    expect(mcpNamespace('my.server-name')).toBe('my_server-name');
    expect(mcpNamespace('a/b')).toBe('a_b');
  });

  test('recognizes built-ins case-insensitively and keeps their category', () => {
    expect(toolIdentity('BASH')).toEqual({ kind: 'builtin', category: 'shell' });
    expect(classifyTool('execute')).toBe('code');
    expect(classifyTool('Apply_Patch')).toBe('edit');
    expect(classifyTool('unknown-tool')).toBe('other');
    expect(isBuiltinToolName('grep')).toBe(true);
    expect(isBuiltinToolName('grep_files')).toBe(false);
  });

  test('recovers the owning server from underscore and Code Mode qualified names', () => {
    const servers = ['my.server'];
    expect(toolIdentity('my_server_read_file', servers)).toEqual({
      kind: 'mcp',
      server: 'my.server',
      tool: 'read_file',
    });
    expect(toolIdentity('my_server.read_file', servers)).toEqual({
      kind: 'mcp',
      server: 'my.server',
      tool: 'read_file',
    });
  });

  test('prefers the longest configured prefix so a and a_b stay distinct', () => {
    const servers = ['a', 'a_b'];
    expect(toolIdentity('a_b_list', servers)).toEqual({
      kind: 'mcp',
      server: 'a_b',
      tool: 'list',
    });
  });

  test('reports an unknown tool as external rather than guessing a server', () => {
    expect(toolIdentity('mystery_tool', ['other'])).toEqual({ kind: 'external' });
    expect(toolIdentity('mystery_tool')).toEqual({ kind: 'external' });
  });

  test('transcript still re-exports the same identity function', () => {
    expect(identityViaTranscript('a_b_list', ['a', 'a_b'])).toEqual(
      toolIdentity('a_b_list', ['a', 'a_b']),
    );
  });
});
