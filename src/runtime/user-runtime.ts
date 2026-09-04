export const RUNTIME_OPTIONS = ["codex", "claude", "pi", "builtin-pi"] as const;
export type RuntimeOption = (typeof RUNTIME_OPTIONS)[number];

export const USER_RUNTIMES = RUNTIME_OPTIONS;
export type UserRuntime = RuntimeOption;

export const ADAPTER_RUNTIMES = ["pi", "codex", "claude"] as const;
export type AdapterRuntime = (typeof ADAPTER_RUNTIMES)[number];

export function isUserRuntime(value: string): value is RuntimeOption {
  return value === "pi" || value === "builtin-pi" || value === "codex" || value === "claude";
}

export function isAdapterRuntime(value: string): value is AdapterRuntime {
  return value === "pi" || value === "codex" || value === "claude";
}

/** Project stored adapter + distribution to the user-facing sibling id. Legacy `runtime=pi` without distribution is `pi`, never builtin. */
export function runtimeOptionOf(input: { runtime: string; piDistribution?: "builtin" | "external" | null }): RuntimeOption | string {
  const { runtime, piDistribution } = input;
  if (runtime === "codex" || runtime === "claude" || runtime === "builtin-pi") return runtime;
  if (runtime === "pi") return piDistribution === "builtin" ? "builtin-pi" : "pi";
  return runtime;
}

export function toUserRuntime(runtime: string, piDistribution?: "builtin" | "external" | null): string {
  return runtimeOptionOf({ runtime, piDistribution });
}

/** Persist a user-facing sibling as adapter id + distribution. Adapter id stays `pi` for both Pi siblings. */
export function runtimeOptionTarget(option: string): { runtime: AdapterRuntime; piDistribution?: "builtin" | "external" } {
  if (!isUserRuntime(option)) throw new Error(`未知 runtime：${option}`);
  if (option === "builtin-pi") return { runtime: "pi", piDistribution: "builtin" };
  if (option === "pi") return { runtime: "pi", piDistribution: "external" };
  return { runtime: option };
}

export function fromUserRuntime(userRuntime: string): { runtime: AdapterRuntime; piDistribution?: "builtin" | "external" } {
  return runtimeOptionTarget(userRuntime);
}

export function piCatalogDistributionForUserRuntime(userRuntime: string): "builtin" | "external" {
  if (userRuntime === "builtin-pi") return "builtin";
  if (userRuntime === "pi") return "external";
  throw new Error(`非 Pi sibling runtime：${userRuntime}`);
}
