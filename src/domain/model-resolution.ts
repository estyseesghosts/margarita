import {
  effectiveVariant,
  type ModelSelection,
  type ParsedModelRef,
  parseModelRef,
} from './model-ref.ts';

/** The subset of a catalog entry needed to validate a model choice. */
export type CatalogModel = Readonly<{
  providerID: string;
  modelID: string;
  name: string;
  enabled: boolean;
  variants: readonly string[];
  /** Model context-window size from `limit.context`, when the server reports it (#124). */
  contextLimit?: number;
}>;

export type ModelRequest = Readonly<{
  provider?: string;
  model?: string;
  effort?: string;
}>;

export type ModelResolution =
  | { kind: 'default' }
  | { kind: 'resolved'; model: ModelSelection }
  | { kind: 'error'; message: string };

/**
 * Resolves CLI `--provider/--model/--effort` against the live catalog.
 * Contradictions and unknown values are errors; nothing silently falls back.
 */
export function resolveModel(
  request: ModelRequest,
  catalog: readonly CatalogModel[],
): ModelResolution {
  if (request.model === undefined) {
    if (request.effort !== undefined) {
      return { kind: 'error', message: '--effort requires --model.' };
    }
    if (request.provider !== undefined) {
      return {
        kind: 'error',
        message: `--provider ${request.provider} needs --model; available: ${listFor(catalog, request.provider)}`,
      };
    }
    return { kind: 'default' };
  }
  const raw = parseModelRef(request.model);
  if (raw === undefined) return { kind: 'error', message: `Invalid model "${request.model}".` };
  const parsed = reinterpretWithProvider(raw, request.provider, catalog);
  if (
    parsed.providerID !== undefined &&
    request.provider !== undefined &&
    parsed.providerID !== request.provider
  ) {
    return {
      kind: 'error',
      message: `--model names provider "${parsed.providerID}" but --provider is "${request.provider}".`,
    };
  }
  if (
    parsed.variant !== undefined &&
    request.effort !== undefined &&
    parsed.variant !== request.effort
  ) {
    return {
      kind: 'error',
      message: `--model pins variant "${parsed.variant}" but --effort is "${request.effort}".`,
    };
  }
  const variant = parsed.variant ?? request.effort;
  const candidates = findCandidates(catalog, parsed.providerID, parsed.modelID, request.provider);
  if (candidates.length === 0) {
    return { kind: 'error', message: `Model "${request.model}" is not in the server catalog.` };
  }
  const [match, ...others] = candidates;
  if (match === undefined) return { kind: 'error', message: 'No catalog match.' };
  if (others.length > 0) {
    const providers = candidates.map((entry) => entry.providerID).join(', ');
    return {
      kind: 'error',
      message: `Model "${match.modelID}" is offered by several providers (${providers}); pass --provider.`,
    };
  }
  if (!match.enabled) {
    return { kind: 'error', message: `Model ${match.providerID}/${match.modelID} is disabled.` };
  }
  if (variant !== undefined && !match.variants.includes(variant)) {
    const available = match.variants.length === 0 ? 'none' : match.variants.join(', ');
    return {
      kind: 'error',
      message: `Model ${match.providerID}/${match.modelID} has no variant "${variant}". Available: ${available}.`,
    };
  }
  return {
    kind: 'resolved',
    model: {
      providerID: match.providerID,
      modelID: match.modelID,
      ...(variant === undefined ? {} : { variant }),
    },
  };
}

/**
 * Model IDs may contain `/`, so `a/b` is either provider `a` + model `b`, or a bare model
 * ID `a/b` under some other provider. Both readings are considered; flags narrow them.
 */
function findCandidates(
  catalog: readonly CatalogModel[],
  parsedProvider: string | undefined,
  parsedModel: string,
  flagProvider: string | undefined,
): CatalogModel[] {
  const qualified =
    parsedProvider === undefined
      ? []
      : catalog.filter(
          (entry) => entry.providerID === parsedProvider && entry.modelID === parsedModel,
        );
  if (qualified.length > 0) return qualified;
  const fullID = parsedProvider === undefined ? parsedModel : `${parsedProvider}/${parsedModel}`;
  return catalog.filter(
    (entry) =>
      entry.modelID === fullID && (flagProvider === undefined || entry.providerID === flagProvider),
  );
}

