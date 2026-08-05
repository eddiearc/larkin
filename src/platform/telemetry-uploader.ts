import type { TelemetryConfig } from "./telemetry-config.js";
import { TelemetrySpool, type OtlpPayload } from "./telemetry-spool.js";

export type UploadResult = { uploadedFiles: number; status: "empty" | "uploaded" | "retained" | "dropped"; errorCategory?: string; droppedSpans?: number };

class ProtocolResponseError extends Error {}
async function boundedResponseJson(response: Response, maxBytes = 64 * 1024): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ProtocolResponseError("OTLP response too large");
  if (!response.body) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ProtocolResponseError("OTLP response too large"); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  if (!size) return null;
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try { return JSON.parse(text); } catch { throw new ProtocolResponseError("invalid OTLP response"); }
}

export async function flushTelemetry(spool: TelemetrySpool, options: {
  endpoint: string; headers?: Record<string, string>; timeoutMs?: number; batchFiles?: number;
  fetchImpl?: typeof fetch;
}): Promise<UploadResult> {
  let release: (() => void) | null = null;
  try { release = spool.acquireLease(); }
  catch { return { uploadedFiles: 0, status: "retained", errorCategory: "spool" }; }
  if (!release) return { uploadedFiles: 0, status: "retained", errorCategory: "busy" };
  const safeDiagnostic = (lastErrorCategory: string | null, lastUploadAt?: string): void => {
    try { spool.updateDiagnostics({ lastErrorCategory, ...(lastUploadAt ? { lastUploadAt } : {}) }); } catch { /* isolated */ }
  };
  let records;
  try { records = spool.list(options.batchFiles ?? 128, true); }
  catch { safeDiagnostic("spool"); release(); return { uploadedFiles: 0, status: "retained", errorCategory: "spool" }; }
  if (!records.length) { release(); return { uploadedFiles: 0, status: "empty" }; }
  const payload: OtlpPayload = { resourceSpans: records.flatMap((record) => record.payload.resourceSpans) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000); timer.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(options.endpoint, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      body: JSON.stringify(payload),
    });
    if (response.status !== 200) {
      const category = response.status === 429 ? "rate_limit" : response.status >= 500 ? "server" : response.ok ? "protocol" : "configuration";
      safeDiagnostic(category);
      return { uploadedFiles: 0, status: "retained", errorCategory: category };
    }
    const body = await boundedResponseJson(response);
    if (body !== null && (typeof body !== "object" || Array.isArray(body))) throw new ProtocolResponseError("invalid OTLP response");
    const partial = (body as { partialSuccess?: unknown } | null)?.partialSuccess;
    if (partial !== undefined && (!partial || typeof partial !== "object" || Array.isArray(partial))) throw new ProtocolResponseError("invalid OTLP partial success");
    const partialValue = partial as { rejectedSpans?: unknown; errorMessage?: unknown } | undefined;
    const rejected = Number(partialValue?.rejectedSpans ?? 0); const errorMessage = partialValue?.errorMessage ?? "";
    if (!Number.isSafeInteger(rejected) || rejected < 0 || typeof errorMessage !== "string") throw new ProtocolResponseError("invalid OTLP partial success");
    if (partialValue && rejected > 0) {
      const spanCount = payload.resourceSpans.flatMap((resource) => (resource as { scopeSpans?: Array<{ spans?: unknown[] }> }).scopeSpans ?? [])
        .reduce((sum, scope) => sum + (scope.spans?.length ?? 0), 0);
      const droppedSpans = Math.max(1, Math.min(spanCount, rejected || 1));
      spool.acknowledge(records);
      try { spool.updateDiagnostics({ droppedSpans: spool.status().droppedSpans + droppedSpans,
        lastUploadAt: new Date().toISOString(), lastErrorCategory: "partial_success" }); } catch { /* isolated */ }
      return { uploadedFiles: 0, status: "dropped", errorCategory: "partial_success", droppedSpans };
    }
    spool.acknowledge(records);
    safeDiagnostic(null, new Date().toISOString());
    return { uploadedFiles: records.length, status: "uploaded" };
  } catch (error) {
    const category = (error as Error).name === "AbortError" ? "timeout" : error instanceof ProtocolResponseError ? "protocol" : error instanceof TypeError ? "network" : "spool";
    safeDiagnostic(category);
    return { uploadedFiles: 0, status: "retained", errorCategory: category };
  } finally { clearTimeout(timer); release(); }
}

export function startTelemetryUploader(spool: TelemetrySpool, config: TelemetryConfig): { stop(): void; flush(): Promise<UploadResult> } | null {
  if (!config.enabled || !config.endpoint) return null;
  let stopped = false; let timer: NodeJS.Timeout | null = null; let failures = 0; let active: Promise<UploadResult> | null = null;
  const flush = (): Promise<UploadResult> => {
    if (active) return active;
    active = flushTelemetry(spool, { endpoint: config.endpoint!, headers: config.headers, timeoutMs: config.requestTimeoutMs })
      .then((result) => { failures = result.status === "retained" ? failures + 1 : 0; return result; })
      .catch(() => ({ uploadedFiles: 0, status: "retained" as const, errorCategory: "internal" }))
      .finally(() => { active = null; schedule(); });
    return active;
  };
  const schedule = (): void => {
    if (stopped || timer) return;
    const exponential = Math.min(6, failures);
    const jitter = 0.8 + Math.random() * 0.4;
    timer = setTimeout(() => { timer = null; void flush().catch(() => {}); }, Math.round(config.uploadIntervalMs * 2 ** exponential * jitter));
    timer.unref?.();
  };
  schedule();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; }, flush };
}
