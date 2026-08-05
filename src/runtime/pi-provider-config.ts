import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type PiDistribution = "external" | "builtin";
export const BUNDLED_PI_VERSION = "0.83.0";
export type PiProviderPresetId = "deepseek" | "kimi" | "minimax" | "zhipu" | "custom";

export interface PiProviderPreset {
  id: Exclude<PiProviderPresetId, "custom">;
  name: string;
  provider: string;
  baseUrl: string;
  defaultModel: string;
  api: "openai-completions" | "anthropic-messages";
}

// These values mirror the catalog shipped by the pinned official Pi distribution.
// Keeping the user-facing defaults here makes endpoint changes reviewable in Larkin.
export const PI_PROVIDER_PRESETS: readonly PiProviderPreset[] = Object.freeze([
  { id: "deepseek", name: "DeepSeek（推荐）", provider: "deepseek", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-pro", api: "openai-completions" },
  { id: "kimi", name: "Kimi / Moonshot（中国）", provider: "moonshotai-cn", baseUrl: "https://api.moonshot.cn/v1", defaultModel: "kimi-k2.7-code", api: "openai-completions" },
  { id: "minimax", name: "MiniMax（中国）", provider: "minimax-cn", baseUrl: "https://api.minimaxi.com/anthropic", defaultModel: "MiniMax-M2.7", api: "anthropic-messages" },
  { id: "zhipu", name: "智谱 / BigModel", provider: "zai-coding-cn", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", defaultModel: "glm-5.2", api: "openai-completions" },
]);

export interface BuiltinPiProviderSetupSelection {
  distribution: "builtin";
  preset: PiProviderPresetId;
  model: string;
  baseUrl?: string;
}

export interface BuiltinPiProviderSelection extends BuiltinPiProviderSetupSelection {
  apiKey: string;
}

export interface ValidatedBuiltinPiProviderSelection extends BuiltinPiProviderSelection {
  provider: string;
  baseUrl: string;
  api: "openai-completions" | "anthropic-messages";
}

export interface ResolvedBuiltinPiProviderSetupSelection extends BuiltinPiProviderSetupSelection {
  provider: string;
  baseUrl: string;
  api: "openai-completions" | "anthropic-messages";
}

const APP_ID = /^cli_[A-Za-z0-9]+$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+\/-]{0,255}$/;

export function validatePiBaseUrl(raw: string): string {
  const input = raw.trim();
  if (!input || /[\0\r\n\t]/.test(input)) throw new Error("Base URL 不能为空或包含控制字符");
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error("Base URL 不是合法 URL"); }
  if (url.username || url.password) throw new Error("Base URL 不允许包含用户名或凭证");
  if (url.search || url.hash) throw new Error("Base URL 不允许 query 或 fragment");
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Base URL 必须使用 https；仅 localhost/loopback 开发端点允许 http");
  }
  if (/\/(?:chat\/completions|responses|models)\/?$/i.test(url.pathname)) {
    throw new Error("Base URL 应填写 API 根路径，不要包含 chat/completions、responses 或 models");
  }
  return url.toString().replace(/\/$/, "");
}

export function resolveBuiltinPiProviderSetupSelection(input: BuiltinPiProviderSetupSelection): ResolvedBuiltinPiProviderSetupSelection {
  if (input.distribution !== "builtin") throw new Error("provider 凭证只能用于内置 Pi");
  const model = input.model.trim();
  if (!MODEL_ID.test(model)) throw new Error("模型 ID 格式不安全");
  if (input.preset === "custom") {
    const provider = "larkin-custom";
    return {
      ...input,
      model: model.startsWith(`${provider}/`) ? model : `${provider}/${model}`,
      provider,
      baseUrl: validatePiBaseUrl(input.baseUrl || ""),
      api: "openai-completions",
    };
  }
  const preset = PI_PROVIDER_PRESETS.find((candidate) => candidate.id === input.preset);
  if (!preset) throw new Error(`未知 Pi provider preset: ${String(input.preset)}`);
  return { ...input, model: model.startsWith(`${preset.provider}/`) ? model : `${preset.provider}/${model}`,
    provider: preset.provider, baseUrl: preset.baseUrl, api: preset.api };
}

export function validateBuiltinPiProviderSelection(input: BuiltinPiProviderSelection): ValidatedBuiltinPiProviderSelection {
  const key = input.apiKey.trim();
  if (!key || key.length > 16_384 || /[\0\r\n]/.test(key)) throw new Error("API Key 不能为空或包含控制字符");
  return { ...resolveBuiltinPiProviderSetupSelection(input), apiKey: key };
}

export function piAgentDirectory(configDir: string, agentId: string): string {
  if (!APP_ID.test(agentId)) throw new Error("Pi Agent ID 格式无效");
  return path.join(path.resolve(configDir), "providers", "pi", agentId);
}

function assertPrivateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o777) !== 0o700) {
    throw new Error("Pi provider 凭证目录必须是当前用户拥有、非 symlink、权限精确 0700 的目录");
  }
}

