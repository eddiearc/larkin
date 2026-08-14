import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { isWindows, secureWindowsDirectoryAcl } from "../platform/secure-metadata.js";
// proper-lockfile does not publish TypeScript declarations.
// @ts-expect-error bundled CommonJS dependency
import properLockfile from "proper-lockfile";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Credential,
  CredentialStore,
  Provider,
} from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { piAgentDirectory } from "./pi-provider-config.js";

export interface OfficialPiAuthMethod {
  type: AuthType;
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
  getProviders(): readonly Provider[];
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
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

const SNAPSHOT_FILES = ["auth.json", "models.json", "models-store.json"] as const;
const LOCK_WAIT_MS = 15_000;
const LOCK_RETRY_MS = 25;
interface LockOwner { pid: number; token: string; createdAt: number }
interface HeldCredentialLock { owner: LockOwner; depth: number; release(): void }
const heldCredentialLocks = new Map<string, HeldCredentialLock>();
const credentialQueues = new Map<string, Promise<unknown>>();

function credentialLockPath(configDir: string, agentId: string): string {
  if (!/^cli_[A-Za-z0-9]+$/.test(agentId)) throw new Error("invalid Agent ID for Pi credential lock");
  return path.join(piAgentDirectory(configDir, agentId), "auth.json");
}

function ensureLockDirectory(lockPath: string): void {
  const directory = path.dirname(lockPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  if (isWindows) {
    // Windows 无 POSIX 权限位（mode 恒 0o666）：改用 icacls 收紧 ACL 并回读校验。
    secureWindowsDirectoryAcl(directory, { label: "Pi credential lock 目录" });
    return;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o777) !== 0o700) throw new Error("Pi credential lock directory must be an owned 0700 directory");
}

function acquireCredentialLockSync(lockPath: string): LockOwner {
  const existing = heldCredentialLocks.get(lockPath);
  if (existing) { existing.depth += 1; return existing.owner; }
  ensureLockDirectory(lockPath);
  const owner = { pid: process.pid, token: crypto.randomUUID(), createdAt: Date.now() };
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const release = properLockfile.lockSync(lockPath, { realpath: false, stale: 30_000, update: 10_000 });
      heldCredentialLocks.set(lockPath, { owner, depth: 1, release });
      return owner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      if (Date.now() >= deadline) throw new Error("Pi credential store is locked by another live process");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
}

function releaseCredentialLock(lockPath: string, owner: LockOwner): void {
  const held = heldCredentialLocks.get(lockPath);
  if (!held || held.owner.token !== owner.token) throw new Error("Pi credential lock ownership mismatch");
  held.depth -= 1;
  if (held.depth > 0) return;
  try { held.release(); }
  finally { heldCredentialLocks.delete(lockPath); }
}

function withCredentialLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = credentialQueues.get(lockPath) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(async () => {
    const owner = acquireCredentialLockSync(lockPath);
    try { return await operation(); }
    finally { releaseCredentialLock(lockPath, owner); }
  });
  credentialQueues.set(lockPath, result.catch(() => undefined));
  return result;
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(directory), 0o700);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  if (isWindows) {
    // Windows 无 POSIX 权限位：icacls 收紧为「当前用户 + SYSTEM」并回读校验。
    secureWindowsDirectoryAcl(directory, { label: "Pi official credential 目录" });
    return;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o777) !== 0o700) {
    throw new Error("Pi official credential directory must be an owned 0700 directory");
  }
}

function safeRead(file: string): Buffer | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())
        || (!isWindows && (stat.mode & 0o777) !== 0o600)) throw new Error(`unsafe Pi auth file: ${path.basename(file)}`);
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function restoreFile(file: string, bytes: Buffer | null): void {
  if (bytes === null) {
    try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return;
  }
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally { try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ } }
}

function readCredentialData(authPath: string): Record<string, Credential> {
  const bytes = safeRead(authPath);
  if (bytes === null) return {};
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Pi auth.json must contain an object");
  return parsed as Record<string, Credential>;
}

