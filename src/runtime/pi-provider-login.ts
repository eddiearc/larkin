import {
  PI_PROVIDER_PRESETS,
  configureBuiltinPiProviderModel,
  validateBuiltinPiProviderSelection,
  type PiProviderPresetId,
  type ValidatedBuiltinPiProviderSelection,
} from "./pi-provider-config.js";
import {
  beginBuiltinPiCredentialTransaction,
  createOfficialPiAuthInteraction,
  createOfficialPiLogoutRuntime,
  createOfficialPiModelRuntime,
  logoutOfficialPiProvider,
  runOfficialPiLogin,
  type OfficialPiAuthRuntime,
  type PiAuthQuestioner,
} from "./pi-official-auth.js";
import {
  loadConfig,
  markConfigApplied,
  mutateConfig,
  runtimeConfigSignature,
  type ConfigMutationResult,
} from "../platform/config.js";
import { requestAgentUpsert, type AgentUpsertResponse } from "../app/local-control.js";
import { readProcessState } from "../platform/process-state.js";
import type { AuthInteraction } from "@earendil-works/pi-ai";

const APP_ID = /^cli_[A-Za-z0-9]+$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRESET_IDS = new Set<string>([...PI_PROVIDER_PRESETS.map((preset) => preset.id), "custom"]);

export type BuiltinPiProviderApplyState = "applied" | "saved_not_applied" | "pending";

export interface BuiltinPiProviderCatalogEntry {
  id: string;
  name: string;
  provider: string | null;
  defaultModel: string | null;
  custom: boolean;
  openaiCompatible: boolean;
}

export interface BuiltinPiProviderLoginInput {
  agentId: string;
  preset: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface BuiltinPiProviderLoginResult {
  agentId: string;
  provider: string;
  preset: string;
  model: string;
  credentialType: "api_key";
  applyState: BuiltinPiProviderApplyState;
  applyError?: string;
}

export interface ConfigureBuiltinPiProviderDeps {
  loadConfig?: typeof loadConfig;
  beginTransaction?: typeof beginBuiltinPiCredentialTransaction;
  configureModel?: typeof configureBuiltinPiProviderModel;
  createRuntime?: typeof createOfficialPiModelRuntime;
  runLogin?: typeof runOfficialPiLogin;
  createInteraction?: typeof createApiKeyOnlyInteraction;
  mutateConfig?: typeof mutateConfig;
  readProcessState?: typeof readProcessState;
  requestUpsert?: typeof requestAgentUpsert;
  markApplied?: typeof markConfigApplied;
}

export interface LogoutBuiltinPiProviderDeps {
  loadConfig?: typeof loadConfig;
  beginTransaction?: typeof beginBuiltinPiCredentialTransaction;
  createLogoutRuntime?: typeof createOfficialPiLogoutRuntime;
  logout?: typeof logoutOfficialPiProvider;
}

/** 用户可见 catalog：已知 preset + 自定义 OpenAI 兼容端点，不含 Base URL / secret。 */
export function listBuiltinPiProviderCatalog(): BuiltinPiProviderCatalogEntry[] {
  return [
    ...PI_PROVIDER_PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      provider: preset.provider,
      defaultModel: `${preset.provider}/${preset.defaultModel}`,
      custom: false,
      openaiCompatible: preset.api === "openai-completions",
    })),
    {
      id: "custom",
      name: "Custom OpenAI-compatible",
      provider: "larkin-custom",
      defaultModel: null,
      custom: true,
      openaiCompatible: true,
    },
  ];
}

