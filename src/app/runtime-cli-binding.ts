import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { internalCommandSpec } from "./internal-command.js";

export const RUNTIME_CLI_PROTOCOL = 1;
export const DEFAULT_LARK_CLI_PACKAGE_SPEC = "@larksuite/cli@latest";
export const RUNTIME_CLI_DESCRIPTOR_ENV = "LARK_CLI_RUNTIME_DELEGATE";
export const RUNTIME_CLI_PROTOCOL_ENV = "LARK_CLI_RUNTIME_PROTOCOL";
export const RUNTIME_CLI_BOUND_ENV = "LARK_CLI_RUNTIME_BOUND";
export const RUNTIME_CLI_NATIVE_EXECUTABLE_ENV = "LARK_CLI_RUNTIME_NATIVE_EXECUTABLE";
export const RUNTIME_CLI_NATIVE_VERSION_ENV = "LARK_CLI_RUNTIME_NATIVE_VERSION";

interface GlobalCliRecord { protocolVersion: number; version: string; executable: string }
interface BindingContext { agentId: string; stateDir: string; larkConfigDir: string; nativeCli: string; nativeVersion: string }
interface BindingDescriptor {
  protocolVersion: number;
  bindingId: string;
  delegate: string;
  delegateArgs: string[];
  context: BindingContext;
}

export interface RuntimeCliBinding {
  descriptor: string;
  bindingId: string;
  nativeCli: string;
  nativeVersion: string;
  env: NodeJS.ProcessEnv;
}

export interface GlobalCliDependencies {
  spawn?: typeof spawnSync;
  shell?: string;
  env?: NodeJS.ProcessEnv;
}

function assertOwnedDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o077) !== 0) {
    throw new Error(`不安全的 Runtime CLI 目录: ${directory}`);
  }
}

function assertOwnedRegular(file: string, privateFile = false): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (privateFile && (stat.mode & 0o077) !== 0)
      || (!privateFile && (stat.mode & 0o022) !== 0)) {
    throw new Error(`不安全的 Runtime CLI 文件: ${file}`);
  }
}

function atomicPrivateJson(file: string, value: unknown): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertOwnedDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function shellProbe(dependencies: GlobalCliDependencies = {}): GlobalCliRecord | null {
  const env = dependencies.env ?? process.env;
  const shell = dependencies.shell || env.SHELL || "/bin/sh";
  const run = dependencies.spawn ?? spawnSync;
  const marker = "__LARKIN_CLI_PATH__";
  const script = `p=$(command -v lark-cli 2>/dev/null) || exit 127\nprintf '${marker}%s\\n' "$p"\nexec "$p" __runtime-delegate-capabilities`;
  const result = run(shell, ["-lc", script], { encoding: "utf8", env });
  if (result.status !== 0 || result.error) return null;
  const lines = String(result.stdout || "").split(/\r?\n/);
  const rawPath = lines.find((line) => line.startsWith(marker))?.slice(marker.length);
  const capabilityLine = [...lines].reverse().find((line) => line.trim().startsWith("{"));
  if (!rawPath || !capabilityLine) return null;
  let capability: { version?: unknown; runtimeDelegateProtocol?: unknown };
  try { capability = JSON.parse(capabilityLine) as typeof capability; } catch { return null; }
  if (capability.runtimeDelegateProtocol !== RUNTIME_CLI_PROTOCOL
      || typeof capability.version !== "string" || !capability.version.trim()) return null;
  let executable: string;
  try { executable = fs.realpathSync(rawPath); } catch { return null; }
  assertOwnedRegular(executable);
  return { protocolVersion: RUNTIME_CLI_PROTOCOL, version: capability.version, executable };
}

function globalRecordFile(configDir: string): string {
  return path.join(path.resolve(configDir), "runtime", "lark-cli.json");
}

export function ensureCompatibleGlobalLarkCli(
  configDir: string,
  dependencies: GlobalCliDependencies = {},
): GlobalCliRecord {
  let record = shellProbe(dependencies);
  if (!record) {
    const run = dependencies.spawn ?? spawnSync;
    const packageSpec = process.env.LARKIN_LARK_CLI_PACKAGE_SPEC || DEFAULT_LARK_CLI_PACKAGE_SPEC;
    const install = run("npm", ["install", "-g", packageSpec], {
      encoding: "utf8", env: dependencies.env ?? process.env,
    });
    if (install.status !== 0 || install.error) {
      throw new Error(`全局 lark-cli 安装失败（exit=${install.status ?? "none"}）`);
    }
    record = shellProbe(dependencies);
  }
  if (!record) throw new Error("真实用户 shell 中的 lark-cli 缺少兼容 Runtime delegate capability");
  atomicPrivateJson(globalRecordFile(configDir), record);
  return record;
}

