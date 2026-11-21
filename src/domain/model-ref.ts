/** A provider-qualified model choice, optionally pinned to a catalog variant (effort). */
export type ModelSelection = Readonly<{
  providerID: string;
  modelID: string;
  variant?: string;
}>;

/** Formats a selection using OpenCode's `provider/model#variant` syntax. */
export function formatModelRef(model: ModelSelection): string {
  const base = `${model.providerID}/${model.modelID}`;
  return model.variant === undefined ? base : `${base}#${model.variant}`;
}

export type ParsedModelRef = Readonly<{
  providerID?: string;
  modelID: string;
  variant?: string;
}>;

/**
 * Parses `model`, `model#variant`, `provider/model` or `provider/model#variant`.
 * Model IDs may themselves contain `/` (e.g. `vendor/name:free`), so only the first
 * segment is treated as the provider when a slash is present.
 */
export function parseModelRef(input: string): ParsedModelRef | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  const hashIndex = trimmed.lastIndexOf('#');
  const body = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  const variant = hashIndex === -1 ? undefined : trimmed.slice(hashIndex + 1);
  if (body === '' || variant === '') return undefined;
  const slashIndex = body.indexOf('/');
  const providerID = slashIndex === -1 ? undefined : body.slice(0, slashIndex);
  const modelID = slashIndex === -1 ? body : body.slice(slashIndex + 1);
  if (modelID === '' || providerID === '') return undefined;
  return {
    modelID,
    ...(providerID === undefined ? {} : { providerID }),
    ...(variant === undefined ? {} : { variant }),
  };
}

/** OpenCode v2 accepts an omitted variant and the literal `default` as the same selection. */
export const defaultVariant = 'default';

/** The variant that distinguishes a model: omitted and `default` both mean "no override". */
export function effectiveVariant(variant: string | undefined): string | undefined {
  return variant === undefined || variant === '' || variant === defaultVariant
    ? undefined
    : variant;
}

/** Stable representation: the default is stored as no variant at all (#206). */
export function normalizeModel(model: ModelSelection): ModelSelection {
  const variant = effectiveVariant(model.variant);
  return variant === undefined
    ? { providerID: model.providerID, modelID: model.modelID }
    : { providerID: model.providerID, modelID: model.modelID, variant };
}

/**
 * Semantic equality: provider and model must match exactly; only the variant treats an
 * omitted value and `default` as equivalent. `low`, `high`, ... stay strictly distinct.
 */
export function sameModel(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    effectiveVariant(left.variant) === effectiveVariant(right.variant)
  );
}
