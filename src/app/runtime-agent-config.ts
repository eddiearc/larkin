import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

function restoreTargetProfile(file: string, appId: string, before: ProfileSnapshot | null): void {
  try {
    const current = captureProfileSnapshot(file);
    if (!current) throw new Error("current profile missing");
    const apps = Array.isArray(current.value.apps) ? current.value.apps : [];
    const retained = apps.filter((app) => String(app?.appId || "") !== appId);
    const previous = before?.value.apps?.find((app) => String(app?.appId || "") === appId);
    if (previous) retained.push(previous);
    atomicRestoreProfile(file, `${JSON.stringify({ ...current.value, apps: retained }, null, 2)}\n`, current.mode);
    return;
  } catch {
    // A truncated, malformed, missing, or unsafe current file cannot be merged.
    // Restore the exact pre-mutation bytes instead of parsing the damaged file again.
  }
  if (before) atomicRestoreProfile(file, before.raw, before.mode);
  else restoreAbsentProfile(file);
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

export function syncAgentProfile(agent: RuntimeAgentConfig, env: NodeJS.ProcessEnv): void {
  const expected = path.join(path.resolve(env.LARKIN_CONFIG_DIR || ""), "lark-cli-config");
  if (path.resolve(agent.larkConfigDir) !== expected) throw new Error("lark-cli profile 路径不是 canonical contained 路径");
  fs.mkdirSync(expected, { recursive: true, mode: 0o700 });
  assertSecureProfileDirectory(expected);
  const lock = acquireProcessLock(
    path.join(expected, ".larkin-profile-sync.lock.json"),
    path.basename(process.argv[1] || "node"),
  );
  const profileEnv = { ...env, LARKSUITE_CLI_CONFIG_DIR: expected };
  const tenant = agent.feishuDomain === "https://open.larksuite.com" ? "lark" : "feishu";
  const configFile = path.join(expected, "config.json");
  try {
    // Capture and parse before invoking lark-cli. Invalid input fails before mutation,
    // while the exact bytes remain available for corruption-safe rollback.
    const before = captureProfileSnapshot(configFile);
    let stage: "sync" | "verify" = "sync";
    try {
      const sync = spawnSync("lark-cli", ["config", "init", "--app-id", agent.feishuAppId, "--app-secret-stdin", "--brand", tenant, "--name", agent.feishuAppId], {
        input: agent.feishuAppSecret, encoding: "utf8", env: profileEnv,
      });
      if (sync.status !== 0 || sync.error) throw new Error(`Agent ${agent.agentId} profile sync failed`);
      stage = "verify";
      const verify = spawnSync("lark-cli", ["--profile", agent.feishuAppId, "im", "+chat-list", "--as", "bot"], { encoding: "utf8", env: profileEnv });
      let payload: { ok?: boolean; identity?: string } | undefined;
      try { payload = JSON.parse(verify.stdout) as typeof payload; } catch { /* invalid response */ }
      if (verify.status !== 0 || payload?.ok !== true || payload.identity !== "bot") {
        throw new Error(`Agent ${agent.agentId} profile verify failed`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `Agent ${agent.agentId} profile ${stage} failed`;
      try { restoreTargetProfile(configFile, agent.feishuAppId, before); }
      catch (restoreError) {
        throw new Error(`${message}；profile 恢复失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
      throw new Error(`${message}；已恢复此前 target profile`);
    }
  } finally {
    lock.release();
  }
}
