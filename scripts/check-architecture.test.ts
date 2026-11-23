import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  compareCycles,
  DYNAMIC_SPECIFIER,
  extractImports,
  findCycles,
  findImportViolations,
  importGraph,
  type SourceFile,
} from './check-architecture.ts';

function source(path: string, text: string): SourceFile {
  return { path, text };
}

describe('architecture boundary gate', () => {
  test('rejects a forbidden domain -> ui import', () => {
    const violations = findImportViolations([
      source('src/ui/app.tsx', 'export const view = 1;\n'),
      source('src/domain/form.ts', "import { view } from '../ui/app.tsx';\n"),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('src/domain/form.ts');
    expect(violations[0]?.rule).toContain('domain must not depend on');
  });

  test('rejects a forbidden ui -> @opencode/client import', () => {
    const violations = findImportViolations([
      source('src/ui/transcript-view.tsx', "import { OpenCode } from '@opencode/client';\n"),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toContain('ui must not import @opencode/client');
  });

  test('rejects adapter -> app and direct UI fetch', () => {
    const violations = findImportViolations([
      source('src/app/controller.ts', 'export class AppController {}\n'),
      source('src/adapter/backend.ts', "import { AppController } from '../app/controller.ts';\n"),
      source('src/ui/overlays.tsx', "const load = () => fetch('/api/session');\n"),
    ]);
    expect(violations.map((violation) => violation.rule)).toEqual([
      'adapter must not depend on app or ui',
      'ui must not perform transport RPCs directly',
    ]);
    expect(violations[1]?.line).toBe(1);
  });

  test('allows test-only imports and composition-root wiring', () => {
    const violations = findImportViolations([
      source(
        'test/production-composition.test.ts',
        "import { AppController } from '../src/app/controller.ts';\n",
      ),
      source('src/domain/form.test.ts', "import { AppController } from '../app/controller.ts';\n"),
      source('src/domain/form.ts', "import type { FormEditor } from './form-types.ts';\n"),
      source('src/adapter/backend.ts', "import { OpenCode } from '@opencode/client';\n"),
      source('src/ui/app.tsx', "import { createSignal } from 'solid-js';\n"),
      source('src/main.ts', "import { createBackend } from './adapter/backend.ts';\n"),
      source(
        'src/app/production-assembly.ts',
        "import { AppController } from './controller.ts';\n",
      ),
    ]);
    expect(violations).toEqual([]);
  });

  test('parses multiline and type-only imports and ignores commented imports', () => {
    const sites = extractImports(
      [
        '// import { Fake } from "../ui/fake.ts";',
        'import type {',
        '  Thing,',
        "} from '../domain/thing.ts';",
        "const lazy = await import('../app/key-router.ts');",
        "import '../domain/side-effect.ts';",
      ].join('\n'),
    );
    expect(sites.map((site) => [site.specifier, site.line])).toEqual([
      ['../domain/thing.ts', 2],
      ['../app/key-router.ts', 5],
      ['../domain/side-effect.ts', 6],
    ]);
  });

  test('rejects bare and node-prefixed I/O, other wire packages and require edges (#325)', () => {
    const violations = findImportViolations([
      source(
        'src/domain/io.ts',
        "import { readFile } from 'fs/promises';\nimport { connect } from 'node:net';\n",
      ),
      source('src/domain/wire.ts', "export * from '@opencode/other-package';\n"),
      source('src/app/controller.ts', 'export class AppController {}\n'),
      source('src/adapter/legacy.ts', "const controller = require('../app/controller.ts');\n"),
      source('src/ui/transport.ts', "import type { Client } from 'http';\n"),
    ]);
    expect(violations.map((violation) => [violation.file, violation.target])).toEqual([
      ['src/domain/io.ts', 'fs/promises'],
      ['src/domain/io.ts', 'node:net'],
      ['src/domain/wire.ts', '@opencode/other-package'],
      ['src/adapter/legacy.ts', '../app/controller.ts'],
      ['src/ui/transport.ts', 'http'],
    ]);
  });

  test('parses re-exports, import-equals and require without trusting comments or strings', () => {
    const sites = extractImports(
      [
        '// import { Fake } from "./comment.ts";',
        'const text = \'import { fake } from "./string.ts"\';',
        "import type { A } from './a.ts';",
        "export * from './b.ts';",
        "import './side.ts';",
        "const lazy = await import('./lazy.ts');",
        "const legacy = require('./legacy.ts');",
        "import old = require('./old.ts');",
      ].join('\n'),
    );
    expect(sites.map((site) => site.specifier)).toEqual([
      './a.ts',
      './b.ts',
      './side.ts',
      './lazy.ts',
      './legacy.ts',
      './old.ts',
    ]);
  });

  test('fails closed on a computed module specifier (#325)', () => {
    const violations = findImportViolations([
      source('src/app/runtime.ts', 'const name = chooseModule();\nawait import(name);\n'),
    ]);
    expect(violations).toEqual([
      {
        file: 'src/app/runtime.ts',
        line: 2,
        target: DYNAMIC_SPECIFIER,
        rule: 'dynamic module specifiers must be literal so the gate can check them',
      },
    ]);
  });

  test('the verify CLI rejects a deliberately forbidden import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'architecture-gate-'));
    try {
      await mkdir(join(root, 'src', 'domain'), { recursive: true });
      await mkdir(join(root, 'scripts'), { recursive: true });
      await writeFile(
        join(root, 'src', 'domain', 'bad.ts'),
        "import { readFile } from 'fs/promises';\n",
      );
      await writeFile(join(root, 'scripts', 'architecture-baseline.json'), '{"cycles":[]}\n');
      const child = Bun.spawn([process.execPath, resolve('scripts/check-architecture.ts')], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(1);
      expect(stderr).toContain('fs/promises');
      expect(stderr).toContain('boundary violations');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('architecture cycle ratchet', () => {
  test('finds cycles with stable canonical names and ignores acyclic files', () => {
    const graph = importGraph([
      source('src/app/a.ts', "import './b.ts';"),
      source('src/app/b.ts', "import './a.ts';"),
      source('src/app/c.ts', "import './a.ts';"),
    ]);
    expect(findCycles(graph)).toEqual(['src/app/a.ts -> src/app/b.ts']);
  });

  test('fails new cycles and stale baselines, accepts known cycles', () => {
    const known = 'src/app/a.ts -> src/app/b.ts';
    const graph = importGraph([
      source('src/app/a.ts', "import './b.ts';"),
      source('src/app/b.ts', "import './a.ts';"),
      source('src/app/x.ts', "import './y.ts';"),
      source('src/app/y.ts', "import './x.ts';"),
    ]);
    const result = compareCycles(findCycles(graph), [known, 'src/app/gone.ts -> src/app/old.ts']);
    expect(result.newCycles).toEqual(['src/app/x.ts -> src/app/y.ts']);
    expect(result.staleCycles).toEqual(['src/app/gone.ts -> src/app/old.ts']);
    expect(compareCycles(findCycles(graph), findCycles(graph)).newCycles).toEqual([]);
  });
});