export function assertBuiltinPiAgentDirectory(directory: string): void {
  assertPrivateDirectory(directory);
  const authFile = path.join(directory, "auth.json");
  const auth = readSnapshot(authFile);
  if (!auth) throw new Error("内置 Pi 尚未配置 API Key");
  try {
    const value = JSON.parse(auth.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) throw new Error("empty");
  } catch { throw new Error("内置 Pi auth.json 格式无效"); }
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(directory), 0o700);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  assertPrivateDirectory(directory);
}

function readSnapshot(file: string): Buffer | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())
        || (stat.mode & 0o777) !== 0o600) throw new Error(`Pi provider 文件不安全: ${path.basename(file)}`);
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function atomicPrivateWrite(file: string, content: string): void {
  const directory = path.dirname(file);
  assertPrivateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally { try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ } }
}

function restore(file: string, snapshot: Buffer | null): void {
  if (snapshot === null) {
    try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } else atomicPrivateWrite(file, snapshot.toString("utf8"));
}

export interface PiProviderTransaction {
  directory: string;
  commit(): void;
  rollback(): void;
}

export function configureBuiltinPiProviderModel(configDir: string, agentId: string,
  raw: BuiltinPiProviderSetupSelection): ResolvedBuiltinPiProviderSetupSelection {
  const selection = resolveBuiltinPiProviderSetupSelection(raw);
  const directory = piAgentDirectory(configDir, agentId);
  ensurePrivateDirectory(directory);
  if (selection.preset !== "custom") return selection;
  const modelsFile = path.join(directory, "models.json");
  const beforeModels = readSnapshot(modelsFile);
  const currentModels = beforeModels ? JSON.parse(beforeModels.toString("utf8")) as Record<string, unknown> : {};
  if (!currentModels || typeof currentModels !== "object" || Array.isArray(currentModels)) throw new Error("现有 Pi models.json 格式无效");
  const currentProviders = currentModels.providers === undefined ? {} : currentModels.providers;
  if (!currentProviders || typeof currentProviders !== "object" || Array.isArray(currentProviders)) throw new Error("现有 Pi models.json providers 格式无效");
  const modelId = selection.model.slice(`${selection.provider}/`.length);
  atomicPrivateWrite(modelsFile, `${JSON.stringify({
    ...currentModels,
    providers: {
      ...currentProviders as Record<string, unknown>,
      [selection.provider]: {
        baseUrl: selection.baseUrl,
        api: selection.api,
        models: [{
          id: modelId, name: modelId, reasoning: false, input: ["text"], contextWindow: 131_072, maxTokens: 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2)}\n`);
  return selection;
}

export function stageBuiltinPiProvider(configDir: string, agentId: string,
  raw: BuiltinPiProviderSelection): PiProviderTransaction {
  const selection = validateBuiltinPiProviderSelection(raw);
  const directory = piAgentDirectory(configDir, agentId);
  ensurePrivateDirectory(directory);
  const authFile = path.join(directory, "auth.json");
  const modelsFile = path.join(directory, "models.json");
  const beforeAuth = readSnapshot(authFile);
  const beforeModels = readSnapshot(modelsFile);
  const currentAuth = beforeAuth ? JSON.parse(beforeAuth.toString("utf8")) as Record<string, unknown> : {};
  if (!currentAuth || typeof currentAuth !== "object" || Array.isArray(currentAuth)) throw new Error("现有 Pi auth.json 格式无效");
  const auth = { ...currentAuth, [selection.provider]: { type: "api_key", key: selection.apiKey } };
  const currentModels = beforeModels ? JSON.parse(beforeModels.toString("utf8")) as Record<string, unknown> : {};
  if (!currentModels || typeof currentModels !== "object" || Array.isArray(currentModels)) throw new Error("现有 Pi models.json 格式无效");
  const currentProviders = currentModels.providers === undefined ? {} : currentModels.providers;
  if (!currentProviders || typeof currentProviders !== "object" || Array.isArray(currentProviders)) throw new Error("现有 Pi models.json providers 格式无效");
  const customModels = selection.preset === "custom" ? {
    ...currentModels,
    providers: {
      ...currentProviders as Record<string, unknown>,
      [selection.provider]: {
        baseUrl: selection.baseUrl,
        api: selection.api,
        models: [{
          id: selection.model.slice(`${selection.provider}/`.length),
          name: selection.model.slice(`${selection.provider}/`.length),
          reasoning: false,
          input: ["text"],
          contextWindow: 131_072,
          maxTokens: 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  } : null;
  let active = true;
  try {
    atomicPrivateWrite(authFile, `${JSON.stringify(auth, null, 2)}\n`);
    if (customModels) atomicPrivateWrite(modelsFile, `${JSON.stringify(customModels, null, 2)}\n`);
  } catch (error) {
    try { restore(authFile, beforeAuth); restore(modelsFile, beforeModels); } catch { /* original error remains primary */ }
    throw error;
  }
  return {
    directory,
    commit() { active = false; },
    rollback() {
      if (!active) return;
      restore(authFile, beforeAuth);
      restore(modelsFile, beforeModels);
      active = false;
    },
  };
}
