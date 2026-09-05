import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type RuntimeReadinessState = "missing" | "unauthenticated" | "unavailable" | "incompatible" | "ready";

export interface RuntimeReadiness {
  runtime: "codex" | "claude" | "pi";
  state: RuntimeReadinessState;
  executable?: string;
  version?: string;
  reason?: string;
  nextAction?: string;
  /** Set only when a HostShell status projection records this observation. */
  observedAt?: string;
}

export function safeProviderId(value: unknown): string | null {
  const provider = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(provider) ? provider : null;
}

function safeProviderLabel(value: unknown): string | null {
  return safeProviderId(value);
}

export type PersistedAuthFailureKind = "missing-provider" | "generic";

/** Current scoped auth-failure marker. Never stores secrets or ledger history. */
export interface PersistedAuthFailure {
  kind: PersistedAuthFailureKind;
  runtime: RuntimeReadiness["runtime"];
  provider?: string | null;
}

export interface AuthFailureScope {
  runtime: string;
  model?: string;
  adapterId?: string;
}

/** Model ids are `provider/model`; only the provider prefix is used for scope. */
export function configuredProviderId(model: unknown): string | null {
  const value = typeof model === "string" ? model.trim() : "";
  const slash = value.indexOf("/");
  return slash > 0 ? safeProviderId(value.slice(0, slash)) : null;
}

function persistedRuntime(value: unknown): RuntimeReadiness["runtime"] | null {
  return value === "pi" || value === "codex" || value === "claude" ? value : null;
}

export function parsePersistedAuthFailure(state: unknown): PersistedAuthFailure | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const record = state as Record<string, unknown>;
  if (record.authFailure && typeof record.authFailure === "object" && !Array.isArray(record.authFailure)) {
    const failure = record.authFailure as Record<string, unknown>;
    const kind = failure.kind === "missing-provider" || failure.kind === "generic" ? failure.kind : null;
    const runtime = persistedRuntime(failure.runtime);
    if (!kind || !runtime) return null;
    const provider = safeProviderId(failure.provider);
    if (kind === "missing-provider" && !provider) return null;
    return { kind, runtime, provider };
  }
  const legacy = safeProviderId(record.authFailureProvider);
  return legacy ? { kind: "missing-provider", runtime: "pi", provider: legacy } : null;
}

function currentAdapterId(current: AuthFailureScope): string {
  return current.adapterId ?? current.runtime;
}

export function authFailureAppliesTo(current: AuthFailureScope, failure: PersistedAuthFailure): boolean {
  if (failure.runtime !== currentAdapterId(current)) return false;
  if (!failure.provider) return true;
  const currentProvider = configuredProviderId(current.model);
  return currentProvider ? currentProvider === failure.provider : true;
}

export function readinessForPersistedAuthFailure(failure: PersistedAuthFailure): RuntimeReadiness {
  if (failure.kind === "missing-provider") {
    return missingProviderCredentialReadiness(failure.runtime, failure.provider);
  }
  return providerAuthenticationFailureReadiness(failure.runtime, failure.provider);
}

const MISSING_CREDENTIAL_REJECTION =
  /^(?:Pi RPC (?:prompt|steer) failed: )?(No API key found for|No login found for) ([A-Za-z0-9][A-Za-z0-9._-]{0,79})$/;

/** Narrow match for an explicit Pi absent-key / absent-login diagnostic. */
export function classifyPiMissingCredentialRejection(message: unknown): { provider: string; diagnostic: string } | null {
  const text = typeof message === "string"
    ? message.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
  const match = MISSING_CREDENTIAL_REJECTION.exec(text);
  const provider = match ? safeProviderLabel(match[2]) : null;
  return provider && match ? { provider, diagnostic: `${match[1]} ${provider}` } : null;
}

export function runtimeInstallNextAction(runtime: RuntimeReadiness["runtime"]): string {
  if (runtime === "pi") return "Install Pi and ensure `pi` is on PATH, or set LARKIN_PI_COMMAND.";
  if (runtime === "codex") return "Install Codex and ensure `codex` is on PATH, or set LARKIN_CODEX_COMMAND.";
  return "Install Claude Code and ensure `claude` is on PATH, or set LARKIN_CLAUDE_COMMAND.";
}

