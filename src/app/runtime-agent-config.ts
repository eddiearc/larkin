import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
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

export interface RuntimeAgentConfig extends HydratedAgent {
  feishuAppSecret: string;
  feishuDomain: "https://open.feishu.cn" | "https://open.larksuite.com";
}

interface LarkCliConfig { apps?: Array<Record<string, unknown>>; [key: string]: unknown }
interface ProfileSnapshot {
  value: LarkCliConfig;
  raw: Buffer;
  mode: number;
}

export interface PinnedLarkCliCommand {
  command: string;
  argsPrefix: string[];
}

export interface RuntimeAgentConfigDependencies {
  runPinnedCli?(command: PinnedLarkCliCommand, args: readonly string[], options: Parameters<typeof spawnSync>[2]): ReturnType<typeof spawnSync>;
}

declare global {
  // Set only by the generated standalone compile wrapper to a Bun embedded-file path.
  // Regular source/install builds resolve the exact package dependency instead.
  var __LARKIN_EMBEDDED_LARK_CLI__: string | undefined;
}

const PINNED_LARK_CLI_VERSION = "1.0.78";

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

function atomicRestoreProfile(file: string, bytes: Buffer | string, mode = 0o600): void {
  const directory = path.dirname(file);
  assertSecureProfileDirectory(directory);
  const canonical = path.join(path.resolve(directory), "config.json");
  if (path.resolve(file) !== canonical || path.basename(file) !== "config.json") {
    throw new Error("lark-cli config 恢复路径无效");
  }
  const temporary = path.join(directory, `.config.${process.pid}.${crypto.randomUUID()}.rollback-recovery`);
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
    throw new Error(`${error instanceof Error ? error.message : String(error)}；原始恢复快照保留于 ${temporary}`);
  }
}

function restoreAbsentProfile(file: string): void {
  assertSecureProfileDirectory(path.dirname(file));
  try {
    const stat = fs.lstatSync(file);
    if ((!stat.isFile() && !stat.isSymbolicLink())
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("拒绝删除不安全的 lark-cli config 路径");
    }
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function restoreExactProfile(file: string, before: ProfileSnapshot | null): void {
  if (before) atomicRestoreProfile(file, before.raw, before.mode);
  else restoreAbsentProfile(file);
}

function containsUserToken(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUserToken);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    (/token/i.test(key) && nested !== null && nested !== "" && nested !== undefined) || containsUserToken(nested));
}

function validStoredAppSecret(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reference = value as { source?: unknown; id?: unknown };
  return reference.source === "keychain" && typeof reference.id === "string" && !!reference.id;
}

function validateExclusiveBotProfile(snapshot: ProfileSnapshot, agent: RuntimeAgentConfig): void {
  const apps = snapshot.value.apps;
  if (!Array.isArray(apps) || apps.length !== 1) throw new Error("lark-cli profile 必须只包含当前 Agent App");
  const app = apps[0];
  if (app.appId !== agent.feishuAppId || (app.name !== undefined && app.name !== agent.feishuAppId)) {
    throw new Error("lark-cli profile App identity 与当前 Agent 不一致");
  }
  if (!validStoredAppSecret(app.appSecret, agent.feishuAppSecret)) throw new Error("lark-cli profile App Secret 写入不完整");
  if (app.defaultAs !== "bot" || app.strictMode !== "bot") throw new Error("lark-cli profile 未锁定 default-as bot / strict-mode bot");
  if (!Array.isArray(app.users) || app.users.length !== 0) throw new Error("lark-cli profile 不得保留 user identity");
  if (containsUserToken(snapshot.value)) throw new Error("lark-cli profile 不得保留 user token");
}

function hasExactStagedCredential(snapshot: ProfileSnapshot | null, agent: RuntimeAgentConfig): boolean {
  const apps = snapshot?.value.apps;
  if (!Array.isArray(apps) || apps.length !== 1) return false;
  const app = apps[0];
  return app.appId === agent.feishuAppId && validStoredAppSecret(app.appSecret, agent.feishuAppSecret)
    && (app.name === undefined || app.name === agent.feishuAppId);
}

