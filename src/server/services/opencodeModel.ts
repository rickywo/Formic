type JsonRecord = Record<string, unknown>;

export interface OpenCodeModelMetadata {
  providerId?: unknown;
  modelId?: unknown;
  model?: unknown;
}

function cleanIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Produces the stable identity used for OpenCode usage aggregation. OpenCode's
 * providerID/modelID metadata is authoritative; a qualified model string is a
 * fallback for event schemas that do not expose those fields. An unqualified
 * model is retained rather than discarded, but is intentionally not inferred
 * to belong to a provider.
 */
export function normalizeOpenCodeModel(metadata: OpenCodeModelMetadata): string {
  const providerId = cleanIdentifier(metadata.providerId);
  const modelId = cleanIdentifier(metadata.modelId) ?? cleanIdentifier(metadata.model);
  if (modelId === null) return 'unknown';

  const slash = modelId.indexOf('/');
  const qualifiedProvider = slash > 0 ? modelId.slice(0, slash) : null;
  const qualifiedModel = slash > 0 && slash < modelId.length - 1 ? modelId.slice(slash + 1) : null;
  if (providerId !== null) {
    // Some providers repeat `provider/model` in modelID. Avoid provider/model
    // duplication while still trusting the explicit providerID.
    return `${providerId}/${qualifiedProvider === providerId && qualifiedModel !== null ? qualifiedModel : modelId}`;
  }
  return qualifiedProvider !== null && qualifiedModel !== null ? `${qualifiedProvider}/${qualifiedModel}` : modelId;
}

export function recordValue(record: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}
