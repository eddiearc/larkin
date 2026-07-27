import { spawn } from "node:child_process";

type Env = Record<string, string | undefined>;
type JsonRecord = Record<string, unknown>;

export interface ClaudeCatalogModel {
  id: string;
  label: string;
  supportedReasoningEfforts: string[];
  verified: "claude-control-visible";
}

export interface ClaudeModelCatalog {
  models: ClaudeCatalogModel[];
  effectiveModel: string;
  defaultSupportedReasoningEfforts: string[];
}

type ClaudeControlCall = { command?: string; args: string[]; cwd?: string; env: Env; maxBuffer: number; request: JsonRecord; timeout: number };
export interface DiscoverClaudeCatalogOptions {
  cwd?: string;
  env?: Env;
  command?: string;
  runClaudeControl?: (call: ClaudeControlCall) => Promise<unknown>;
}

const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,127}$/;
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

function cleanText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\u0000-\u001f\u007f]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
}

async function runClaudeControl(call: ClaudeControlCall): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const child = spawn(call.command || "claude", call.args, { ...(call.cwd ? { cwd: call.cwd } : {}), env: call.env, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let stdout = "";
    let bytes = 0;
    const requestId = String(call.request.request_id);
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Claude model catalog timed out")), call.timeout);
    timer.unref?.();
    child.on("error", () => finish(new Error("Claude model catalog command failed")));
    child.on("exit", () => finish(new Error("Claude model catalog control channel exited before response")));
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > call.maxBuffer) return finish(new Error("Claude model catalog response exceeded limit"));
      stdout += chunk.toString("utf8");
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        try {
          const message = JSON.parse(line) as JsonRecord;
          const response = message.response as JsonRecord | undefined;
          if (message.type === "control_response" && response?.request_id === requestId) {
            if (response.subtype !== "success") return finish(new Error("Claude model catalog request failed"));
            return finish(undefined, response.response);
          }
        } catch { /* control channel is newline-delimited JSON; ignore unrelated messages */ }
      }
    });
    child.stdin.write(`${JSON.stringify(call.request)}\n`);
  });
}

function efforts(item: JsonRecord): string[] {
  if (item.supportsEffort !== true || !Array.isArray(item.supportedEffortLevels)) return [];
  return [...new Set(item.supportedEffortLevels.filter((level): level is string => typeof level === "string" && EFFORT_LEVELS.has(level)))];
}

function parseCatalog(value: unknown): ClaudeModelCatalog {
  const rows = (value as { models?: unknown } | null)?.models;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 128) throw new Error("Claude model catalog has an invalid model list");
  const defaultRow = rows.find((row) => (row as { value?: unknown } | null)?.value === "default") as JsonRecord | undefined;
  const effectiveModel = typeof defaultRow?.resolvedModel === "string" && SAFE_MODEL_ID.test(defaultRow.resolvedModel) ? defaultRow.resolvedModel : "";
  const seen = new Set<string>();
  const models = rows.flatMap((row): ClaudeCatalogModel[] => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const item = row as JsonRecord;
    const id = typeof item.value === "string" ? item.value : "";
    if (id === "default" || !SAFE_MODEL_ID.test(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label: cleanText(item.displayName, id), supportedReasoningEfforts: efforts(item), verified: "claude-control-visible" }];
  });
  if (!effectiveModel || !models.length) throw new Error("Claude model catalog has no visible local default");
  return { models, effectiveModel, defaultSupportedReasoningEfforts: efforts(defaultRow || {}) };
}

export async function discoverClaudeModelCatalog(options: DiscoverClaudeCatalogOptions = {}): Promise<ClaudeModelCatalog> {
  const execute = options.runClaudeControl ?? runClaudeControl;
  const request = { type: "control_request", request_id: "larkin-model-list", request: { subtype: "list_models" } };
  try {
    return parseCatalog(await execute({ args: ["--safe-mode", "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      ...(options.command ? { command: options.command } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}), env: { ...process.env, ...options.env, NO_COLOR: "1" },
      maxBuffer: 1024 * 1024, request, timeout: 15_000 }));
  } catch (error) {
    if (error instanceof Error && /Claude model catalog/.test(error.message)) throw error;
    throw new Error("Claude model catalog unavailable");
  }
}
