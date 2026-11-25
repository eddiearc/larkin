import { spawn } from "node:child_process";

type Env = Record<string, string | undefined>;

export interface CursorCatalogModel {
  id: string;
  label: string;
}

export interface CursorModelCatalog {
  models: CursorCatalogModel[];
  effectiveModel: string;
}

export interface DiscoverCursorCatalogOptions {
  cwd?: string;
  env?: Env;
  command?: string;
  runModels?: (call: { command: string; cwd?: string; env: Env; timeout: number }) => Promise<string>;
}

const MODEL_LINE = /^([A-Za-z0-9][A-Za-z0-9._\[\]=,-]{0,127}) - (.+)$/;
const DEFAULT_MARK = /\s*\((?:default|current)\)\s*$/i;
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 1024 * 1024;

async function runModels(call: { command: string; cwd?: string; env: Env; timeout: number }): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(call.command, ["models"], { ...(call.cwd ? { cwd: call.cwd } : {}), env: call.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output);
    };
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(new Error("Cursor model catalog timed out")); }, call.timeout);
    timer.unref?.();
    const capture = (chunk: Buffer) => { if (output.length < MAX_OUTPUT) output += chunk.toString("utf8"); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => finish(new Error(`Cursor model catalog command failed: ${error.message}`)));
    child.on("exit", (code) => finish(code === 0 ? undefined : new Error(output.trim().slice(0, 500) || `cursor-agent models exited with ${code}`)));
  });
}

export function parseCursorModelList(output: string): CursorModelCatalog {
  const models: CursorCatalogModel[] = [];
  let effectiveModel = "";
  for (const line of output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const match = MODEL_LINE.exec(line.trim());
    if (!match) continue;
    const isDefault = DEFAULT_MARK.test(match[2]);
    const label = match[2].replace(DEFAULT_MARK, "").trim();
    models.push({ id: match[1], label });
    if (isDefault && !effectiveModel) effectiveModel = match[1];
  }
  if (!models.length) throw new Error(`Cursor returned no authenticated available models: ${output.trim().slice(0, 300)}`);
  return { models, effectiveModel: effectiveModel || models[0].id };
}

export async function discoverCursorModelCatalog(options: DiscoverCursorCatalogOptions = {}): Promise<CursorModelCatalog> {
  const env: Env = { ...process.env, ...options.env, NO_COLOR: "1" };
  const command = options.command || env.LARKIN_CURSOR_COMMAND || "cursor-agent";
  const output = await (options.runModels ?? runModels)({ command, ...(options.cwd ? { cwd: options.cwd } : {}), env, timeout: TIMEOUT_MS });
  return parseCursorModelList(output);
}
