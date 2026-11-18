/**
 * Makes captured SDK responses stable and free of machine-specific data:
 * - server-generated IDs (`ses_…`, `msg_…`, `per_…`, `frm_…`, `prj_…`) become `<prefix>_fixtureN`
 *   in order of first appearance, so references between fixtures stay consistent;
 * - epoch-millisecond timestamps keep their relative order but start at a fixed base;
 * - the workspace path (either slash style) becomes `/workspace`.
 */
const idPattern = /\b(ses|msg|per|frm|prj|evt|wrk)_[0-9A-Za-z]{10,}/g;
const timestampFloor = 1_000_000_000_000;
const timestampBase = 1_700_000_000_000;

export function sanitizeFixture(value: unknown, workspace: string): Record<string, unknown> {
  const ids = new Map<string, string>();
  const stamps = new Set<number>();
  collectStamps(value, stamps);
  const ranks = new Map([...stamps].toSorted((a, b) => a - b).map((stamp, i) => [stamp, i]));
  const slashes = [workspace, workspace.replaceAll('\\', '/')];

  const clean = (node: unknown): unknown => {
    if (typeof node === 'number') {
      const rank = ranks.get(node);
      return rank === undefined ? node : timestampBase + rank * 10;
    }
    if (typeof node === 'string') {
      let text = node;
      for (const variant of slashes) text = text.replaceAll(variant, '/workspace');
      return text.replace(idPattern, (match, prefix: string) => {
        const known = ids.get(match);
        if (known !== undefined) return known;
        const next = `${prefix}_fixture${ids.size + 1}`;
        ids.set(match, next);
        return next;
      });
    }
    if (Array.isArray(node)) return node.map(clean);
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, clean(child)]));
    }
    return node;
  };
  const result = clean(value);
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? Object.fromEntries(Object.entries(result))
    : {};
}

function collectStamps(node: unknown, into: Set<number>): void {
  if (typeof node === 'number' && Number.isInteger(node) && node >= timestampFloor) {
    into.add(node);
  } else if (Array.isArray(node)) {
    for (const child of node) collectStamps(child, into);
  } else if (typeof node === 'object' && node !== null) {
    for (const child of Object.values(node)) collectStamps(child, into);
  }
}
