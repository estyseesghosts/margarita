import { describe, expect, test } from 'bun:test';

import {
  compareCycles,
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
