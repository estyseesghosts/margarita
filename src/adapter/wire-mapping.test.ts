import { describe, expect, test } from 'bun:test';

import type {
  JsonValue,
  SessionMessageAssistant,
  SessionMessageInfo,
  ToolContent,
} from '@opencode/client';

import { maxToolOutputChars, toTranscriptMessage, toWorkerJob } from './wire-mapping.ts';

describe('subagent job mapping (#101)', () => {
  const rawJob = {
    kind: 'subagent',
    id: 'job_1',
    sessionID: 'parent',
    childSessionID: 'child_1',
    status: 'running',
    agent: 'build',
    description: 'review patch',
    title: 'Reviewer',
    time: { started: 1000 },
  };

  test('maps a confirmed subagent with its child identity and times', () => {
    expect(toWorkerJob(rawJob)).toEqual({
      id: 'job_1',
      childSessionID: 'child_1',
      agent: 'build',
      description: 'review patch',
      title: 'Reviewer',
      status: 'running',
      startedAt: 1000,
    });
    expect(toWorkerJob({ ...rawJob, time: { started: 1000, completed: 4500 } })).toMatchObject({
      status: 'running',
      completedAt: 4500,
    });
  });

  test('drops non-subagent jobs and future/unknown statuses', () => {
    expect(toWorkerJob({ ...rawJob, kind: 'shell' })).toBeUndefined();
    expect(toWorkerJob({ ...rawJob, status: 'parked' })).toBeUndefined();
  });

  test('drops malformed jobs instead of guessing an identity', () => {
    expect(toWorkerJob(null)).toBeUndefined();
    expect(toWorkerJob('job_1')).toBeUndefined();
    expect(toWorkerJob({ ...rawJob, childSessionID: 7 })).toBeUndefined();
    expect(toWorkerJob({ ...rawJob, time: {} })).toBeUndefined();
  });
});

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

function executeTool(
  content: [ToolContent, ...ToolContent[]],
  metadata?: Record<string, JsonValue>,
): SessionMessageAssistant {
  return {
    type: 'assistant',
    id: 'msg_exec',
    agent: 'build',
    model: { id: 'm', providerID: 'p' },
    content: [
      {
        type: 'tool',
        id: 'tool_exec',
        name: 'execute',
        time: { created: 1, completed: 2 },
        state: {
          status: 'completed',
          input: { code: 'await lotus.step_frame()' },
          content,
          ...(metadata === undefined ? {} : { metadata }),
        },
      },
    ],
    time: { created: 1, completed: 2 },
  };
}

describe('Code Mode nested calls and file parts (#216, #218)', () => {
  test('ordered nested calls keep stable parent/index identities', () => {
    const tool = toolOutput(
      executeTool([{ type: 'text', text: 'done' }], {
        toolCalls: [
          { tool: 'lotus.step_frame', status: 'completed', input: { frame: 1 } },
          { tool: 'lotus.get_issue', status: 'running', input: { number: 217 } },
          { tool: 'read', status: 'error', input: { filePath: 'src/a.ts' } },
        ],
      }),
    );
    expect(tool.children?.map((child) => child.id)).toEqual([
      'tool_exec:0',
      'tool_exec:1',
      'tool_exec:2',
    ]);
    expect(tool.children?.map((child) => child.name)).toEqual([
      'lotus.step_frame',
      'lotus.get_issue',
      'read',
    ]);
    expect(tool.children?.map((child) => child.status)).toEqual(['completed', 'running', 'error']);
  });

  test('malformed children are skipped without losing the parent call', () => {
    const tool = toolOutput(
      executeTool([{ type: 'text', text: 'ok' }], {
        toolCalls: [
          { tool: 'lotus.ok', status: 'completed', input: { line: 'x\u001b[2J'.repeat(500) } },
          null,
          { tool: '', status: 'completed' },
          { tool: 'lotus.bad', status: 'parked' },
        ],
      }),
    );
    expect(tool.children).toHaveLength(1);
    expect(tool.children?.[0]?.input?.['line']).not.toContain('\u001b');
    expect(String(tool.children?.[0]?.input?.['line']).length).toBeLessThanOrEqual(201);
    const bare = toolOutput(executeTool([{ type: 'text', text: 'ok' }], { toolCalls: 'nope' }));
    expect(bare.children).toBeUndefined();
    expect(bare.output).toBe('ok');
  });

  test('optional child diagnostics are retained when supplied and never invented (#231)', () => {
    const tool = toolOutput(
      executeTool([{ type: 'text', text: 'done' }], {
        toolCalls: [
          {
            tool: 'lotus.fail',
            status: 'error',
            input: { number: 4 },
            error: 'boom\u001b[2J',
            result: 'partial child output',
            time: { started: 10, completed: 30 },
          },
          { tool: 'lotus.ok', status: 'completed', input: { line: 1 } },
        ],
      }),
    );
    const [failed, completed] = tool.children ?? [];
    expect(failed?.error).toBe('boom');
    expect(failed?.output).toBe('partial child output');
    expect(failed?.startedAt).toBe(10);
    expect(failed?.completedAt).toBe(30);
    expect(completed?.error).toBeUndefined();
    expect(completed?.output).toBeUndefined();
    expect(completed?.startedAt).toBeUndefined();
    expect(completed?.completedAt).toBeUndefined();

    const big = toolOutput(
      executeTool([{ type: 'text', text: 'done' }], {
        toolCalls: [
          {
            tool: 'lotus.big',
            status: 'completed',
            result: 'a'.repeat(5000),
          },
        ],
      }),
    );
    expect(big.children?.[0]?.outputTruncated).toBe(true);
    expect(big.children?.[0]?.output?.length).toBeLessThanOrEqual(1001);
  });

  test('metadata.error marks a completed execute as a visible failure', () => {
    const tool = toolOutput(
      executeTool([{ type: 'text', text: 'partial' }], {
        error: true,
        toolCalls: [{ tool: 'lotus.fail', status: 'error' }],
      }),
    );
    expect(tool.status).toBe('completed');
    expect(tool.executionError).toBe('Code Mode execution failed.');
  });

  test('data URI files become metadata only and never flood output', () => {
    const payload = `data:image/png;base64,${'A'.repeat(100_000)}`;
    const tool = toolOutput(
      executeTool([
        { type: 'text', text: 'image ready' },
        { type: 'file', uri: payload, mime: 'image/png', name: 'shot.png' },
        { type: 'file', uri: 'file:///tmp/report.pdf', mime: 'application/pdf' },
      ]),
    );
    expect(tool.output).toBe('image ready');
    expect(tool.output).not.toContain('base64');
    expect(tool.files?.map((file) => file.name)).toEqual(['shot.png', 'report.pdf']);
    expect(tool.files?.[0]).toMatchObject({ mime: 'image/png', size: 75_000 });
    expect(tool.files?.[0]?.uri).toBeUndefined();
    expect(tool.files?.[1]?.uri).toBe('file:///tmp/report.pdf');
  });

  test('a files-only result has no printable output but keeps metadata', () => {
    const tool = toolOutput(
      executeTool([
        {
          type: 'file',
          uri: 'data:application/octet-stream;base64,AAAA',
          mime: 'application/octet-stream',
        },
      ]),
    );
    expect(tool.output).toBeUndefined();
    expect(tool.files).toHaveLength(1);
    expect(tool.files?.[0]?.size).toBe(3);
  });
});
