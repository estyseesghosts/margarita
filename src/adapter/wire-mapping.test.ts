import { describe, expect, test } from 'bun:test';

import type { JsonValue, SessionMessageAssistant, SessionMessageInfo } from '@opencode/client';

import { maxToolOutputChars, toTranscriptMessage } from './wire-mapping.ts';

function assistantWithTool(
  output: string,
  metadata?: Record<string, string | number | boolean>,
): SessionMessageAssistant {
  return {
    type: 'assistant',
    id: 'msg_1',
    agent: 'build',
    model: { id: 'm', providerID: 'p' },
    content: [
      {
        type: 'tool',
        id: 'tool_1',
        name: 'bash',
        time: { created: 1, completed: 2 },
        state: {
          status: 'completed',
          input: { command: 'big-test' },
          content: [{ type: 'text', text: output }],
          ...(metadata === undefined ? {} : { metadata }),
        },
      },
    ],
    time: { created: 1, completed: 2 },
  };
}

function toolOutput(message: SessionMessageInfo, options?: { maxToolOutputChars?: number }) {
  const mapped = toTranscriptMessage(message, options);
  if (mapped === undefined || mapped.kind !== 'assistant') throw new Error('expected assistant');
  const tool = mapped.parts.find((part) => part.kind === 'tool')?.tool;
  if (tool === undefined) throw new Error('expected tool part');
  return tool;
}

function editTool(
  name: string,
  input: Record<string, JsonValue>,
  metadata?: Record<string, JsonValue>,
): SessionMessageAssistant {
  return {
    type: 'assistant',
    id: 'msg_1',
    agent: 'build',
    model: { id: 'm', providerID: 'p' },
    content: [
      {
        type: 'tool',
        id: 'tool_1',
        name,
        time: { created: 1, completed: 2 },
        state: {
          status: 'completed',
          input,
          content: [{ type: 'text', text: 'done' }],
          ...(metadata === undefined ? {} : { metadata }),
        },
      },
    ],
    time: { created: 1, completed: 2 },
  };
}

describe('server-provided edit diffs (issue #22)', () => {
  test('edit metadata files[].patch is carried through as the tool diff', () => {
    const patch = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y';
    const tool = toolOutput(
      editTool(
        'edit',
        { path: 'src/a.ts', oldString: 'x', newString: 'y' },
        { files: [{ file: 'src/a.ts', patch, status: 'modified', additions: 1, deletions: 1 }] },
      ),
    );
    expect(tool.diff).toBe(patch);
    expect(tool.diffFile).toBe('src/a.ts');
  });

  test('write reports the same shape', () => {
    const patch = '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b';
    const tool = toolOutput(
      editTool(
        'write',
        { path: 'n.txt', content: 'a\nb' },
        { files: [{ file: 'n.txt', patch, status: 'added', additions: 2, deletions: 0 }] },
      ),
    );
    expect(tool.diff).toBe(patch);
  });

  test('the patch tool metadata.diff string is preferred over per-file entries', () => {
    const tool = toolOutput(
      editTool(
        'patch',
        { patchText: '@@ -1 +1 @@\n-a\n+b' },
        {
          diff: '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n',
          files: [
            {
              file: 'x.ts',
              patch: '@@ -1 +1 @@\n-a\n+b',
              status: 'modified',
              additions: 1,
              deletions: 1,
            },
          ],
        },
      ),
    );
    expect(tool.diff).toBe('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n');
  });

  test('a files entry with no patch yields no diff rather than an empty one', () => {
    const tool = toolOutput(
      editTool('edit', { path: 'src/a.ts' }, { files: [{ file: 'src/a.ts' }] }),
    );
    expect(tool.diff).toBeUndefined();
  });
});

describe('tool output retention (issue #7)', () => {
  test('long output keeps head and tail; a failure at the tail stays visible', () => {
    const head = 'HEAD-' + 'h'.repeat(40_000);
    const tail = 't'.repeat(40_000) + 'FAILURE-AT-END';
    const tool = toolOutput(assistantWithTool(head + tail));
    expect(tool.outputTruncated).toBe('frontend');
    expect(tool.output).toContain('HEAD-');
    expect(tool.output).toContain('FAILURE-AT-END');
    expect(tool.output).toContain('omitted from the middle');
    expect(tool.output!.length).toBeLessThanOrEqual(maxToolOutputChars + 200);
  });

  test('short output is kept verbatim and not marked truncated', () => {
    const tool = toolOutput(assistantWithTool('small output'));
    expect(tool.output).toBe('small output');
    expect(tool.outputTruncated).toBeUndefined();
  });

  test('the cap is configurable', () => {
    const output = 'a'.repeat(5_000);
    const tool = toolOutput(assistantWithTool(output), { maxToolOutputChars: 1_000 });
    expect(tool.outputTruncated).toBe('frontend');
    expect(tool.output!.length).toBeLessThan(1_200);
  });

  test('server-flagged truncation is reported as server-side, not frontend', () => {
    const tool = toolOutput(assistantWithTool('full small output', { truncated: true }));
    expect(tool.outputTruncated).toBe('server');
  });
});
