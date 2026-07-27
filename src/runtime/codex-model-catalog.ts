import { spawn } from "node:child_process";

type Env = Record<string, string | undefined>;
type JsonRecord = Record<string, unknown>;

export interface CodexCatalogModel {
  id: string;
  label: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
  verified: "codex-cli-visible";
}

export interface CodexModelCatalog {
  models: CodexCatalogModel[];
  effectiveModel: string;
}

type CodexCall = {
  command?: string;
  args: string[];
  cwd?: string;
  env: Env;
  maxBuffer: number;
  request: { id: string; method: "model/list"; params: { limit: number; includeHidden: false } };
  timeout: number;
};

export interface DiscoverCodexCatalogOptions {
  cwd?: string;
  env?: Env;
  command?: string;
  runCodexAppServer?: (call: CodexCall) => Promise<unknown>;
}

const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REASONING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function cleanLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\u0000-\u001f\u007f]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
}

async function runCodexAppServer(call: CodexCall): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const child = spawn(call.command || "codex", call.args, {
      ...(call.cwd ? { cwd: call.cwd } : {}), env: call.env, stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let bytes = 0;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Codex model catalog timed out")), call.timeout);
    timer.unref?.();
    child.on("error", () => finish(new Error("Codex model catalog command failed")));
    child.on("exit", () => finish(new Error("Codex model catalog app-server exited before response")));
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > call.maxBuffer) return finish(new Error("Codex model catalog response exceeded limit"));
      stdout += chunk.toString("utf8");
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        try {
          const message = JSON.parse(line) as JsonRecord;
          if (message.id === call.request.id) {
            if (message.error) return finish(new Error("Codex model catalog request failed"));
            return finish(undefined, message.result);
          }
        } catch { /* app-server protocol is newline-delimited JSON; ignore non-response noise */ }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: "larkin-initialize", method: "initialize", params: { clientInfo: { name: "larkin", title: "Larkin", version: "0" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify(call.request)}\n`);
  });
}

function parseCatalog(value: unknown): CodexModelCatalog {
  const rows = (value as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 512) throw new Error("Codex model catalog has an invalid model list");
  const seen = new Set<string>();
  let effectiveModel = "";
  const models = rows.flatMap((row): CodexCatalogModel[] => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const item = row as JsonRecord;
    const id = typeof item.id === "string" ? item.id : "";
    if (item.hidden === true || !SAFE_MODEL_ID.test(id) || seen.has(id)) return [];
    seen.add(id);
    if (item.isDefault === true) effectiveModel = typeof item.model === "string" && SAFE_MODEL_ID.test(item.model) ? item.model : id;
    const levels = Array.isArray(item.supportedReasoningEfforts)
      ? [...new Set(item.supportedReasoningEfforts.flatMap((level) => {
        const effort = (level as { reasoningEffort?: unknown; effort?: unknown } | null)?.reasoningEffort
          ?? (level as { effort?: unknown } | null)?.effort;
        return typeof effort === "string" && REASONING_LEVELS.has(effort) ? [effort] : [];
      }))]
      : [];
    const defaultReasoningEffort = typeof item.defaultReasoningEffort === "string" && levels.includes(item.defaultReasoningEffort)
      ? item.defaultReasoningEffort : undefined;
    return [{ id, label: cleanLabel(item.displayName, id), supportedReasoningEfforts: levels,
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}), verified: "codex-cli-visible" }];
  });
  if (!models.length || !effectiveModel) throw new Error("Codex model catalog has no visible local default");
  return { models, effectiveModel };
}

export async function discoverCodexModelCatalog(options: DiscoverCodexCatalogOptions = {}): Promise<CodexModelCatalog> {
  const execute = options.runCodexAppServer ?? runCodexAppServer;
  const request = { id: "larkin-model-list", method: "model/list" as const, params: { limit: 100, includeHidden: false as const } };
  try {
    return parseCatalog(await execute({ args: ["app-server", "--stdio"], ...(options.command ? { command: options.command } : {}), ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.env, NO_COLOR: "1" }, maxBuffer: 1024 * 1024, request, timeout: 15_000 }));
  } catch (error) {
    if (error instanceof Error && /Codex model catalog/.test(error.message)) throw error;
    throw new Error("Codex model catalog unavailable");
  }
}
