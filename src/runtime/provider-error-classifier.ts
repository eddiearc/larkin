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

/** Redact credentials and local filesystem locations from provider diagnostics kept in status. */
export function safeProviderDiagnostic(value: unknown, fallback: string, max = 2_000): string {
  const source = typeof value === "string" ? value : fallback;
  return source
    .replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[redacted]`)
    .replace(/\b(?:cookie|set-cookie)\s*[:=]\s*(?:[^;\s,]+(?:\s*;\s*[^;\s,]+)*)/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[redacted]`)
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[redacted]`)
    .replace(/(["'](?:authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)["']\s*:\s*)["'][^"']*["']/gi, "$1\"[redacted]\"")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/(^|[\s"'=])(?:\/(?:Users|home|private|var|tmp|etc)\/[^\s"']+|[A-Za-z]:[\\/][^\s"']+)/g, "$1[redacted-path]")
    .replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || fallback;
}

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

/**
 * Finish reasons we are willing to quote into user-visible status. The list is
 * deliberately closed: Runtime/provider text is never echoed, so only a token
 * validated against this vocabulary can reach `status`.
 */
const SURFACED_FINISH_REASONS = new Set([
  "stop", "length", "content_filter", "tool_calls", "function_call",
  "end_turn", "max_tokens", "stop_sequence", "tool_use", "refusal",
  "safety", "recitation", "blocklist", "prohibited_content", "spii", "malformed_function_call", "other",
  "error", "timeout", "rate_limit", "overloaded", "cancelled", "aborted",
]);

/**
 * Narrow, allow-listed extraction of a provider finish reason from Runtime text
 * (e.g. "Provider finish_reason: content_filter"). Returns the validated token
 * only — the surrounding payload never leaves this function, so a status line
 * can say why a reply was withheld without echoing raw Runtime data.
 */
export function providerFinishReason(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) return null;
  const match = /(?:finish[_-]?reason|rawstopreason)\s*[:=]\s*"?([A-Za-z_]{2,32})"?/i.exec(value);
  const token = match?.[1]?.toLowerCase() ?? "";
  return SURFACED_FINISH_REASONS.has(token) ? token : null;
}
