import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HydratedAgent } from "../platform/config.js";
import { acquireProcessLock } from "../platform/process-state.js";
import {
  assertSecureBotsDirectory,
  readSecureBotCredential,
  validCredentialRecord,
  type BotCredentialRecord,
} from "../setup/run-credential-preflight.js";
import { resolveOfficialLarkCli, type OfficialLarkCliCommand } from "./official-lark-cli.js";
import { internalCommandSpec } from "./internal-command.js";
import {
  assertAgentWorkspaceBound, larkChannelSourceConfigPath, larkChannelWorkspaceConfigPath, managedLarkCliEnv,
} from "./agent-lark-cli-workspace.js";

export interface RuntimeAgentConfig extends HydratedAgent {
  feishuAppSecret: string;
  feishuDomain: "https://open.feishu.cn" | "https://open.larksuite.com";
  credentialRevision: string;
}

interface LarkCliConfig { apps?: Array<Record<string, unknown>>; [key: string]: unknown }
interface ProfileSnapshot {
  value: LarkCliConfig;
  raw: Buffer;
  mode: number;
}

export interface RuntimeAgentConfigDependencies {
  resolveOfficialCli?(env: NodeJS.ProcessEnv): OfficialLarkCliCommand;
  runOfficialCli?(command: OfficialLarkCliCommand, args: readonly string[], options: Parameters<typeof spawnSync>[2]): ReturnType<typeof spawnSync>;
  forceRebind?: boolean;
}

export interface AsyncRuntimeAgentConfigDependencies extends RuntimeAgentConfigDependencies {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onChild?(child: ChildProcess | null): void;
}

function assertSecureProfileDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o777) !== 0o700) throw new Error("lark-cli profile 目录不安全");
}

