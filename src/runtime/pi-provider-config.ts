import path from "node:path";

/** Slice (a) stub: builtin Pi was removed. Slice (b)/(c) will delete the remaining callers. */
const removed = (): never => {
  throw new Error("builtin Pi was removed; install and log in with the external `pi` CLI");
};

export type PiDistribution = "external" | "builtin";
export const BUNDLED_PI_VERSION = "0.84.2";
export const MAX_BUILTIN_PI_API_KEY_LENGTH = 16_384;
export type PiProviderPresetId = "deepseek" | "kimi" | "minimax" | "zhipu" | "openai" | "anthropic"
  | "gemini" | "groq" | "cerebras" | "xai" | "fireworks" | "together" | "mistral"
  | "openrouter" | "kimi-coding" | "qwen-cn" | "opencode-go" | "ant-ling" | "nvidia"
  | "huggingface" | "minimax-global" | "moonshotai" | "opencode" | "qwen-token-plan"
  | "vercel-ai-gateway" | "xiaomi" | "xiaomi-token-plan-cn" | "xiaomi-token-plan-ams"
  | "xiaomi-token-plan-sgp" | "zai" | "custom";

export interface PiProviderPreset {
  id: Exclude<PiProviderPresetId, "custom">;
  name: string;
  provider: string;
  baseUrl: string;
  defaultModel: string;
  api: "openai-completions" | "anthropic-messages";
}

export const PI_PROVIDER_PRESETS: readonly PiProviderPreset[] = Object.freeze([]);

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

export interface PiProviderTransaction {
  directory: string;
  commit(): void;
  rollback(): void;
}

export function piDistributionLabel(_distribution: "builtin" | "external" | null | undefined): string {
  return "external";
}

export function isPiLoopbackHostname(_hostname: string): boolean { return removed(); }
export function presetIdForOfficialProvider(_providerId: string): string | null { return removed(); }
export function builtinPiProviderRecoveryNextAction(_options?: { agentId?: string; providerId?: string }): string {
  return "Run the official `pi` login flow, then retry.";
}
export function validatePiBaseUrl(_raw: string): string { return removed(); }
export async function listProviderModels(_baseUrl: string, _apiKey: string, _fetchImpl?: typeof fetch): Promise<string[] | null> {
  return removed();
}
export function resolveBuiltinPiProviderSetupSelection(_input: BuiltinPiProviderSetupSelection): ResolvedBuiltinPiProviderSetupSelection {
  return removed();
}
export function validateBuiltinPiProviderSelection(_input: BuiltinPiProviderSelection): ValidatedBuiltinPiProviderSelection {
  return removed();
}

export function piAgentDirectory(configDir: string, agentId: string): string {
  return path.join(path.resolve(configDir), "providers", "pi", agentId);
}

export function ownedPiCatalogAgentDir(configDir: string, agentId: string): string {
  return piAgentDirectory(configDir, agentId);
}

export function piCatalogCommandSpec(
  _distribution: "builtin" | "external" | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; commandArgs: readonly string[] } {
  return { command: env.LARKIN_PI_COMMAND ?? process.env.LARKIN_PI_COMMAND ?? "pi", commandArgs: [] };
}

export function assertBuiltinPiAgentDirectory(_directory: string): void { removed(); }
export function configureBuiltinPiProviderModel(_configDir: string, _agentId: string, _raw: BuiltinPiProviderSetupSelection): ResolvedBuiltinPiProviderSetupSelection {
  return removed();
}
export function stageBuiltinPiProvider(_configDir: string, _agentId: string, _raw: BuiltinPiProviderSelection): PiProviderTransaction {
  return removed();
}
