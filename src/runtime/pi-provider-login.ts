import type { OfficialPiAuthStatus } from "./pi-official-auth.js";

/** Slice (a) stub: builtin Pi provider login was removed. Slice (b)/(c) will delete the remaining callers. */
const removed = (): never => {
  throw new Error("builtin Pi was removed; install and log in with the external `pi` CLI");
};

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
  [key: string]: unknown;
}

export interface LogoutBuiltinPiProviderDeps {
  [key: string]: unknown;
}

export function listBuiltinPiProviderCatalog(): BuiltinPiProviderCatalogEntry[] {
  return [];
}

export function sanitizeProviderLoginError(error: unknown, _secret?: string): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveBuiltinPiLoginSelection(_input: unknown): unknown { return removed(); }
export function createApiKeyOnlyInteraction(..._args: unknown[]): unknown { return removed(); }
export async function configureBuiltinPiProvider(
  _input: BuiltinPiProviderLoginInput,
  _deps?: ConfigureBuiltinPiProviderDeps,
): Promise<BuiltinPiProviderLoginResult> {
  return removed();
}
export async function logoutBuiltinPiProvider(
  _input: { agentId: string; provider?: string; providerId?: string; env?: NodeJS.ProcessEnv },
  _deps?: LogoutBuiltinPiProviderDeps,
): Promise<{ agentId: string; provider: string }> {
  return removed();
}
