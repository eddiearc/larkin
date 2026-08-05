import path from "node:path";
import os from "node:os";
import { resolveConfigDir } from "./root-layout.js";

export interface TelemetryConfig {
  enabled: boolean;
  spoolDir: string;
  endpoint?: string;
  headers: Record<string, string>;
  maxBytes: number;
  maxFiles: number;
  maxAgeMs: number;
  uploadIntervalMs: number;
  requestTimeoutMs: number;
}

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function validateOtlpEndpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("OTLP endpoint must use http or https");
  if (url.username || url.password) throw new Error("OTLP endpoint must not contain userinfo");
  if (url.hash) throw new Error("OTLP endpoint must not contain a fragment");
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/v1/traces";
  return url.toString();
}

function parseHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const headers: Record<string, string> = {};
  for (const field of value.split(",")) {
    const separator = field.indexOf("=");
    if (separator <= 0) throw new Error("OTLP headers must use name=value pairs");
    const name = field.slice(0, separator).trim();
    const headerValue = decodeURIComponent(field.slice(separator + 1).trim());
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(headerValue)) {
      throw new Error("OTLP header is invalid");
    }
    headers[name] = headerValue;
  }
  return headers;
}

export function loadTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const home = env.LARKIN_HOME || resolveConfigDir(env, os.homedir());
  const endpointValue = env.LARKIN_TELEMETRY_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  return {
    enabled: env.LARKIN_TELEMETRY_ENABLED === "1",
    spoolDir: path.resolve(env.LARKIN_TELEMETRY_SPOOL_DIR || path.join(home, "telemetry", "spool")),
    ...(endpointValue ? { endpoint: validateOtlpEndpoint(endpointValue) } : {}),
    headers: parseHeaders(env.LARKIN_TELEMETRY_OTLP_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS),
    maxBytes: positiveInteger(env.LARKIN_TELEMETRY_MAX_BYTES, 64 * 1024 * 1024),
    maxFiles: positiveInteger(env.LARKIN_TELEMETRY_MAX_FILES, 10_000),
    maxAgeMs: positiveInteger(env.LARKIN_TELEMETRY_MAX_AGE_MS, 14 * 24 * 60 * 60 * 1000),
    uploadIntervalMs: positiveInteger(env.LARKIN_TELEMETRY_UPLOAD_INTERVAL_MS, 10_000),
    requestTimeoutMs: positiveInteger(env.LARKIN_TELEMETRY_REQUEST_TIMEOUT_MS, 10_000),
  };
}

export function safeEndpointLabel(endpoint?: string): string | null {
  if (!endpoint) return null;
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}
