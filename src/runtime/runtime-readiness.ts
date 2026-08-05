import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertBuiltinPiAgentDirectory, BUNDLED_PI_VERSION, piAgentDirectory } from "./pi-provider-config.js";

export type RuntimeReadinessState = "missing" | "unauthenticated" | "unavailable" | "incompatible" | "ready";

export interface RuntimeReadiness {
  runtime: "codex" | "claude" | "pi";
  state: RuntimeReadinessState;
  executable?: string;
  version?: string;
  reason?: string;
  nextAction?: string;
}

function safeProviderLabel(value: unknown): string | null {
  const provider = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(provider) ? provider : null;
}

export function providerAuthenticationFailureReadiness(
  runtime: RuntimeReadiness["runtime"],
  provider?: unknown,
): RuntimeReadiness {
  const label = safeProviderLabel(provider);
  return {
    runtime,
    state: "unauthenticated",
    reason: label
      ? `Provider ${label} API-key authentication failed during a Runtime turn.`
      : "Configured provider API-key authentication failed during a Runtime turn.",
    nextAction: "Check the provider login or API-key resolver command, then retry the Agent turn.",
  };
}

export class RuntimePrerequisiteError extends Error {
  constructor(readonly readiness: RuntimeReadiness) {
    super(readiness.reason || `${readiness.runtime} runtime is ${readiness.state}`);
    this.name = "RuntimePrerequisiteError";
  }
}

export function resolveRuntimeExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = command.trim();
  if (!value || /[\r\n\0]/.test(value)) return null;
  const candidates = value.includes(path.sep)
    ? [path.resolve(value)]
    : String(env.PATH || "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, value));
  return candidates.find((candidate) => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
    catch { return false; }
  }) ?? null;
}

export function classifyRuntimePrerequisite(runtime: RuntimeReadiness["runtime"], error: unknown,
  executable?: string): RuntimeReadiness {
  const reason = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 500);
  if (/ENOENT|not found|no such file|spawn .* failed/i.test(reason)) return {
    runtime, state: "missing", ...(executable ? { executable } : {}), reason,
    nextAction: runtime === "pi" ? "Install Pi and ensure `pi` is on PATH, or set LARKIN_PI_COMMAND." : `Install ${runtime} and ensure it is on PATH.`,
  };
  if (/no authenticated available models|login|credential|unauthenticated|unauthorized|oauth/i.test(reason)) return {
    runtime, state: "unauthenticated", ...(executable ? { executable } : {}), reason,
    nextAction: runtime === "pi" ? "Run the official `pi` login flow, then retry." : `Authenticate ${runtime}, then retry.`,
  };
  if (/protocol (?:version )?(?:mismatch|unsupported|incompatible)|unsupported (?:rpc|protocol|schema)|schema (?:mismatch|incompatible)|requires (?:a )?newer version/i.test(reason)) return {
    runtime, state: "incompatible", ...(executable ? { executable } : {}), reason,
    nextAction: runtime === "pi" ? "Upgrade local Pi to a version that supports the documented RPC protocol." : `Upgrade ${runtime}, then retry.`,
  };
  if (/timeout|timed out|unexpected EOF|\bEOF\b|TLS|ECONNRESET|socket hang up|network|temporar(?:y|ily)|unavailable/i.test(reason)) return {
    runtime, state: "unavailable", ...(executable ? { executable } : {}), reason,
    nextAction: `Retry ${runtime}; Larkin will use its bounded Runtime recreate/backoff policy.`,
  };
  return {
    runtime, state: "unavailable", ...(executable ? { executable } : {}), reason,
    nextAction: `Retry ${runtime}; the failure is not proven to be a protocol incompatibility.`,
  };
}

export interface ProbeNativeRuntimeReadinessOptions {
  runtime: RuntimeReadiness["runtime"];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  agentId?: string;
}

function selectedCommand(options: ProbeNativeRuntimeReadinessOptions): string {
  if (options.command) return options.command;
  if (options.runtime === "pi") return options.env?.LARKIN_PI_COMMAND || process.env.LARKIN_PI_COMMAND || "pi";
  if (options.runtime === "codex") return options.env?.LARKIN_CODEX_COMMAND || process.env.LARKIN_CODEX_COMMAND || "codex";
  return options.env?.LARKIN_CLAUDE_COMMAND || process.env.LARKIN_CLAUDE_COMMAND || "claude";
}

function executableVersion(executable: string, env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(executable, ["--version"], { env, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0) return undefined;
  return String(result.stdout || result.stderr || "").replace(/[\r\n]+/g, " ").trim().slice(0, 120) || undefined;
}

/** Resolve and handshake through each runtime's structured native control protocol. */
export async function probeNativeRuntimeReadiness(options: ProbeNativeRuntimeReadinessOptions): Promise<RuntimeReadiness> {
  const env = { ...process.env, ...options.env };
  if (options.runtime === "pi" && env.LARKIN_PI_DISTRIBUTION === "builtin") {
    try {
      if (!options.agentId || !env.LARKIN_CONFIG_DIR) throw new Error("内置 Pi readiness 缺少 Agent/config identity");
      assertBuiltinPiAgentDirectory(piAgentDirectory(env.LARKIN_CONFIG_DIR, options.agentId));
      return { runtime: "pi", state: "ready", executable: process.execPath, version: `official-pi ${BUNDLED_PI_VERSION} (bundled)` };
    } catch (error) {
      return { runtime: "pi", state: "unauthenticated", reason: error instanceof Error ? error.message : String(error),
        nextAction: "重新运行 larkin setup，选择内置 Pi 并配置有效 API Key。" };
    }
  }
  const command = selectedCommand(options);
  const executable = resolveRuntimeExecutable(command, env);
  if (!executable) return {
    runtime: options.runtime, state: "missing",
    reason: `${command} executable was not found`,
    nextAction: options.runtime === "pi"
      ? "Install Pi and ensure `pi` is on PATH, or set LARKIN_PI_COMMAND."
      : `Install ${options.runtime} and ensure it is on PATH.`,
  };
  const version = executableVersion(executable, env);
  try {
    if (options.runtime === "pi") {
      const { discoverPiModelCatalog } = await import("./pi-model-catalog.js");
      await discoverPiModelCatalog({ cwd: options.cwd, command: executable, env });
    } else if (options.runtime === "codex") {
      const { discoverCodexModelCatalog } = await import("./codex-model-catalog.js");
      await discoverCodexModelCatalog({ cwd: options.cwd, command: executable, env });
    } else {
      const { discoverClaudeModelCatalog } = await import("./claude-model-catalog.js");
      await discoverClaudeModelCatalog({ cwd: options.cwd, command: executable, env });
    }
    return { runtime: options.runtime, state: "ready", executable, ...(version ? { version } : {}) };
  } catch (error) {
    const classified = error instanceof RuntimePrerequisiteError ? error.readiness
      : classifyRuntimePrerequisite(options.runtime, error, executable);
    return { ...classified, executable, ...(version ? { version } : {}) };
  }
}
