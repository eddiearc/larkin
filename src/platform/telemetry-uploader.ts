import type { TelemetryConfig } from "./telemetry-config.js";
import { TelemetrySpool, type OtlpPayload } from "./telemetry-spool.js";

export type UploadResult = { uploadedFiles: number; status: "empty" | "uploaded" | "retained"; errorCategory?: string };

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
  try { records = spool.list(options.batchFiles ?? 128); }
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
    if (!response.ok) {
      const category = response.status === 429 ? "rate_limit" : response.status >= 500 ? "server" : "configuration";
      safeDiagnostic(category);
      return { uploadedFiles: 0, status: "retained", errorCategory: category };
    }
    let body: unknown = null;
    try { body = await response.json(); } catch { /* an empty success body is valid */ }
    const partial = body && typeof body === "object" ? (body as { partialSuccess?: { rejectedSpans?: unknown } }).partialSuccess : undefined;
    if (Number(partial?.rejectedSpans ?? 0) > 0) {
      safeDiagnostic("partial_success");
      return { uploadedFiles: 0, status: "retained", errorCategory: "partial_success" };
    }
    spool.acknowledge(records);
    safeDiagnostic(null, new Date().toISOString());
    return { uploadedFiles: records.length, status: "uploaded" };
  } catch (error) {
    const category = (error as Error).name === "AbortError" ? "timeout" : error instanceof TypeError ? "network" : "spool";
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
