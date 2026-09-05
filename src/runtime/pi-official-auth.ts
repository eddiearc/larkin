/** Slice (a) stub: builtin Pi official auth was removed. Slice (b)/(c) will delete the remaining callers. */
const removed = (): never => {
  throw new Error("builtin Pi was removed; install and log in with the external `pi` CLI");
};

export interface OfficialPiAuthMethod {
  type: "api_key" | "oauth";
  name: string;
}

export interface OfficialPiAuthProvider {
  id: string;
  name: string;
  methods: OfficialPiAuthMethod[];
  models: string[];
  ambientOnly: boolean;
}

export interface OfficialPiAuthRuntime {
  getProviders(): readonly unknown[];
  login(...args: unknown[]): Promise<unknown>;
  logout(providerId: string): Promise<void>;
  listCredentials(): Promise<readonly { providerId: string; type: "api_key" | "oauth" }[]>;
  checkAuth(providerId: string): Promise<{ source?: string; type: "api_key" | "oauth" } | undefined>;
}

export interface PiAuthQuestioner {
  ask(prompt: string, signal?: AbortSignal): Promise<string>;
  secret(prompt: string, signal?: AbortSignal): Promise<string>;
}

export interface OfficialPiAuthStatus {
  providerId: string;
  providerName: string;
  credentialType: "api_key" | "oauth";
  source: string;
  stored: boolean;
}

export interface BuiltinPiCredentialTransaction {
  directory: string;
  commit(): void;
  rollback(): void;
}

export function officialPiHasStoredProvider(_configDir: string, _agentId: string, _providerId: string): boolean {
  return false;
}
export function beginBuiltinPiCredentialTransaction(_configDir: string, _agentId: string): BuiltinPiCredentialTransaction {
  return removed();
}
export async function createOfficialPiRegistryRuntime(): Promise<OfficialPiAuthRuntime> { return removed(); }
export async function createOfficialPiCredentialRuntime(_configDir: string, _agentId: string): Promise<OfficialPiAuthRuntime> { return removed(); }
export async function createOfficialPiLogoutRuntime(_configDir: string, _agentId: string): Promise<OfficialPiAuthRuntime> { return removed(); }
export async function createOfficialPiModelRuntime(_configDir: string, _agentId: string): Promise<OfficialPiAuthRuntime> { return removed(); }
export function listOfficialPiAuthProviders(_runtime: Pick<OfficialPiAuthRuntime, "getProviders">): OfficialPiAuthProvider[] {
  return removed();
}
export function createOfficialPiAuthInteraction(_input: {
  questioner?: PiAuthQuestioner;
  report?: (message: string) => void;
  openUrl?: unknown;
  signal?: AbortSignal;
}): unknown { return removed(); }
export function runOfficialPiLogin(_runtime: unknown, _providerId: string, ..._rest: unknown[]): Promise<unknown> {
  return Promise.reject(new Error("builtin Pi was removed; install and log in with the external `pi` CLI"));
}
export async function verifyOfficialPiProviderTurn(_runtime: unknown, _modelId: string, ..._rest: unknown[]): Promise<unknown> {
  return removed();
}
export async function officialPiAuthStatus(_runtime: unknown, ..._rest: unknown[]): Promise<OfficialPiAuthStatus[]> {
  return removed();
}
export function logoutOfficialPiProvider(_runtime: unknown, _providerId: string): Promise<void> {
  return Promise.reject(new Error("builtin Pi was removed; install and log in with the external `pi` CLI"));
}
