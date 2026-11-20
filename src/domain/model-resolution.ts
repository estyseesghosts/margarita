import { type ModelSelection, type ParsedModelRef, parseModelRef } from './model-ref.ts';

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