export function hydrateRuntimeAgent(configDir: string, agent: HydratedAgent): RuntimeAgentConfig {
  const botsDir = path.join(configDir, "bots");
  assertSecureBotsDirectory(botsDir);
  const record = readSecureBotCredential(botsDir, agent.feishuAppId);
  if (!validCredentialRecord(record, agent.feishuAppId)) {
    throw new Error(`Agent ${agent.agentId} 的 bot 凭证无效或与 App ID 不一致`);
  }
  const credential = record as BotCredentialRecord;
  return {
    ...agent,
    feishuAppSecret: credential.appSecret,
    feishuDomain: credential.tenant === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn",
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

function materializeEmbeddedLarkCli(stateDir: string): string {
  const embedded = globalThis.__LARKIN_EMBEDDED_LARK_CLI__;
  if (!embedded) throw new Error("standalone artifact 缺少内嵌的固定 lark-cli");
  const commandDir = path.join(path.resolve(stateDir), "runtime-bin");
  assertSecureRuntimeCommandDirectory(commandDir);
  const executable = path.join(commandDir, `lark-cli-native-${PINNED_LARK_CLI_VERSION}`);
  const bytes = fs.readFileSync(embedded);
  const expectedHash = crypto.createHash("sha256").update(bytes).digest("hex");
  try {
    const stat = fs.lstatSync(executable);
    if (!stat.isFile() || stat.isSymbolicLink()
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("standalone lark-cli materialization 路径不安全");
    }
    const actualHash = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
    if (actualHash === expectedHash) {
      fs.chmodSync(executable, 0o700);
      return executable;
    }
    throw new Error("standalone lark-cli materialization 内容校验失败");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(commandDir, `.lark-cli-native.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, bytes, { mode: 0o700, flag: "wx" });
  fs.renameSync(temporary, executable);
  fs.chmodSync(executable, 0o700);
  return executable;
}

export function resolvePinnedLarkCliCommand(stateDir: string): PinnedLarkCliCommand {
  if (process.env.LARKIN_STANDALONE === "1") {
    return { command: materializeEmbeddedLarkCli(stateDir), argsPrefix: [] };
  }
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve("@larksuite/cli/package.json");
  const manifest = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { version?: string };
  if (manifest.version !== PINNED_LARK_CLI_VERSION) throw new Error("package-local lark-cli 版本与 Runtime contract 不一致");
  return { command: process.execPath, argsPrefix: [path.join(path.dirname(packageFile), "scripts", "run.js")] };
}

function runPinnedLarkCli(
  command: PinnedLarkCliCommand,
  args: readonly string[],
  options: Parameters<typeof spawnSync>[2],
  dependencies: RuntimeAgentConfigDependencies,
): ReturnType<typeof spawnSync> {
  return dependencies.runPinnedCli
    ? dependencies.runPinnedCli(command, args, options)
    : spawnSync(command.command, [...command.argsPrefix, ...args], options);
}

function pinnedFailure(label: string, result: ReturnType<typeof spawnSync>, secret: string): Error {
  const stderr = String(result.stderr || "").replaceAll(secret, "<redacted>").trim().slice(0, 400);
  const detail = [result.error?.message, stderr].filter(Boolean).join(": ");
  return new Error(`${label} failed (exit=${result.status ?? "none"})${detail ? `: ${detail}` : ""}`);
}

export function installRuntimeCommandShims(agent: Pick<RuntimeAgentConfig, "stateDir">): string {
  const stateDir = path.resolve(agent.stateDir);
  const commandDir = path.join(stateDir, "runtime-bin");
  assertSecureRuntimeCommandDirectory(commandDir);
  const standalone = process.env.LARKIN_STANDALONE === "1";
  const binaryEntry = fileURLToPath(new URL("./binary-entry.mjs", import.meta.url));
  for (const [name, argumentsPrefix] of [
    ["larkin", standalone ? [] : [binaryEntry]],
    ["lark-cli", standalone ? ["__internal", "lark-cli"] : [binaryEntry, "__internal", "lark-cli"]],
  ] as const) {
    const file = path.join(commandDir, name);
    const temporary = path.join(commandDir, `.${name}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const command = [process.execPath, ...argumentsPrefix].map(shellQuote).join(" ");
    fs.writeFileSync(temporary, `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o700, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o700);
  }
  return commandDir;
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
  const lock = acquireProcessLock(
    path.join(expected, ".larkin-profile-sync.lock.json"),
    path.basename(process.argv[1] || "node"),
  );
  const tenant = agent.feishuDomain === "https://open.larksuite.com" ? "lark" : "feishu";
  const configFile = path.join(expected, "config.json");
  const stagingDir = path.join(expected, `.larkin-profile-stage-${process.pid}-${crypto.randomUUID()}`);
  try {
    // Existing bytes are parsed before any command and remain the exact rollback source.
    const before = captureProfileSnapshot(configFile);
    const pinned = resolvePinnedLarkCliCommand(agent.stateDir);
    fs.mkdirSync(stagingDir, { mode: 0o700 });
    const profileEnv = { ...env, LARKSUITE_CLI_CONFIG_DIR: stagingDir };
    let stage: "sync" | "default-as" | "strict-mode" | "validate" | "publish" | "shims" = "sync";
    let published = false;
    try {
      const sync = runPinnedLarkCli(pinned, ["config", "init", "--app-id", agent.feishuAppId, "--app-secret-stdin", "--brand", tenant, "--name", agent.feishuAppId], {
        input: agent.feishuAppSecret, encoding: "utf8", env: profileEnv,
      }, dependencies);
      if (sync.status !== 0 || sync.error) {
        // Native 1.0.78 persists an exact local credential before its optional
        // remote validation. Startup's real channel remains the credential
        // authority; accept the local write only when its bytes are exact.
        const local = captureProfileSnapshot(path.join(stagingDir, "config.json"));
        if (!hasExactStagedCredential(local, agent)) {
          throw pinnedFailure(`Agent ${agent.agentId} profile sync`, sync, agent.feishuAppSecret);
        }
      }
      stage = "default-as";
      const defaultAs = runPinnedLarkCli(pinned, ["--profile", agent.feishuAppId, "config", "default-as", "bot"], {
        encoding: "utf8", env: profileEnv,
      }, dependencies);
      if (defaultAs.status !== 0 || defaultAs.error) throw pinnedFailure(`Agent ${agent.agentId} profile default-as`, defaultAs, agent.feishuAppSecret);
      stage = "strict-mode";
      const strictMode = runPinnedLarkCli(pinned, ["--profile", agent.feishuAppId, "config", "strict-mode", "bot"], {
        encoding: "utf8", env: profileEnv,
      }, dependencies);
      if (strictMode.status !== 0 || strictMode.error) throw pinnedFailure(`Agent ${agent.agentId} profile strict-mode`, strictMode, agent.feishuAppSecret);
      stage = "validate";
      const staged = captureProfileSnapshot(path.join(stagingDir, "config.json"));
      if (!staged) throw new Error(`Agent ${agent.agentId} profile config missing`);
      validateExclusiveBotProfile(staged, agent);
      stage = "publish";
      atomicRestoreProfile(configFile, staged.raw, 0o600);
      published = true;
      const publishedSnapshot = captureProfileSnapshot(configFile);
      if (!publishedSnapshot) throw new Error(`Agent ${agent.agentId} published profile missing`);
      validateExclusiveBotProfile(publishedSnapshot, agent);
      stage = "shims";
      installRuntimeCommandShims(agent);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Agent ${agent.agentId} profile ${stage} failed`;
      try { if (published) restoreExactProfile(configFile, before); }
      catch (restoreError) {
        throw new Error(`${message}；profile 恢复失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
      throw new Error(`${message}${published ? "；已恢复此前 profile" : "；原 profile 未变更"}`);
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  } finally {
    lock.release();
  }
}
