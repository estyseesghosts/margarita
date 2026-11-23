/**
 * Low-cost import-boundary and import-cycle gate for `src/`.
 *
 * Usage:
 *   bun run check:architecture
 *   bun run scripts/check-architecture.ts --write-baseline
 *
 * The pure checks are exported so `scripts/check-architecture.test.ts` can feed
 * them synthetic files. The CLI only discovers files and reports results.
 * See docs/28-style-and-architecture-enforcement.md for the policy.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';

/** A source file in the shape the pure checks consume. */
export interface SourceFile {
  /** Repository-relative path with forward slashes, e.g. `src/domain/form.ts`. */
  readonly path: string;
  readonly text: string;
}

/** One forbidden production import. */
export interface ImportViolation {
  readonly file: string;
  readonly line: number;
  readonly target: string;
  readonly rule: string;
}

interface ImportSite {
  readonly specifier: string;
  readonly line: number;
}

interface ForbiddenSite {
  readonly line: number;
  readonly target: string;
  readonly rule: string;
}

interface BoundaryRule {
  readonly applies: (path: string) => boolean;
  readonly forbids: (
    specifier: string,
    target: string | undefined,
    text: string,
  ) => readonly ForbiddenSite[];
}

/** True for a test file, which may import any layer to exercise real components. */
function isTest(path: string): boolean {
  return path.startsWith('test/') || /\.test\.tsx?$/.test(path);
}

/** The architectural layer a repository-relative path belongs to. */
function layerOf(path: string): string {
  const parts = path.split('/');
  return parts[0] === 'src' && parts.length > 2 ? (parts[1] ?? '') : '';
}

function targetsLayer(target: string | undefined, layers: readonly string[]): boolean {
  return target !== undefined && layers.includes(layerOf(target));
}

