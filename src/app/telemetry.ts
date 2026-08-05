#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { loadTelemetryConfig, safeEndpointLabel, validateOtlpEndpoint } from "../platform/telemetry-config.js";
import { TelemetrySpool } from "../platform/telemetry-spool.js";
import { flushTelemetry } from "../platform/telemetry-uploader.js";

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
function headers(argv: readonly string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--header") continue;
    const value = argv[++index]; const separator = value?.indexOf("=") ?? -1;
    if (!value || separator <= 0 || /[\r\n]/.test(value)) throw new Error("--header must use name=value");
    output[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return output;
}
const print = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };

export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [operation = "status"] = argv;
  const config = loadTelemetryConfig(env);
  const spool = new TelemetrySpool(config);
  if (operation === "status") {
    print({ enabled: config.enabled, endpoint: safeEndpointLabel(config.endpoint), autoUpload: Boolean(config.enabled && config.endpoint), ...spool.status() });
    return;
  }
  if (operation === "export") {
    const destination = path.resolve(option(argv, "--output") || `larkin-telemetry-${Date.now()}.json.gz`);
    const result = spool.exportBundle(destination);
    print({ operation, output: destination, ...result, sourceQueueRetained: true }); return;
  }
  if (operation === "import") {
    const source = option(argv, "--input") || argv[1];
    if (!source) throw new Error("telemetry import requires --input <bundle>");
    print({ operation, ...spool.importBundle(path.resolve(source)) }); return;
  }
  if (operation === "flush") {
    const endpoint = option(argv, "--endpoint") ? validateOtlpEndpoint(option(argv, "--endpoint")!) : config.endpoint;
    if (!endpoint) throw new Error("telemetry flush requires --endpoint or LARKIN_TELEMETRY_OTLP_ENDPOINT");
    const result = await flushTelemetry(spool, { endpoint, headers: { ...config.headers, ...headers(argv) }, timeoutMs: config.requestTimeoutMs });
    print({ operation, endpoint: safeEndpointLabel(endpoint), ...result, ...spool.status() });
    if (result.status === "retained") process.exitCode = 1;
    return;
  }
  if (operation === "help" || operation === "--help" || operation === "-h") {
    process.stdout.write(`Usage:
  larkin telemetry status
  larkin telemetry export --output <bundle.json.gz>
  larkin telemetry import --input <bundle.json.gz>
  larkin telemetry flush [--endpoint <http(s)://host:port/v1/traces>] [--header name=value]\n`); return;
  }
  throw new Error(`unknown telemetry operation: ${operation}`);
}

if (path.resolve(process.argv[1] || "") === path.resolve(import.meta.filename)) {
  main().catch((error) => { process.stderr.write(`larkin telemetry: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