export function readCompatibleGlobalLarkCli(configDir: string): GlobalCliRecord {
  const file = globalRecordFile(configDir);
  assertOwnedRegular(file, true);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as GlobalCliRecord;
  if (record.protocolVersion !== RUNTIME_CLI_PROTOCOL || typeof record.version !== "string" || !record.version.trim()
      || !path.isAbsolute(record.executable)) {
    throw new Error("setup 记录的全局 lark-cli 不兼容；请重新运行 larkin setup");
  }
  const canonical = fs.realpathSync(record.executable);
  if (canonical !== record.executable) throw new Error("setup 记录的全局 lark-cli 已改变；请重新运行 larkin setup");
  assertOwnedRegular(canonical);
  const probe = spawnSync(canonical, ["__runtime-delegate-capabilities"], { encoding: "utf8", env: process.env });
  let capability: { version?: unknown; runtimeDelegateProtocol?: unknown } = {};
  try { capability = JSON.parse(String(probe.stdout || "").trim()) as typeof capability; } catch { /* fail closed below */ }
  if (probe.status !== 0 || capability.runtimeDelegateProtocol !== RUNTIME_CLI_PROTOCOL || capability.version !== record.version) {
    throw new Error("setup 记录的全局 lark-cli capability 已改变；请重新运行 larkin setup");
  }
  return record;
}

export function assertCompatibleGlobalLarkCliInLoginShell(
  configDir: string,
  dependencies: GlobalCliDependencies = {},
): GlobalCliRecord {
  const recorded = readCompatibleGlobalLarkCli(configDir);
  const observed = shellProbe(dependencies);
  if (!observed || observed.executable !== recorded.executable || observed.version !== recorded.version
      || observed.protocolVersion !== recorded.protocolVersion) {
    throw new Error("真实用户 login shell 中的 lark-cli 与 setup 记录不一致；请重新运行 larkin setup");
  }
  return recorded;
}

function configRootFromStateDir(stateDir: string): string {
  const resolved = path.resolve(stateDir);
  return path.resolve(resolved, "..", "..", "..");
}

export function createRuntimeCliBinding(agent: {
  agentId: string; stateDir: string; larkConfigDir: string;
}, env: NodeJS.ProcessEnv = process.env, dependencies: Omit<GlobalCliDependencies, "env"> = {}): RuntimeCliBinding {
  const configDir = path.resolve(env.LARKIN_CONFIG_DIR || configRootFromStateDir(agent.stateDir));
  const canonicalState = path.join(configDir, "state", "agents", agent.agentId);
  const canonicalConfig = path.join(canonicalState, "lark-cli-config");
  if (path.resolve(agent.stateDir) !== canonicalState || path.resolve(agent.larkConfigDir) !== canonicalConfig) {
    throw new Error(`Agent ${agent.agentId} Runtime CLI 路径不一致`);
  }
  assertOwnedDirectory(canonicalState);
  assertOwnedDirectory(canonicalConfig);
  const native = assertCompatibleGlobalLarkCliInLoginShell(configDir, { ...dependencies, env });
  const bindingDir = path.join(canonicalState, "runtime-cli-binding");
  fs.mkdirSync(bindingDir, { recursive: true, mode: 0o700 });
  assertOwnedDirectory(bindingDir);
  const descriptorFile = path.join(bindingDir, "descriptor.json");
  const bindingId = crypto.randomUUID();
  const spec = internalCommandSpec("runtime-cli-delegate", [], env);
  const descriptor: BindingDescriptor = {
    protocolVersion: RUNTIME_CLI_PROTOCOL,
    bindingId,
    delegate: path.resolve(spec.command),
    delegateArgs: spec.args,
    context: { agentId: agent.agentId, stateDir: canonicalState, larkConfigDir: canonicalConfig,
      nativeCli: native.executable, nativeVersion: native.version },
  };
  assertOwnedRegular(descriptor.delegate);
  atomicPrivateJson(descriptorFile, descriptor);
  assertOwnedRegular(descriptorFile, true);
  return {
    descriptor: descriptorFile, bindingId, nativeCli: native.executable, nativeVersion: native.version,
    env: { [RUNTIME_CLI_DESCRIPTOR_ENV]: descriptorFile, [RUNTIME_CLI_PROTOCOL_ENV]: String(RUNTIME_CLI_PROTOCOL) },
  };
}

