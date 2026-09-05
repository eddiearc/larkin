export const RUNTIME_OPTIONS = ["codex", "claude", "pi"] as const;
export type RuntimeOption = (typeof RUNTIME_OPTIONS)[number];

export const USER_RUNTIMES = RUNTIME_OPTIONS;
export type UserRuntime = RuntimeOption;

export const ADAPTER_RUNTIMES = ["pi", "codex", "claude"] as const;
export type AdapterRuntime = (typeof ADAPTER_RUNTIMES)[number];

export function isUserRuntime(value: string): value is RuntimeOption {
  return value === "pi" || value === "codex" || value === "claude";
}

export function isAdapterRuntime(value: string): value is AdapterRuntime {
  return value === "pi" || value === "codex" || value === "claude";
}

/** Identity mapping with validation. Legacy `piDistribution` is ignored. */
export function runtimeOptionOf(input: { runtime: string; piDistribution?: unknown }): RuntimeOption | string {
  return input.runtime;
}

export function toUserRuntime(runtime: string, _piDistribution?: unknown): string {
  return runtimeOptionOf({ runtime });
}

/** Persist a user-facing runtime as the stored adapter id. */
export function runtimeOptionTarget(option: string): { runtime: AdapterRuntime } {
  if (!isUserRuntime(option)) throw new Error(`未知 runtime：${option}`);
  return { runtime: option };
}

export function fromUserRuntime(userRuntime: string): { runtime: AdapterRuntime } {
  return runtimeOptionTarget(userRuntime);
}
