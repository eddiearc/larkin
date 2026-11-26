import { spawn } from "node:child_process";

type Env = Record<string, string | undefined>;

export interface AntigravityCatalogModel {
  id: string;
  label: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
}

export interface AntigravityModelCatalog {
  models: AntigravityCatalogModel[];
  effectiveModel: string;
}

export interface DiscoverAntigravityCatalogOptions {
  cwd?: string;
  env?: Env;
  command?: string;
  runModels?: (call: { command: string; cwd?: string; env: Env; timeout: number }) => Promise<string>;
}

const MODEL_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\s+-\s+|\s{2,}|\t+)(.+)$/;
const DEFAULT_MARK = /\s*\((?:default|current)\)\s*$/i;
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_SUFFIX = /^(.+)-(low|medium|high|xhigh|max)$/;
const EFFORT_LABEL_SUFFIX = /\s*\((?:Low|Medium|High|Extra|XHigh|Max)\)\s*$/i;
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 1024 * 1024;

async function runModels(call: { command: string; cwd?: string; env: Env; timeout: number }): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(call.command, ["models"], { ...(call.cwd ? { cwd: call.cwd } : {}), env: call.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(stdout);
    };
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(new Error("Antigravity model catalog timed out")); }, call.timeout);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish(new Error(`Antigravity model catalog command failed: ${error.message}`)));
    child.on("exit", (code) => {
      if (code === 0) return finish();
      const detail = (stderr || stdout).replace(/\u001b\[[0-9;]*m/g, "").replace(/\r/g, "\n").trim().slice(0, 500);
      finish(new Error(detail || `agy models exited with ${code}`));
    });
  });
}

interface RawEntry {
  id: string;
  label: string;
  isDefault: boolean;
  family: string | null;
  effort: string | null;
}

export function parseAntigravityModelList(output: string): AntigravityModelCatalog {
  const raw: RawEntry[] = [];
  const seen = new Set<string>();
  for (const line of output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n|\r/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = MODEL_LINE.exec(trimmed);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const isDefault = DEFAULT_MARK.test(match[2]);
    const label = match[2].replace(DEFAULT_MARK, "").trim() || id;
    const effortMatch = EFFORT_SUFFIX.exec(id);
    raw.push({
      id,
      label,
      isDefault,
      family: effortMatch ? effortMatch[1] : null,
      effort: effortMatch ? effortMatch[2] : null,
    });
  }
  if (!raw.length) throw new Error(`Antigravity returned no authenticated available models: ${output.trim().slice(0, 300)}`);

  const families = new Map<string, RawEntry[]>();
  for (const entry of raw) {
    if (!entry.family) continue;
    const list = families.get(entry.family) ?? [];
    list.push(entry);
    families.set(entry.family, list);
  }

  const emittedFamilies = new Set<string>();
  const models: AntigravityCatalogModel[] = [];
  let effectiveModel = "";

  for (const entry of raw) {
    const siblings = entry.family ? families.get(entry.family) : undefined;
    if (entry.family && siblings && siblings.length >= 2) {
      if (emittedFamilies.has(entry.family)) continue;
      emittedFamilies.add(entry.family);
      const levels = EFFORT_ORDER.filter((level) => siblings.some((sibling) => sibling.effort === level));
      const preferred = siblings.find((sibling) => sibling.isDefault)
        ?? siblings.find((sibling) => sibling.effort === "medium")
        ?? siblings[0];
      const baseLabel = preferred.label.replace(EFFORT_LABEL_SUFFIX, "").trim() || preferred.label;
      models.push({
        id: preferred.id,
        label: baseLabel,
        supportedReasoningEfforts: [...levels],
        ...(preferred.effort ? { defaultReasoningEffort: preferred.effort } : {}),
      });
      if (siblings.some((sibling) => sibling.isDefault) && !effectiveModel) effectiveModel = preferred.id;
      continue;
    }
    models.push({ id: entry.id, label: entry.label, supportedReasoningEfforts: [] });
    if (entry.isDefault && !effectiveModel) effectiveModel = entry.id;
  }

  return { models, effectiveModel: effectiveModel || models[0].id };
}

export async function discoverAntigravityModelCatalog(options: DiscoverAntigravityCatalogOptions = {}): Promise<AntigravityModelCatalog> {
  const env: Env = { ...process.env, ...options.env, NO_COLOR: "1" };
  const command = options.command || env.LARKIN_ANTIGRAVITY_COMMAND || "agy";
  const output = await (options.runModels ?? runModels)({ command, ...(options.cwd ? { cwd: options.cwd } : {}), env, timeout: TIMEOUT_MS });
  return parseAntigravityModelList(output);
}
