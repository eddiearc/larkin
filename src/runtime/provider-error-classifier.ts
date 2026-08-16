export type StrictProviderErrorInput = {
  message?: unknown;
  code?: unknown;
  type?: unknown;
  errorCategory?: unknown;
};

export type ProviderErrorSource = {
  reason?: unknown;
  message?: unknown;
  errorCategory?: unknown;
  code?: unknown;
  type?: unknown;
  upstream?: unknown;
};

export const CODEX_ERROR_PREFIX = "Codex error: ";
export const CANONICAL_CONTEXT_WINDOW_MESSAGE =
  "Your input exceeds the context window of this model. Please adjust your input and try again.";
export const INTERNAL_CONTEXT_WINDOW_PROJECTION_REASON =
  "provider rejected the input because the context window was exceeded";

/** Build the one structured provider-error shape shared by ingestion and recovery. */
export function buildStrictProviderErrorInput(source: ProviderErrorSource): StrictProviderErrorInput {
  const upstream = source.upstream && typeof source.upstream === "object" && !Array.isArray(source.upstream)
    ? source.upstream as Record<string, unknown> : {};
  return {
    message: source.reason !== undefined ? source.reason : source.message,
    code: source.code ?? upstream.code,
    type: source.type ?? upstream.type,
    errorCategory: source.errorCategory,
  };
}

/**
 * The recovery path intentionally recognizes only the complete canonical
 * provider message, or the exact internal projection when its category is
 * persisted alongside it. The Codex wrapper is the only normalization
 * permitted for the provider message.
 */
export function classifyStrictProviderError(error: StrictProviderErrorInput): "context_window" | undefined {
  if (typeof error.message !== "string") return undefined;
  if (error.errorCategory !== undefined && error.errorCategory !== "context_window") return undefined;
  const message = error.message.startsWith(CODEX_ERROR_PREFIX)
    ? error.message.slice(CODEX_ERROR_PREFIX.length) : error.message;
  if (message === CANONICAL_CONTEXT_WINDOW_MESSAGE) return "context_window";
  if (error.errorCategory === "context_window" && error.message === INTERNAL_CONTEXT_WINDOW_PROJECTION_REASON) {
    return "context_window";
  }
  return undefined;
}