function externalMatches(specifier: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`));
}

const domainRule: BoundaryRule = {
  applies: (path) => layerOf(path) === 'domain' && !isTest(path),
  forbids: (specifier, target) => {
    const problems: ForbiddenSite[] = [];
    if (targetsLayer(target, ['app', 'ui', 'adapter', 'config', 'cli', 'perf'])) {
      problems.push({
        line: 0,
        target: specifier,
        rule: 'domain must not depend on app, ui, adapter, config, cli or perf',
      });
    }
    const external =
      externalMatches(specifier, [
        'solid-js',
        '@opentui/core',
        '@opentui/solid',
        '@opencode/client',
      ]) ||
      /^node:(fs|net|http|https|tls|dgram|dns)/.test(specifier) ||
      specifier === 'bun:sqlite';
    if (external) {
      problems.push({
        line: 0,
        target: specifier,
        rule: 'domain must not import Solid, OpenTUI, @opencode/client or Node I/O',
      });
    }
    return problems;
  },
};

const adapterRule: BoundaryRule = {
  applies: (path) => layerOf(path) === 'adapter' && !isTest(path),
  forbids: (specifier, target) => {
    const problems: ForbiddenSite[] = [];
    if (targetsLayer(target, ['app', 'ui'])) {
      problems.push({
        line: 0,
        target: specifier,
        rule: 'adapter must not depend on app or ui',
      });
    }
    if (externalMatches(specifier, ['solid-js', '@opentui/core', '@opentui/solid'])) {
      problems.push({
        line: 0,
        target: specifier,
        rule: 'adapter must not import Solid or OpenTUI',
      });
    }
    return problems;
  },
};

const uiRule: BoundaryRule = {
  applies: (path) => layerOf(path) === 'ui' && !isTest(path),
  forbids: (specifier) => {
    const problems: ForbiddenSite[] = [];
    if (externalMatches(specifier, ['@opencode/client'])) {
      problems.push({
        line: 0,
        target: specifier,
        rule: 'ui must not import @opencode/client wire internals',
      });
    }
    if (/^node:(net|http|https|tls|dgram|dns)/.test(specifier)) {
      problems.push({
        line: 0,
        target: specifier,
        rule: 'ui must not perform transport RPCs directly',
      });
    }
    return problems;
  },
};

/** Direct fetch() calls in production UI code are transport RPCs, not imports. */
function findFetchViolations(file: SourceFile): readonly ImportViolation[] {
  if (layerOf(file.path) !== 'ui' || isTest(file.path)) {
    return [];
  }
  const found: ImportViolation[] = [];
  for (const [index, line] of withoutComments(file.text).split('\n').entries()) {
    if (/\bfetch\s*\(/.test(line)) {
      found.push({
        file: file.path,
        line: index + 1,
        target: 'fetch(...)',
        rule: 'ui must not perform transport RPCs directly',
      });
    }
  }
  return found;
}

const boundaryRules: readonly BoundaryRule[] = [domainRule, adapterRule, uiRule];

/** Strip line and block comments so commented-out imports and URLs are ignored. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Extract static, type-only, side-effect and dynamic imports with line numbers. */
export function extractImports(text: string): readonly ImportSite[] {
  const clean = withoutComments(text);
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const seen = new Set<string>();
  const sites: ImportSite[] = [];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === undefined) {
        continue;
      }
      const line = clean.slice(0, match.index + 1).split('\n').length;
      const key = `${line}:${specifier}`;
      if (!seen.has(key)) {
        seen.add(key);
        sites.push({ specifier, line });
      }
    }
  }
  return sites.toSorted((left, right) => left.line - right.line);
}

/**
 * Resolve a relative specifier to a known repository-relative source path.
 * Package specifiers are not part of the internal import graph.
 */
function resolveTarget(
  from: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates =
    base.endsWith('.ts') || base.endsWith('.tsx')
      ? [base]
      : [`${base}.ts`, `${base}.tsx`, posix.join(base, 'index.ts')];
  return candidates.find((candidate) => known.has(candidate));
}

/** Report every forbidden import in production source files. */
export function findImportViolations(files: readonly SourceFile[]): readonly ImportViolation[] {
  const known = new Set(files.map((file) => file.path));
  const violations: ImportViolation[] = [];
  for (const file of files) {
    const rules = boundaryRules.filter((rule) => rule.applies(file.path));
    if (rules.length === 0) {
      continue;
    }
    const text = withoutComments(file.text);
    for (const site of extractImports(file.text)) {
      const target = resolveTarget(file.path, site.specifier, known);
      for (const rule of rules) {
        for (const problem of rule.forbids(site.specifier, target, text)) {
          violations.push({
            file: file.path,
            line: problem.line > 0 ? problem.line : site.line,
            target: problem.target,
            rule: problem.rule,
          });
        }
      }
    }
    violations.push(...findFetchViolations(file));
  }
  return violations;
}

/** Build the relative-import graph used for cycle detection. */
export function importGraph(
  files: readonly SourceFile[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const known = new Set(files.map((file) => file.path));
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const edges = new Set<string>();
    for (const site of extractImports(file.text)) {
      const target = resolveTarget(file.path, site.specifier, known);
      if (target !== undefined && target !== file.path) {
        edges.add(target);
      }
    }
    graph.set(file.path, edges);
  }
  return graph;
}

/** Canonical names for import cycles: sorted member paths joined with ` -> `. */
export function findCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): readonly string[] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[] = [];

  function visit(node: string): void {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        // Both maps were set on entry to visit(), so these lookups are defined.
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(next)!));
      } else if (onStack.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(next)!));
      }
    }
    if (lowLinks.get(node) === indices.get(node)) {
      const component: string[] = [];
      let member = '';
      do {
        member = stack.pop() ?? node;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) {
        cycles.push(component.toSorted().join(' -> '));
      }
    }
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) {
      visit(node);
    }
  }
  return cycles.toSorted();
}

/** Cycles absent from the baseline (new) and baseline entries that no longer exist (stale). */
export function compareCycles(
  actual: readonly string[],
  baseline: readonly string[],
): { readonly newCycles: readonly string[]; readonly staleCycles: readonly string[] } {
  const current = new Set(actual);
  const known = new Set(baseline);
  return {
    newCycles: actual.filter((cycle) => !known.has(cycle)),
    staleCycles: baseline.filter((cycle) => !current.has(cycle)),
  };
}

async function readSourceFiles(root: string): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        const text = await readFile(full, 'utf8');
        files.push({ path: relative(root, full).split(sep).join('/'), text });
      }
    }
  }
  await walk(join(root, 'src'));
  return files;
}

/** Validates the checked-in baseline instead of trusting JSON.parse's `any`. */
function parseBaseline(text: string): { readonly cycles: readonly string[] } {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('cycles' in value) ||
    !Array.isArray(value.cycles)
  ) {
    throw new Error('architecture: malformed baseline file; expected {"cycles": [string, ...]}');
  }
  const cycles = value.cycles.filter(
    (cycle: unknown): cycle is string => typeof cycle === 'string',
  );
  if (cycles.length !== value.cycles.length) {
    throw new Error('architecture: every baseline cycle must be a string');
  }
  return { cycles };
}

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const files = await readSourceFiles(root);
  const graph = importGraph(files.filter((file) => !isTest(file.path)));
  const cycles = findCycles(graph);
  const baselinePath = join(root, 'scripts', 'architecture-baseline.json');

  if (process.argv.includes('--write-baseline')) {
    await writeFile(baselinePath, `${JSON.stringify({ cycles }, null, 2)}\n`);
    console.log(`architecture: wrote ${cycles.length} baseline cycles`);
    return;
  }

  const violations = findImportViolations(files);
  let baseline: { cycles: readonly string[] } = { cycles: [] };
  try {
    baseline = parseBaseline(await readFile(baselinePath, 'utf8'));
  } catch (cause: unknown) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
      console.error(
        'architecture: missing baseline; run bun run scripts/check-architecture.ts --write-baseline',
      );
      process.exitCode = 1;
      return;
    }
    throw cause;
  }
  const { newCycles, staleCycles } = compareCycles(cycles, baseline.cycles);

  console.log(`architecture: checked ${files.length} source files`);
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.rule} (${violation.target})`);
  }
  for (const cycle of newCycles) {
    console.error(`architecture: new import cycle: ${cycle}`);
  }
  for (const cycle of staleCycles) {
    console.error(`architecture: stale baseline cycle (remove it): ${cycle}`);
  }
  if (violations.length > 0 || newCycles.length > 0 || staleCycles.length > 0) {
    console.error(
      `architecture: ${violations.length} boundary violations, ${newCycles.length} new cycles, ` +
        `${staleCycles.length} stale cycles`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