export function readRuntimeCliBinding(env: NodeJS.ProcessEnv = process.env): BindingDescriptor {
  const file = env[RUNTIME_CLI_DESCRIPTOR_ENV];
  if (!file || !path.isAbsolute(file)) throw new Error("Runtime CLI descriptor 缺失或不是绝对路径");
  assertOwnedRegular(file, true);
  const descriptor = JSON.parse(fs.readFileSync(file, "utf8")) as BindingDescriptor;
  if (descriptor.protocolVersion !== RUNTIME_CLI_PROTOCOL || !descriptor.bindingId
      || env[RUNTIME_CLI_PROTOCOL_ENV] !== String(RUNTIME_CLI_PROTOCOL)) throw new Error("Runtime CLI binding 协议不兼容");
  return descriptor;
}

export function validateRuntimeCliDelegate(env: NodeJS.ProcessEnv = process.env): BindingDescriptor {
  const descriptor = readRuntimeCliBinding(env);
  const { context } = descriptor;
  if (!context || env.LARKIN_AGENT_ID !== context.agentId) throw new Error("Runtime CLI Agent binding 不匹配");
  const configDir = path.resolve(env.LARKIN_CONFIG_DIR || configRootFromStateDir(context.stateDir));
  if (context.stateDir !== path.join(configDir, "state", "agents", context.agentId)
      || context.larkConfigDir !== path.join(context.stateDir, "lark-cli-config")) throw new Error("Runtime CLI canonical path 校验失败");
  const expectedDescriptor = path.join(context.stateDir, "runtime-cli-binding", "descriptor.json");
  if (env[RUNTIME_CLI_DESCRIPTOR_ENV] !== expectedDescriptor) throw new Error("Runtime CLI descriptor 不是 Agent canonical descriptor");
  const expectedDelegate = internalCommandSpec("runtime-cli-delegate", [], env);
  if (descriptor.delegate !== path.resolve(expectedDelegate.command)
      || JSON.stringify(descriptor.delegateArgs) !== JSON.stringify(expectedDelegate.args)) {
    throw new Error("Runtime CLI Larkin delegate 与当前可执行文件不一致");
  }
  assertOwnedDirectory(context.stateDir);
  assertOwnedDirectory(context.larkConfigDir);
  assertOwnedDirectory(path.dirname(expectedDescriptor));
  assertOwnedRegular(descriptor.delegate);
  const native = assertCompatibleGlobalLarkCliInLoginShell(configDir, { env });
  if (native.executable !== context.nativeCli || native.version !== context.nativeVersion
      || env[RUNTIME_CLI_NATIVE_EXECUTABLE_ENV] !== context.nativeCli
      || env[RUNTIME_CLI_NATIVE_VERSION_ENV] !== context.nativeVersion) {
    throw new Error("Runtime CLI native executable/version 与 setup binding 不一致");
  }
  if (env[RUNTIME_CLI_BOUND_ENV]) throw new Error("Runtime CLI delegate 重复进入或 binding marker 冲突");
  return descriptor;
}

export function assertRuntimeCliBindingReady(
  binding: RuntimeCliBinding | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!binding) throw new Error("Runtime CLI binding 缺失；请重新运行 larkin setup");
  const configDir = path.resolve(env.LARKIN_CONFIG_DIR || "");
  const descriptor = readRuntimeCliBinding({ ...env, ...binding.env });
  if (descriptor.bindingId !== binding.bindingId || descriptor.context.nativeCli !== binding.nativeCli
      || descriptor.context.nativeVersion !== binding.nativeVersion) {
    throw new Error("Runtime CLI binding descriptor 与运行配置不一致；请重新运行 larkin setup");
  }
  assertOwnedDirectory(descriptor.context.stateDir);
  assertOwnedDirectory(descriptor.context.larkConfigDir);
  assertOwnedDirectory(path.dirname(binding.descriptor));
  const observed = assertCompatibleGlobalLarkCliInLoginShell(configDir, { env });
  if (observed.executable !== binding.nativeCli || observed.version !== binding.nativeVersion) {
    throw new Error("Runtime CLI binding 与真实用户 login shell 不一致；请重新运行 larkin setup");
  }
  assertOwnedRegular(binding.descriptor, true);
}
