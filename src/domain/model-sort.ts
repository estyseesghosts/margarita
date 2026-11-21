import type { CatalogModel } from './model-resolution.ts';

/** Ordering is driven by the actual provider ID, never by vendor-like tokens in a model ID. */
type ProviderFamily = 'anthropic' | 'openai' | 'generic';

const anthropicProviderIDs = new Set(['anthropic', 'anthropic-api']);
const openAIProviderIDs = new Set(['openai', 'codex', 'openai-codex']);

const tierOrder = {
  anthropic: ['mythos', 'fable', 'opus', 'sonnet', 'haiku'],
  openai: ['astra', 'sol', 'terra', 'luna'],
} as const;

function familyOf(providerID: string): ProviderFamily {
  const id = providerID.toLowerCase();
  if (anthropicProviderIDs.has(id)) return 'anthropic';
  if (openAIProviderIDs.has(id)) return 'openai';
  return 'generic';
}

/** First dotted numeric run, e.g. `6.10` in `gpt-6.10-astra`. Effort suffixes never match. */
const releasePattern = /(?:^|[^0-9])(\d+(?:\.\d+)+)(?:[^0-9]|$)/;

function releaseOf(modelID: string): readonly number[] | undefined {
  const match = releasePattern.exec(modelID);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  const parts = raw.split('.').map((part) => Number(part));
  return parts.some((part) => !Number.isFinite(part)) ? undefined : parts;
}

function tierRank(family: ProviderFamily, modelID: string): number | undefined {
  if (family === 'generic') return undefined;
  const lower = modelID.toLowerCase();
  const tiers: readonly string[] = tierOrder[family];
  for (const [index, tier] of tiers.entries()) {
    // A token boundary keeps `sol` from matching `solution` and never reads `#high` as a release.
    if (new RegExp(`(?:^|[-_/])${tier}(?:$|[-_/#])`).test(lower)) return index;
  }
  return undefined;
}

/** Numeric-aware, newest first: 6.10 sorts ahead of 6.9. */
function compareReleaseDesc(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Dated revisions (e.g. 20260102) sort newest first; otherwise a stable ID tie-break. */
function compareRevisionDesc(left: string, right: string): number {
  const leftDate = /\d{6,8}$/.exec(left)?.[0];
  const rightDate = /\d{6,8}$/.exec(right)?.[0];
  if (leftDate !== undefined && rightDate !== undefined && leftDate !== rightDate) {
    return rightDate.localeCompare(leftDate);
  }
  return right.localeCompare(left);
}

function compareGeneric(left: CatalogModel, right: CatalogModel): number {
  const byName = left.name.toLowerCase().localeCompare(right.name.toLowerCase());
  if (byName !== 0) return byName;
  const byID = left.modelID.localeCompare(right.modelID);
  return byID !== 0 ? byID : left.providerID.localeCompare(right.providerID);
}

function compareOfficial(family: ProviderFamily, left: CatalogModel, right: CatalogModel): number {
  const leftRelease = releaseOf(left.modelID);
  const rightRelease = releaseOf(right.modelID);
  if (leftRelease !== undefined && rightRelease !== undefined) {
    const byRelease = compareReleaseDesc(leftRelease, rightRelease);
    if (byRelease !== 0) return byRelease;
  } else if (leftRelease !== undefined) return -1;
  else if (rightRelease !== undefined) return 1;

  const leftTier = tierRank(family, left.modelID);
  const rightTier = tierRank(family, right.modelID);
  if (leftTier !== undefined && rightTier !== undefined && leftTier !== rightTier) {
    return leftTier - rightTier;
  }
  if (leftTier !== undefined && rightTier === undefined) return -1;
  if (leftTier === undefined && rightTier !== undefined) return 1;
  // Same release and tier: newest revision first, then a deterministic ID tie-break.
  return compareRevisionDesc(left.modelID, right.modelID) || compareGeneric(left, right);
}

/**
 * Display order for the model picker: provider groups alphabetically, first-party
 * providers by release then tier, everyone else alphabetically. Pure and stable, so the
 * same catalog always yields the same order across rerenders and refreshes (#166).
 */
export function sortModelCatalogForPicker(models: readonly CatalogModel[]): CatalogModel[] {
  const groups = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const group = groups.get(model.providerID);
    if (group === undefined) groups.set(model.providerID, [model]);
    else group.push(model);
  }
  const providerIDs = [...groups.keys()].toSorted(
    (left, right) =>
      left.toLowerCase().localeCompare(right.toLowerCase()) || left.localeCompare(right),
  );
  const out: CatalogModel[] = [];
  for (const providerID of providerIDs) {
    const group = groups.get(providerID) ?? [];
    const family = familyOf(providerID);
    out.push(
      ...group.toSorted((left, right) =>
        family === 'generic' ? compareGeneric(left, right) : compareOfficial(family, left, right),
      ),
    );
  }
  return out;
}
