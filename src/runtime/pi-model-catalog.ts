import { spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import { PiRpcClient, type PiRpcProcess } from "./pi-rpc-client.js";
import { classifyRuntimePrerequisite, RuntimePrerequisiteError } from "./runtime-readiness.js";

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = typeof PI_THINKING_LEVELS[number];

interface PiModelLike {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, unknown>>;
}

export interface PiCatalogModel {
  id: string;
  label: string;
  contextWindow?: number;
  supportedReasoningEfforts: PiThinkingLevel[];
  defaultReasoningEffort?: PiThinkingLevel;
  verified: "launchable";
}

export interface PiModelCatalog {
  models: PiCatalogModel[];
  effectiveModel: string | null;
  effectiveThinkingLevel: PiThinkingLevel;
  defaultSource: "settings" | "official-fallback" | "unavailable";
  diagnostics: string[];
}

export interface DiscoverPiCatalogOptions {
  cwd: string;
  agentDir?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: readonly string[], options: Record<string, unknown>) => PiRpcProcess;
  timeoutMs?: number;
}

export function piModelId(model: PiModelLike): string { return `${model.provider}/${model.id}`; }

export function supportedPiThinkingLevels(model: PiModelLike): PiThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level !== "xhigh" && level !== "max" ? true : mapped !== undefined;
  });
}

export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
  return typeof value === "string" && (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

export function findExactPiModel<T extends PiModelLike>(reference: string, models: readonly T[]): T | undefined {
  if (!reference || reference === "default" || !reference.includes("/")) return undefined;
  return models.find((model) => piModelId(model) === reference);
}

/** Discover only through Pi's structured RPC protocol; no table parsing or static fallback. */
export async function discoverPiModelCatalog(options: DiscoverPiCatalogOptions): Promise<PiModelCatalog> {
  const spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions as any) as unknown as PiRpcProcess);
  const command = options.command ?? options.env?.LARKIN_PI_COMMAND ?? process.env.LARKIN_PI_COMMAND ?? "pi";
  const child = spawn(command, ["--mode", "rpc", "--no-session"], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, ...(options.agentDir ? { PI_CODING_AGENT_DIR: path.resolve(options.agentDir) } : {}), NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new PiRpcClient(child, { requestTimeoutMs: options.timeoutMs ?? 10_000 });
  try {
    const [availableResponse, state] = await Promise.all([
      client.request<{ models?: PiModelLike[] }>("get_available_models"),
      client.request<{ model?: PiModelLike | null; thinkingLevel?: string }>("get_state"),
    ]);
    const available = [...(availableResponse?.models ?? [])].sort((left, right) => piModelId(left).localeCompare(piModelId(right)));
    if (!available.length) throw new Error("Pi has no authenticated available models. Run the official `pi` login flow or configure provider credentials; Larkin will not create a fallback session.");
    const effectiveModel = state.model ? piModelId(state.model) : null;
    if (!effectiveModel || !available.some((model) => piModelId(model) === effectiveModel)) {
      throw new Error(`Pi official default resolution returned an unavailable model (${effectiveModel || "none"}); refusing implicit fallback`);
    }
    const effectiveThinkingLevel = isPiThinkingLevel(state.thinkingLevel) ? state.thinkingLevel : "off";
    return {
      models: available.map((model) => {
        const supportedReasoningEfforts = supportedPiThinkingLevels(model);
        return {
          id: piModelId(model),
          label: `${model.name || model.id} · ${model.provider}`,
          ...(Number.isFinite(model.contextWindow) && Number(model.contextWindow) > 0 ? { contextWindow: Number(model.contextWindow) } : {}),
          supportedReasoningEfforts,
          ...(piModelId(model) === effectiveModel && supportedReasoningEfforts.includes(effectiveThinkingLevel)
            ? { defaultReasoningEffort: effectiveThinkingLevel } : {}),
          verified: "launchable" as const,
        };
      }),
      effectiveModel,
      effectiveThinkingLevel,
      defaultSource: "settings",
      diagnostics: [],
    };
  } catch (error) {
    if (error instanceof RuntimePrerequisiteError) throw error;
    throw new RuntimePrerequisiteError(classifyRuntimePrerequisite("pi", error, command));
  } finally {
    await client.close();
  }
}