export function runtimeLoginNextAction(runtime: RuntimeReadiness["runtime"]): string {
  if (runtime === "pi") return "Run the official `pi` login flow, then retry.";
  if (runtime === "codex") return "Run `codex login`, then retry.";
  return "Run `claude login`, then retry.";
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
    nextAction: runtimeLoginNextAction(runtime),
  };
}

export function missingProviderCredentialReadiness(
  runtime: RuntimeReadiness["runtime"],
  provider?: unknown,
): RuntimeReadiness {
  const label = safeProviderLabel(provider);
  return {
    runtime,
    state: "unauthenticated",
    reason: label
      ? `Provider ${label} is not authenticated for this runtime.`
      : "The configured provider is not authenticated for this runtime.",
    nextAction: runtimeLoginNextAction(runtime),
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
    runtime, state: "missing", ...(executable ? { executable } : {}),
    reason: `${runtime} is not installed`,
    nextAction: runtimeInstallNextAction(runtime),
  };
  if (/no authenticated available models|login|credential|unauthenticated|unauthorized|oauth/i.test(reason)) return {
    runtime, state: "unauthenticated", ...(executable ? { executable } : {}), reason,
    nextAction: runtimeLoginNextAction(runtime),
  };
  if (/protocol (?:version )?(?:mismatch|unsupported|incompatible)|unsupported (?:rpc|protocol|schema)|schema (?:mismatch|incompatible)|requires (?:a )?newer version/i.test(reason)) {
    return {
      runtime, state: "incompatible", ...(executable ? { executable } : {}), reason,
      nextAction: runtime === "pi"
        ? "Upgrade local Pi to a version that supports the documented RPC protocol."
        : `Upgrade ${runtime}, then retry.`,
    };
  }
  if (/timeout|timed out|unexpected EOF|\bEOF\b|TLS|ECONNRESET|socket hang up|network|temporar(?:y|ily)|unavailable/i.test(reason)) {
    return {
      runtime, state: "unavailable", ...(executable ? { executable } : {}), reason,
      nextAction: `Retry ${runtime}; Larkin will use its bounded Runtime recreate/backoff policy.`,
    };
  }
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
  commandArgs?: readonly string[];
  agentId?: string;
}

function selectedCommand(options: ProbeNativeRuntimeReadinessOptions): string {
  if (options.command) return options.command;
  if (options.runtime === "pi") return options.env?.LARKIN_PI_COMMAND || process.env.LARKIN_PI_COMMAND || "pi";
  if (options.runtime === "codex") return options.env?.LARKIN_CODEX_COMMAND || process.env.LARKIN_CODEX_COMMAND || "codex";
  return options.env?.LARKIN_CLAUDE_COMMAND || process.env.LARKIN_CLAUDE_COMMAND || "claude";
}

function executableVersion(executable: string, env: NodeJS.ProcessEnv, commandArgs: readonly string[] = []): string | undefined {
  const result = spawnSync(executable, [...commandArgs, "--version"], { env, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0) return undefined;
  return String(result.stdout || result.stderr || "").replace(/[\r\n]+/g, " ").trim().slice(0, 120) || undefined;
}

/** Resolve and handshake through each runtime's structured native control protocol. */
export async function probeNativeRuntimeReadiness(options: ProbeNativeRuntimeReadinessOptions): Promise<RuntimeReadiness> {
  const env = { ...process.env, ...options.env };
  const command = selectedCommand(options);
  const executable = resolveRuntimeExecutable(command, env);
  if (!executable) {
    return {
      runtime: options.runtime,
      state: "missing",
      reason: `${options.runtime} is not installed`,
      nextAction: runtimeInstallNextAction(options.runtime),
    };
  }
  const version = executableVersion(executable, env, options.commandArgs);
  try {
    if (options.runtime === "pi") {
      const { discoverPiModelCatalog } = await import("./pi-model-catalog.js");
      await discoverPiModelCatalog({
        cwd: options.cwd,
        command: executable,
        commandArgs: options.commandArgs,
        env,
      });
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