function writeCredentialData(authPath: string, data: Record<string, Credential>): void {
  ensurePrivateDirectory(path.dirname(authPath));
  const temporary = `${authPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, authPath);
    fs.chmodSync(authPath, 0o600);
  } finally { try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ } }
}

/** Official CredentialStore contract backed by raw auth.json bytes.
 * Reads never resolve `!command` API-key values and absent stores stay absent.
 */
class RawFileCredentialStore implements CredentialStore {
  constructor(private readonly authPath: string, private readonly lockPath: string) {}
  read(providerId: string): Promise<Credential | undefined> {
    if (!fs.existsSync(this.authPath)) return Promise.resolve(undefined);
    return withCredentialLock(this.lockPath, async () => {
      safeRead(this.authPath); // enforce owner/type/mode before the official raw reader
      return readStoredCredential(providerId, this.authPath);
    });
  }
  list(): Promise<readonly { providerId: string; type: Credential["type"] }[]> {
    if (!fs.existsSync(this.authPath)) return Promise.resolve([]);
    return withCredentialLock(this.lockPath, async () => Object.entries(readCredentialData(this.authPath)).flatMap(([providerId, credential]) =>
      credential?.type === "api_key" || credential?.type === "oauth" ? [{ providerId, type: credential.type }] : []));
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    ensurePrivateDirectory(path.dirname(this.authPath));
    return withCredentialLock(this.lockPath, async () => {
      const data = readCredentialData(this.authPath);
      const current = data[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      data[providerId] = next;
      writeCredentialData(this.authPath, data);
      return next;
    });
  }
  delete(providerId: string): Promise<void> {
    if (!fs.existsSync(this.authPath)) return Promise.resolve();
    return withCredentialLock(this.lockPath, async () => {
      const data = readCredentialData(this.authPath);
      if (!(providerId in data)) return;
      delete data[providerId];
      writeCredentialData(this.authPath, data);
    });
  }
}

/** Logout only sees an empty credential view; the official logout mutation is
 * delegated to the raw store for its one requested provider. This prevents
 * ModelRuntime's create/post-logout refresh from resolving unrelated entries.
 */
class DeleteOnlyCredentialStore implements CredentialStore {
  constructor(private readonly target: RawFileCredentialStore) {}
  async read(): Promise<undefined> { return undefined; }
  async list(): Promise<readonly []> { return []; }
  async modify(): Promise<undefined> { return undefined; }
  delete(providerId: string): Promise<void> { return this.target.delete(providerId); }
}

export interface BuiltinPiCredentialTransaction {
  directory: string;
  commit(): void;
  rollback(): void;
}

export function beginBuiltinPiCredentialTransaction(configDir: string, agentId: string): BuiltinPiCredentialTransaction {
  const directory = piAgentDirectory(configDir, agentId);
  const lockPath = credentialLockPath(configDir, agentId);
  const existed = fs.existsSync(directory);
  ensurePrivateDirectory(directory);
  const lockOwner = acquireCredentialLockSync(lockPath);
  let snapshots: Map<typeof SNAPSHOT_FILES[number], Buffer | null>;
  try { snapshots = new Map(SNAPSHOT_FILES.map((name) => [name, safeRead(path.join(directory, name))])); }
  catch (error) { releaseCredentialLock(lockPath, lockOwner); throw error; }
  let active = true;
  return {
    directory,
    commit() {
      if (!active) return;
      active = false;
      releaseCredentialLock(lockPath, lockOwner);
      if (!existed) { try { fs.rmdirSync(directory); } catch { /* keep non-empty provider state */ } }
    },
    rollback() {
      if (!active) return;
      try {
        for (const name of [...SNAPSHOT_FILES].reverse()) restoreFile(path.join(directory, name), snapshots.get(name) ?? null);
      } finally { active = false; releaseCredentialLock(lockPath, lockOwner); }
      if (!existed) { try { fs.rmdirSync(directory); } catch { /* keep a non-empty safe directory */ } }
    },
  };
}

async function createOfficialRuntime(options: Parameters<typeof ModelRuntime.create>[0]): Promise<ModelRuntime> {
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    const runtime = await ModelRuntime.create({ ...options, allowModelNetwork: false });
    if (process.env.LARKIN_TEST_BOT_REGISTER_MODULE && process.env.LARKIN_TEST_PI_AUTH_PROVIDER_MODULE) {
      const fixture = await import(pathToFileURL(path.resolve(process.env.LARKIN_TEST_PI_AUTH_PROVIDER_MODULE)).href) as {
        configure?(runtime: ModelRuntime): void | Promise<void>;
      };
      await fixture.configure?.(runtime);
    }
    return runtime;
  } finally {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  }
}

/** Provider catalog only: no Agent credential/model path is opened or created. */
export function createOfficialPiRegistryRuntime(): Promise<ModelRuntime> {
  return createOfficialRuntime({ credentials: new InMemoryCredentialStore(), modelsPath: null });
}

/** Status/logout runtime: raw credentials are injected without resolving API-key commands. */
export function createOfficialPiCredentialRuntime(configDir: string, agentId: string): Promise<ModelRuntime> {
  const directory = piAgentDirectory(configDir, agentId);
  return createOfficialRuntime({
    credentials: new RawFileCredentialStore(path.join(directory, "auth.json"), credentialLockPath(configDir, agentId)),
    modelsPath: null,
  });
}

/** Logout runtime deletes through the official ModelRuntime API while keeping
 * unrelated stored credentials invisible to its automatic refreshes. */
export function createOfficialPiLogoutRuntime(configDir: string, agentId: string): Promise<ModelRuntime> {
  const directory = piAgentDirectory(configDir, agentId);
  const store = new RawFileCredentialStore(path.join(directory, "auth.json"), credentialLockPath(configDir, agentId));
  return createOfficialRuntime({ credentials: new DeleteOnlyCredentialStore(store), modelsPath: null });
}

/** Login/request runtime: official auth orchestration with a command-free persistent CredentialStore. */
export function createOfficialPiModelRuntime(configDir: string, agentId: string): Promise<ModelRuntime> {
  const directory = piAgentDirectory(configDir, agentId);
  return createOfficialRuntime({
    credentials: new RawFileCredentialStore(path.join(directory, "auth.json"), credentialLockPath(configDir, agentId)),
    modelsPath: fs.existsSync(path.join(directory, "models.json")) ? path.join(directory, "models.json") : null,
    modelsStorePath: path.join(directory, "models-store.json"),
  });
}

export function listOfficialPiAuthProviders(runtime: Pick<OfficialPiAuthRuntime, "getProviders">): OfficialPiAuthProvider[] {
  return runtime.getProviders().map((provider) => {
    const methods: OfficialPiAuthMethod[] = [];
    if (provider.auth.apiKey?.login) methods.push({ type: "api_key", name: provider.auth.apiKey.name });
    if (provider.auth.oauth?.login) methods.push({ type: "oauth", name: provider.auth.oauth.loginLabel || provider.auth.oauth.name });
    return {
      id: provider.id,
      name: provider.name,
      methods,
      models: provider.getModels().map((model) => `${model.provider}/${model.id}`),
      ambientOnly: methods.length === 0 && Boolean(provider.auth.apiKey),
    };
  });
}

function abortError(): Error {
  const error = new Error("Pi auth login cancelled");
  error.name = "AbortError";
  return error;
}

async function abortable<T>(promise: Promise<T>, signals: readonly (AbortSignal | undefined)[]): Promise<T> {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.some((signal) => signal.aborted)) throw abortError();
  let cleanup = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const listener = (): void => reject(abortError());
    for (const signal of active) signal.addEventListener("abort", listener, { once: true });
    cleanup = () => { for (const signal of active) signal.removeEventListener("abort", listener); };
  });
  try { return await Promise.race([promise, aborted]); }
  finally { cleanup(); }
}

function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return "(invalid URL)"; }
}

function copyableAuthUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || /[\0\r\n]/.test(raw)) return null;
    return url.toString();
  } catch { return null; }
}

function promptLabel(prompt: AuthPrompt): string {
  return `${prompt.message}${"placeholder" in prompt && prompt.placeholder ? `（${prompt.placeholder}）` : ""}`;
}

export function createOfficialPiAuthInteraction(input: {
  questioner: PiAuthQuestioner;
  report(message: string): void;
  openUrl?: (url: string) => boolean;
  signal?: AbortSignal;
}): AuthInteraction {
  const prompt = async (request: AuthPrompt): Promise<string> => {
    if (request.type === "select") {
      const lines = request.options.map((option, index) => `  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`).join("\n");
      const answer = await abortable(input.questioner.ask(`${request.message}\n${lines}\n> `, request.signal), [input.signal, request.signal]);
      const index = Number(answer.trim()) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= request.options.length) throw new Error(`请选择 1-${request.options.length}`);
      return request.options[index]!.id;
    }
    const question = `${promptLabel(request)}\n> `;
    const operation = request.type === "secret" || request.type === "manual_code"
      ? input.questioner.secret(question, request.signal)
      : input.questioner.ask(question, request.signal);
    return abortable(operation, [input.signal, request.signal]);
  };
  const notify = (event: AuthEvent): void => {
    if (event.type === "info") {
      input.report(event.message);
      for (const link of event.links ?? []) input.report(`${link.label || "More information"}: ${safeUrl(link.url)}`);
      return;
    }
    if (event.type === "auth_url") {
      const fullUrl = copyableAuthUrl(event.url);
      const opened = Boolean(fullUrl) && input.openUrl?.(fullUrl!) === true;
      input.report(`${opened ? "登录地址已在浏览器打开" : "请复制完整登录地址"}: ${opened ? safeUrl(fullUrl!) : fullUrl || "(invalid URL)"}`);
      if (event.instructions) input.report(event.instructions);
      return;
    }
    if (event.type === "device_code") {
      input.report(`设备登录码：${event.userCode}`);
      input.report(`验证地址：${safeUrl(event.verificationUri)}`);
      if (event.expiresInSeconds) input.report(`有效期：${event.expiresInSeconds} 秒`);
      return;
    }
    input.report(event.message);
  };
  return { signal: input.signal, prompt, notify };
}

export function runOfficialPiLogin(runtime: Pick<OfficialPiAuthRuntime, "login">, providerId: string,
  authType: AuthType, interaction: AuthInteraction): Promise<Credential> {
  return runtime.login(providerId, authType, interaction);
}

export async function verifyOfficialPiProviderTurn(runtime: ModelRuntime, modelId: string,
  signal?: AbortSignal): Promise<void> {
  const separator = modelId.indexOf("/");
  const providerId = separator > 0 ? modelId.slice(0, separator) : "";
  const providerModelId = separator > 0 ? modelId.slice(separator + 1) : "";
  const model = runtime.getModel(providerId, providerModelId);
  if (!model) throw new Error("selected Pi provider model is not registered");
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 60_000);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    const response = await runtime.completeSimple(model, {
      systemPrompt: "This is a setup readiness check. Do not use tools.",
      messages: [{ role: "user", content: "Reply exactly: LARKIN_READY", timestamp: Date.now() }],
    }, { maxTokens: 32, signal: combined });
    const text = response.content.flatMap((entry) => entry.type === "text" ? [entry.text] : []).join("").trim();
    if (response.stopReason === "error" || response.stopReason === "aborted" || !text) {
      throw new Error(response.errorMessage || "provider readiness turn returned no authenticated text");
    }
  } finally { clearTimeout(timer); }
}

function safeSource(value: string | undefined): string {
  if (!value || value.length > 120 || /[\0\r\n]/.test(value) || /[?&#=]/.test(value)) return "configured";
  return value;
}

export async function officialPiAuthStatus(runtime: Pick<OfficialPiAuthRuntime,
  "getProviders" | "listCredentials" | "checkAuth">): Promise<OfficialPiAuthStatus[]> {
  const providers = new Map(runtime.getProviders().map((provider) => [provider.id, provider.name]));
  const stored = new Map((await runtime.listCredentials()).map((entry) => [entry.providerId, entry.type]));
  const providerIds = [...new Set([...providers.keys(), ...stored.keys()])];
  const statuses: OfficialPiAuthStatus[] = [];
  for (const providerId of providerIds) {
    const check = await runtime.checkAuth(providerId);
    const credentialType = stored.get(providerId) || check?.type;
    if (!credentialType) continue;
    statuses.push({
      providerId,
      providerName: providers.get(providerId) || providerId,
      credentialType,
      source: safeSource(check?.source),
      stored: stored.has(providerId),
    });
  }
  return statuses;
}

export function logoutOfficialPiProvider(runtime: Pick<OfficialPiAuthRuntime, "logout">, providerId: string): Promise<void> {
  return runtime.logout(providerId);
}