export function sanitizeProviderLoginError(error: unknown, secret?: string): string {
  let text = error instanceof Error ? error.message : String(error);
  if (secret) {
    let from = 0;
    while (from < text.length) {
      const at = text.indexOf(secret, from);
      if (at < 0) break;
      text = `${text.slice(0, at)}[redacted]${text.slice(at + secret.length)}`;
      from = at + 10;
    }
  }
  return text
    .replace(/\b(?:authorization|proxy-authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password)\s*[:=]\s*\S+/gi,
      (match) => `${match.split(/[:=]/, 1)[0]}=[redacted]`)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return "(url)";
      }
    })
    .replace(/[\0\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "builtin Pi provider configuration failed";
}

export function resolveBuiltinPiLoginSelection(input: {
  preset: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}): ValidatedBuiltinPiProviderSelection {
  if (!PRESET_IDS.has(input.preset)) throw new Error(`未知 Pi provider preset: ${input.preset}`);
  const preset = input.preset as PiProviderPresetId;
  if (preset === "custom") {
    if (!input.baseUrl?.trim()) throw new Error("custom OpenAI-compatible endpoint 需要 Base URL");
    if (!input.model?.trim()) throw new Error("custom OpenAI-compatible endpoint 需要 model");
    return validateBuiltinPiProviderSelection({
      distribution: "builtin",
      preset,
      apiKey: input.apiKey,
      model: input.model,
      baseUrl: input.baseUrl,
    });
  }
  if (input.baseUrl?.trim()) throw new Error("已知 provider 不接受 --base-url；自定义端点请使用 custom");
  const known = PI_PROVIDER_PRESETS.find((candidate) => candidate.id === preset);
  if (!known) throw new Error(`未知 Pi provider preset: ${input.preset}`);
  return validateBuiltinPiProviderSelection({
    distribution: "builtin",
    preset,
    apiKey: input.apiKey,
    model: input.model?.trim() || known.defaultModel,
  });
}

export function createApiKeyOnlyInteraction(
  apiKey: string,
  options: { report?: (message: string) => void; signal?: AbortSignal } = {},
): AuthInteraction {
  const questioner: PiAuthQuestioner = {
    ask: async () => {
      throw new Error("API-key login does not accept interactive text prompts");
    },
    secret: async () => apiKey,
  };
  return createOfficialPiAuthInteraction({
    questioner,
    report: options.report ?? (() => {}),
    signal: options.signal,
  });
}

function assertTargetBuiltinPi(
  env: NodeJS.ProcessEnv,
  agentId: string,
  load: typeof loadConfig,
): { configDir: string } {
  if (!APP_ID.test(agentId)) throw new Error("请用 --agent <App ID> 选择 Agent");
  const loaded = load(env);
  const agent = loaded.config.agents[agentId];
  if (!agent) throw new Error(`Agent ${agentId} 不存在`);
  if (agent.runtime !== "pi" || agent.piDistribution !== "builtin") {
    throw new Error(`Agent ${agentId} 不是内置 Pi`);
  }
  return { configDir: loaded.configDir };
}

async function applyTargetModel(
  env: NodeJS.ProcessEnv,
  agentId: string,
  model: string,
  mutate: typeof mutateConfig,
  inspect: typeof readProcessState,
  upsert: typeof requestAgentUpsert,
  markApplied: typeof markConfigApplied,
  secret?: string,
): Promise<{ applyState: BuiltinPiProviderApplyState; applyError?: string }> {
  let mutated: ConfigMutationResult;
  try {
    mutated = mutate(env, { kind: "set-agent-model", agentId, model, requireBuiltinPi: true }, { kind: "user" });
  } catch (error) {
    throw new Error(sanitizeProviderLoginError(error, secret));
  }
  const stillBuiltin = mutated.config.agents[agentId]?.runtime === "pi"
    && mutated.config.agents[agentId]?.piDistribution === "builtin";
  if (!stillBuiltin) {
    return { applyState: "pending", applyError: sanitizeProviderLoginError(new Error(`Agent ${agentId} 不是内置 Pi`), secret) };
  }
  const expectedSignature = runtimeConfigSignature(mutated.config, agentId);
  const state = inspect(mutated.config.larkinHome);
  if (state.daemon.state !== "owned" || state.supervisor.state !== "owned") {
    return { applyState: "saved_not_applied" };
  }
  try {
    const result: AgentUpsertResponse = await upsert({
      larkinHome: mutated.config.larkinHome,
      agentId,
      expectedSignature,
    });
    if (!result.ok) {
      return {
        applyState: "pending",
        applyError: sanitizeProviderLoginError(result.error || "targeted apply failed", secret),
      };
    }
    markApplied(env, agentId, expectedSignature);
    return { applyState: "applied" };
  } catch (error) {
    return { applyState: "pending", applyError: sanitizeProviderLoginError(error, secret) };
  }
}

/**
 * 为已有 builtin Pi Agent 配置已知 preset 或自定义 OpenAI 兼容端点。
 * 凭证事务覆盖 auth.json / models.json / models-store.json；模型写入走独立 CAS。
 * 不读取 host ~/.pi，也不验证真实 provider。
 */
export async function configureBuiltinPiProvider(
  input: BuiltinPiProviderLoginInput,
  deps: ConfigureBuiltinPiProviderDeps = {},
): Promise<BuiltinPiProviderLoginResult> {
  const env = input.env ?? process.env;
  const load = deps.loadConfig ?? loadConfig;
  const beginTransaction = deps.beginTransaction ?? beginBuiltinPiCredentialTransaction;
  const configureModel = deps.configureModel ?? configureBuiltinPiProviderModel;
  const createRuntime = deps.createRuntime ?? createOfficialPiModelRuntime;
  const runLogin = deps.runLogin ?? runOfficialPiLogin;
  const createInteraction = deps.createInteraction ?? createApiKeyOnlyInteraction;
  const mutate = deps.mutateConfig ?? mutateConfig;
  const inspect = deps.readProcessState ?? readProcessState;
  const upsert = deps.requestUpsert ?? requestAgentUpsert;
  const markApplied = deps.markApplied ?? markConfigApplied;

  let selection: ValidatedBuiltinPiProviderSelection;
  try {
    selection = resolveBuiltinPiLoginSelection({
      preset: input.preset,
      apiKey: input.apiKey,
      model: input.model,
      baseUrl: input.baseUrl,
    });
  } catch (error) {
    throw new Error(sanitizeProviderLoginError(error, input.apiKey));
  }

  const { configDir } = assertTargetBuiltinPi(env, input.agentId, load);
  const transaction = beginTransaction(configDir, input.agentId);
  try {
    if (selection.preset === "custom") {
      configureModel(configDir, input.agentId, {
        distribution: "builtin",
        preset: "custom",
        model: selection.model,
        baseUrl: selection.baseUrl,
      });
    }
    const runtime = await createRuntime(configDir, input.agentId);
    await runLogin(
      runtime as Pick<OfficialPiAuthRuntime, "login">,
      selection.provider,
      "api_key",
      createInteraction(selection.apiKey),
    );
    const applied = await applyTargetModel(
      env, input.agentId, selection.model, mutate, inspect, upsert, markApplied, input.apiKey,
    );
    transaction.commit();
    return {
      agentId: input.agentId,
      provider: selection.provider,
      preset: selection.preset,
      model: selection.model,
      credentialType: "api_key",
      applyState: applied.applyState,
      ...(applied.applyError ? { applyError: applied.applyError } : {}),
    };
  } catch (error) {
    try { transaction.rollback(); } catch { /* 原始错误优先 */ }
    throw new Error(sanitizeProviderLoginError(error, input.apiKey));
  }
}

export async function logoutBuiltinPiProvider(
  input: { agentId: string; providerId: string; env?: NodeJS.ProcessEnv },
  deps: LogoutBuiltinPiProviderDeps = {},
): Promise<{ agentId: string; provider: string }> {
  const env = input.env ?? process.env;
  const load = deps.loadConfig ?? loadConfig;
  if (!PROVIDER_ID.test(input.providerId)) throw new Error("logout 需要安全的 provider ID");
  const { configDir } = assertTargetBuiltinPi(env, input.agentId, load);
  const beginTransaction = deps.beginTransaction ?? beginBuiltinPiCredentialTransaction;
  const createLogoutRuntime = deps.createLogoutRuntime ?? createOfficialPiLogoutRuntime;
  const logout = deps.logout ?? logoutOfficialPiProvider;
  const transaction = beginTransaction(configDir, input.agentId);
  try {
    const runtime = await createLogoutRuntime(configDir, input.agentId);
    await logout(runtime, input.providerId);
    transaction.commit();
    return { agentId: input.agentId, provider: input.providerId };
  } catch (error) {
    try { transaction.rollback(); } catch { /* 原始错误优先 */ }
    throw new Error(sanitizeProviderLoginError(error));
  }
}