function captureProfileSnapshot(file: string): ProfileSnapshot | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o077) !== 0) throw new Error("lark-cli config.json 不安全");
    const raw = fs.readFileSync(fd);
    const value = JSON.parse(raw.toString("utf8")) as LarkCliConfig;
    if (!value || typeof value !== "object" || (value.apps !== undefined && !Array.isArray(value.apps))) {
      throw new Error("lark-cli config.json schema 无效");
    }
    return { value, raw, mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function atomicPublishProfile(file: string, bytes: Buffer | string, mode = 0o600): void {
  const directory = path.dirname(file);
  assertSecureProfileDirectory(directory);
  const canonical = path.join(path.resolve(directory), "config.json");
  if (path.resolve(file) !== canonical || path.basename(file) !== "config.json") {
    throw new Error("lark-cli config 发布路径无效");
  }
  const temporary = path.join(directory, `.config.${process.pid}.${crypto.randomUUID()}.publish`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    let current: fs.Stats | null = null;
    try { current = fs.lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current) {
      if (typeof process.getuid === "function" && current.uid !== process.getuid()) {
        throw new Error("config.json 不属于当前用户");
      }
      if (current.isDirectory()) {
        try { fs.rmdirSync(file); }
        catch (error) {
          if (["ENOTEMPTY", "EEXIST"].includes(String((error as NodeJS.ErrnoException).code || ""))) {
            throw new Error("config.json 已被替换为非空目录");
          }
          throw error;
        }
      } else if (!current.isFile() && !current.isSymbolicLink()) {
        throw new Error("config.json 已被替换为不安全文件类型");
      }
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}；待发布内容保留于 ${temporary}`);
  }
}

function containsUserToken(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUserToken);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    (/token/i.test(key) && nested !== null && nested !== "" && nested !== undefined) || containsUserToken(nested));
}

function validStoredAppSecret(value: unknown, appId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reference = value as { source?: unknown; id?: unknown };
  return reference.source === "keychain" && reference.id === `appsecret:${appId}`;
}

function validateExclusiveBotProfile(snapshot: ProfileSnapshot, agent: RuntimeAgentConfig): void {
  const apps = snapshot.value.apps;
  if (!Array.isArray(apps) || apps.length !== 1) throw new Error("lark-cli profile 必须只包含当前 Agent App");
  const app = apps[0];
  if (app.appId !== agent.feishuAppId || (app.name !== undefined && app.name !== agent.feishuAppId)) {
    throw new Error("lark-cli profile App identity 与当前 Agent 不一致");
  }
  if (!validStoredAppSecret(app.appSecret, agent.feishuAppId)) throw new Error("lark-cli workspace App Secret 必须是当前 App 的 keychain 引用");
  if (app.defaultAs !== "bot" || app.strictMode !== "bot") throw new Error("lark-channel workspace 未锁定 bot-only identity policy");
  if (Array.isArray(app.users) ? app.users.length !== 0
    : app.users && typeof app.users === "object" ? Object.keys(app.users).length !== 0 : app.users !== undefined && app.users !== null) {
    throw new Error("lark-cli profile 不得保留 user identity");
  }
  if (containsUserToken(snapshot.value)) throw new Error("lark-cli profile 不得保留 user token");
}

export function hydrateRuntimeAgent(configDir: string, agent: HydratedAgent): RuntimeAgentConfig {
  const botsDir = path.join(configDir, "bots");
  assertSecureBotsDirectory(botsDir);
  const record = readSecureBotCredential(botsDir, agent.feishuAppId);
  if (!validCredentialRecord(record, agent.feishuAppId)) {
    throw new Error(`Agent ${agent.agentId} 的 bot 凭证无效或与 App ID 不一致`);
  }
  const credential = record as BotCredentialRecord;
  // updatedAt is the authoritative secret-rotation revision. Other credential metadata
  // (owner/callback capability) must never cause a keychain write on the next startup.
  // Legacy records are rebound once by setup and remain on a stable non-secret sentinel.
  const credentialRevision = credential.updatedAt ? `updated:${credential.updatedAt}` : "legacy-unversioned";
  return {
    ...agent,
    feishuAppSecret: credential.appSecret,
    feishuDomain: credential.tenant === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn",
    credentialRevision,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertSecureRuntimeCommandDirectory(commandDir: string): void {
  fs.mkdirSync(commandDir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(commandDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("Runtime command shim 目录不安全");
  }
  fs.chmodSync(commandDir, 0o700);
}

function runOfficialLarkCli(
  command: OfficialLarkCliCommand,
  args: readonly string[],
  options: Parameters<typeof spawnSync>[2],
  dependencies: RuntimeAgentConfigDependencies,
): ReturnType<typeof spawnSync> {
  return dependencies.runOfficialCli
    ? dependencies.runOfficialCli(command, args, options)
    : spawnSync(command.command, [...command.argsPrefix, ...args], options);
}

function officialFailure(label: string, result: ReturnType<typeof spawnSync>, secret: string): Error {
  const stderr = String(result.stderr || "").replaceAll(secret, "<redacted>").trim().slice(0, 400);
  const detail = [result.error?.message, stderr].filter(Boolean).join(": ");
  return new Error(`${label} failed (exit=${result.status ?? "none"})${detail ? `: ${detail}` : ""}`);
}

interface BoundedOfficialResult { status: number | null; stdout: string; stderr: string }

function runOfficialLarkCliAsync(command: OfficialLarkCliCommand, args: readonly string[], env: NodeJS.ProcessEnv,
  dependencies: AsyncRuntimeAgentConfigDependencies): Promise<BoundedOfficialResult> {
  const timeoutMs = dependencies.timeoutMs ?? 60_000;
  const maxOutputBytes = dependencies.maxOutputBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.argsPrefix, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    dependencies.onChild?.(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | null = null;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const terminate = (error: Error): void => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1_000);
      killTimer.unref?.();
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { terminate(new Error("official lark-cli output exceeded the bounded limit")); return; }
      target.push(Buffer.from(chunk));
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    const timeout = setTimeout(() => terminate(new Error("official lark-cli config bind timed out")), timeoutMs);
    timeout.unref?.();
    const abort = (): void => terminate(new Error("official lark-cli config bind cancelled"));
    if (dependencies.signal?.aborted) abort();
    else dependencies.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      dependencies.signal?.removeEventListener("abort", abort);
      dependencies.onChild?.(null);
      reject(error);
    });
    child.once("exit", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      dependencies.signal?.removeEventListener("abort", abort);
      dependencies.onChild?.(null);
      if (failure) { reject(failure); return; }
      resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

export function installRuntimeCommandShims(agent: Pick<RuntimeAgentConfig, "stateDir">): string {
  const stateDir = path.resolve(agent.stateDir);
  const commandDir = path.join(stateDir, "runtime-bin");
  assertSecureRuntimeCommandDirectory(commandDir);
  const standalone = process.env.LARKIN_STANDALONE === "1";
  const binaryEntry = fileURLToPath(new URL("./binary-entry.mjs", import.meta.url));
  for (const [name, argumentsPrefix] of [["larkin", standalone ? [] : [binaryEntry]]] as const) {
    const file = path.join(commandDir, name);
    const temporary = path.join(commandDir, `.${name}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const command = [process.execPath, ...argumentsPrefix].map(shellQuote).join(" ");
    fs.writeFileSync(temporary, `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o700, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o700);
  }
  return commandDir;
}

function sourceProjection(agent: RuntimeAgentConfig, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const configDir = path.resolve(env.LARKIN_CONFIG_DIR || "");
  if (!configDir) throw new Error("LARKIN_CONFIG_DIR required for lark-channel source projection");
  const provider = internalCommandSpec("lark-channel-secret", [], {
    ...env,
    LARKIN_BINARY_ENTRY_PATH: fileURLToPath(new URL("./binary-entry.mjs", import.meta.url)),
  });
  return {
    credentialRevision: agent.credentialRevision,
    accounts: { app: {
      id: agent.feishuAppId,
      secret: { source: "exec", provider: "larkin-bot-credential", id: agent.feishuAppId },
      tenant: agent.feishuDomain === "https://open.larksuite.com" ? "lark" : "feishu",
    } },
    secrets: { providers: { "larkin-bot-credential": {
      source: "exec", command: provider.command, args: provider.args,
      noOutputTimeoutMs: 5_000, maxOutputBytes: 16 * 1024, jsonOnly: true,
      env: {
        LARKIN_CONFIG_DIR: configDir,
        LARKIN_AGENT_ID: agent.agentId,
        LARKIN_SECRET_PROVIDER_CONTEXT: "bind",
      },
    } } },
  };
}

function validateSourceProjection(file: string, agent: Pick<RuntimeAgentConfig, "agentId" | "feishuAppId" | "credentialRevision">): void {
  const snapshot = captureProfileSnapshot(file);
  if (!snapshot) throw new Error(`Agent ${agent.agentId} lark-channel source projection missing`);
  const root = snapshot.value as Record<string, any>;
  const app = root.accounts?.app;
  const provider = root.secrets?.providers?.["larkin-bot-credential"];
  if (app?.id !== agent.feishuAppId || app?.secret?.source !== "exec"
      || app?.secret?.provider !== "larkin-bot-credential" || app?.secret?.id !== agent.feishuAppId) {
    throw new Error(`Agent ${agent.agentId} lark-channel source projection identity mismatch`);
  }
  if (provider?.source !== "exec" || typeof provider.command !== "string" || !path.isAbsolute(provider.command)
      || !Array.isArray(provider.args) || provider.env?.LARKIN_AGENT_ID !== agent.agentId
      || provider.env?.LARKIN_SECRET_PROVIDER_CONTEXT !== "bind") {
    throw new Error(`Agent ${agent.agentId} lark-channel source projection provider invalid`);
  }
  if (JSON.stringify(snapshot.value).includes("appSecret")) throw new Error("lark-channel source projection 不得包含 plaintext secret 字段");
  if (root.credentialRevision !== agent.credentialRevision) throw new Error(`Agent ${agent.agentId} lark-channel credential revision mismatch`);
}

export function syncAgentProfile(
  agent: RuntimeAgentConfig,
  env: NodeJS.ProcessEnv,
  dependencies: RuntimeAgentConfigDependencies = {},
): void {
  const expected = path.join(path.resolve(env.LARKIN_CONFIG_DIR || ""), "state", "agents", agent.agentId, "lark-cli-config");
  if (path.resolve(agent.larkConfigDir) !== expected) throw new Error("lark-cli profile 路径不是 canonical contained 路径");
  fs.mkdirSync(expected, { recursive: true, mode: 0o700 });
  assertSecureProfileDirectory(expected);
  const sourceFile = larkChannelSourceConfigPath(agent);
  const sourceDir = path.dirname(sourceFile);
  fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  assertSecureProfileDirectory(sourceDir);
  const lock = acquireProcessLock(
    path.join(expected, ".larkin-profile-sync.lock.json"),
    path.basename(process.argv[1] || "node"),
  );
  const workspaceFile = larkChannelWorkspaceConfigPath(agent);
  const stagedSource = path.join(sourceDir, `.config.${process.pid}.${crypto.randomUUID()}.bind-source`);
  try {
    // Parse/security failures are pre-bind failures; a merely stale valid state may be rebound.
    captureProfileSnapshot(sourceFile);
    captureProfileSnapshot(workspaceFile);
    fs.writeFileSync(stagedSource, `${JSON.stringify(sourceProjection(agent, env), null, 2)}\n`, { mode: 0o600, flag: "wx" });
    validateSourceProjection(stagedSource, agent);
    installRuntimeCommandShims(agent);
    if (!dependencies.forceRebind) {
      try {
        validateSourceProjection(sourceFile, agent);
        const existingWorkspace = captureProfileSnapshot(workspaceFile);
        if (!existingWorkspace) throw new Error("workspace missing");
        validateExclusiveBotProfile(existingWorkspace, agent);
        assertAgentWorkspaceBound(agent);
        return;
      } catch { /* stale, absent, or mismatched state requires exactly one bind */ }
    }
    const profileEnv = { ...managedLarkCliEnv(agent, env), LARK_CHANNEL_CONFIG: stagedSource };
    try {
      const official = dependencies.resolveOfficialCli?.(profileEnv) ?? resolveOfficialLarkCli({ env: profileEnv });
      const sync = runOfficialLarkCli(official, ["config", "bind", "--source", "lark-channel", "--identity", "bot-only"], {
        encoding: "utf8", env: profileEnv,
      }, dependencies);
      if (sync.status !== 0 || sync.error) throw officialFailure(`Agent ${agent.agentId} lark-channel bind`, sync, agent.feishuAppSecret);
      const workspace = captureProfileSnapshot(workspaceFile);
      if (!workspace) throw new Error(`Agent ${agent.agentId} lark-channel workspace config missing`);
      validateExclusiveBotProfile(workspace, agent);
      atomicPublishProfile(sourceFile, fs.readFileSync(stagedSource), 0o600);
      assertAgentWorkspaceBound(agent);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Agent ${agent.agentId} lark-channel bind failed`;
      throw new Error(`${message}；官方 bind/keychain 结果未被证明可回滚，当前 Agent 保持 fail-closed，请重跑 larkin setup`);
    }
  } finally {
    try { fs.unlinkSync(stagedSource); } catch { /* renamed/absent */ }
    lock.release();
  }
}

/** Async setup-only profile sync. Existing runtime callers retain the synchronous contract above. */
export async function syncAgentProfileAsync(
  agent: RuntimeAgentConfig,
  env: NodeJS.ProcessEnv,
  dependencies: AsyncRuntimeAgentConfigDependencies = {},
): Promise<void> {
  const expected = path.join(path.resolve(env.LARKIN_CONFIG_DIR || ""), "state", "agents", agent.agentId, "lark-cli-config");
  if (path.resolve(agent.larkConfigDir) !== expected) throw new Error("lark-cli profile 路径不是 canonical contained 路径");
  fs.mkdirSync(expected, { recursive: true, mode: 0o700 });
  assertSecureProfileDirectory(expected);
  const sourceFile = larkChannelSourceConfigPath(agent);
  const sourceDir = path.dirname(sourceFile);
  fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  assertSecureProfileDirectory(sourceDir);
  const lock = acquireProcessLock(path.join(expected, ".larkin-profile-sync.lock.json"), path.basename(process.argv[1] || "node"));
  const workspaceFile = larkChannelWorkspaceConfigPath(agent);
  const stagedSource = path.join(sourceDir, `.config.${process.pid}.${crypto.randomUUID()}.bind-source`);
  try {
    captureProfileSnapshot(sourceFile);
    captureProfileSnapshot(workspaceFile);
    fs.writeFileSync(stagedSource, `${JSON.stringify(sourceProjection(agent, env), null, 2)}\n`, { mode: 0o600, flag: "wx" });
    validateSourceProjection(stagedSource, agent);
    installRuntimeCommandShims(agent);
    if (!dependencies.forceRebind) {
      try {
        validateSourceProjection(sourceFile, agent);
        const existingWorkspace = captureProfileSnapshot(workspaceFile);
        if (!existingWorkspace) throw new Error("workspace missing");
        validateExclusiveBotProfile(existingWorkspace, agent);
        assertAgentWorkspaceBound(agent);
        return;
      } catch { /* stale, absent, or mismatched state requires exactly one bind */ }
    }
    const profileEnv = { ...managedLarkCliEnv(agent, env), LARK_CHANNEL_CONFIG: stagedSource };
    try {
      const official = dependencies.resolveOfficialCli?.(profileEnv) ?? resolveOfficialLarkCli({ env: profileEnv });
      const result = await runOfficialLarkCliAsync(official,
        ["config", "bind", "--source", "lark-channel", "--identity", "bot-only"], profileEnv, dependencies);
      if (result.status !== 0) {
        const stderr = result.stderr.replaceAll(agent.feishuAppSecret, "<redacted>").trim().slice(0, 400);
        throw new Error(`Agent ${agent.agentId} lark-channel bind failed (exit=${result.status ?? "none"})${stderr ? `: ${stderr}` : ""}`);
      }
      const workspace = captureProfileSnapshot(workspaceFile);
      if (!workspace) throw new Error(`Agent ${agent.agentId} lark-channel workspace config missing`);
      validateExclusiveBotProfile(workspace, agent);
      atomicPublishProfile(sourceFile, fs.readFileSync(stagedSource), 0o600);
      assertAgentWorkspaceBound(agent);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Agent ${agent.agentId} lark-channel bind failed`;
      throw new Error(`${message}；官方 bind/keychain 结果未被证明可回滚，当前 Agent 保持 fail-closed，请重跑 larkin setup`);
    }
  } finally {
    try { fs.unlinkSync(stagedSource); } catch { /* renamed/absent */ }
    lock.release();
  }
}