/**
 * With `--provider commandcode --model vendor/name`, `vendor` is part of the model ID
 * unless `vendor/name` is itself a real provider/model pair in the catalog.
 */
function reinterpretWithProvider(
  parsed: ParsedModelRef,
  flagProvider: string | undefined,
  catalog: readonly CatalogModel[],
): ParsedModelRef {
  if (
    flagProvider === undefined ||
    parsed.providerID === undefined ||
    parsed.providerID === flagProvider
  ) {
    return parsed;
  }
  const qualifiedExists = catalog.some(
    (entry) => entry.providerID === parsed.providerID && entry.modelID === parsed.modelID,
  );
  if (qualifiedExists) return parsed;
  return {
    modelID: `${parsed.providerID}/${parsed.modelID}`,
    ...(parsed.variant === undefined ? {} : { variant: parsed.variant }),
  };
}

function listFor(catalog: readonly CatalogModel[], provider: string): string {
  const models = catalog
    .filter((entry) => entry.providerID === provider)
    .map((entry) => entry.modelID);
  if (models.length === 0) return 'none (unknown provider)';
  const shown = models.slice(0, 8).join(', ');
  return models.length > 8 ? `${shown}, …` : shown;
}

/** Where an effective new-session model came from, highest precedence first (#189). */
export type ModelSource =
  'selection' | 'pinned-project' | 'pinned-user' | 'last-used' | 'server-default';

export type EffectiveModel =
  /** The catalog for this scope has not been verified yet. */
  | { kind: 'loading' }
  /** A concrete model that is present in the verified scoped catalog. */
  | { kind: 'model'; model: ModelSelection; source: ModelSource }
  /**
   * A model the user explicitly asked for is not available. It is never replaced silently:
   * the caller must report it and require user action (#190).
   */
  | { kind: 'blocked'; model: ModelSelection; source: ModelSource; reason: string }
  /** The scope is verified but offers no model at all. */
  | { kind: 'none' };

export type EffectiveModelInput = Readonly<{
  /** False until the catalog for the exact (server, directory) scope has loaded. */
  catalogReady: boolean;
  catalog: readonly CatalogModel[];
  /** A choice made in this client for the new session (picker, F2 or CLI flags). */
  selection?: ModelSelection | undefined;
  pinnedProject?: ModelSelection | undefined;
  pinnedUser?: ModelSelection | undefined;
  lastUsed?: ModelSelection | undefined;
  serverDefault?: ModelSelection | undefined;
}>;

/** True when the catalog offers the model, enabled, and supports the requested variant. */
export function isModelAvailable(catalog: readonly CatalogModel[], model: ModelSelection): boolean {
  return catalog.some(
    (entry) =>
      entry.enabled &&
      entry.providerID === model.providerID &&
      entry.modelID === model.modelID &&
      // The default needs no catalog entry: models with `variants: []` still accept it (#206).
      (effectiveVariant(model.variant) === undefined ||
        entry.variants.includes(model.variant ?? '')),
  );
}

/**
 * Single effective-model resolver for a brand-new session. Explicit choices (selection,
 * pins) that the catalog cannot satisfy block instead of falling through; only the
 * automatic last-used memory is skipped when stale. OpenCode's own project configuration
 * is not distinguishable from its general default on the wire, so it ranks as the server
 * default.
 */
export function resolveEffectiveModel(input: EffectiveModelInput): EffectiveModel {
  if (!input.catalogReady) return { kind: 'loading' };
  const explicit: ReadonlyArray<[ModelSelection | undefined, ModelSource]> = [
    [input.selection, 'selection'],
    [input.pinnedProject, 'pinned-project'],
    [input.pinnedUser, 'pinned-user'],
  ];
  for (const [model, source] of explicit) {
    if (model === undefined) continue;
    if (isModelAvailable(input.catalog, model)) return { kind: 'model', model, source };
    return {
      kind: 'blocked',
      model,
      source,
      reason: `${source === 'selection' ? 'Selected' : 'Pinned'} model is not available for this project`,
    };
  }
  if (input.lastUsed !== undefined && isModelAvailable(input.catalog, input.lastUsed)) {
    return { kind: 'model', model: input.lastUsed, source: 'last-used' };
  }
  if (input.serverDefault !== undefined) {
    return { kind: 'model', model: input.serverDefault, source: 'server-default' };
  }
  return { kind: 'none' };
}
