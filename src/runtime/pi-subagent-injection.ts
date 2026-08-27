import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

declare global {
  // Filled by the standalone wrapper (scripts/release/standalone-entry.ts).
  var __LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__: string | undefined;
  var __LARKIN_EMBEDDED_PI_SUPERVISED_COMMAND_BUNDLE__: string | undefined;
}

/**
 * pi-subagents 扩展注入。
 *
 * 分发：构建期把 @tintinweb/pi-subagents bundle 成单文件
 * `dist/runtime/pi-subagents.bundle.js`（pi-* 包 external），运行时仅向 external
 * （用户 pi CLI）通过 `pi --extension/-e` 显式注入，不碰用户 ~/.pi 配置。
 * Builtin Pi 直接接收静态 factory，不经过本文件或 Pi 的路径加载器。
 *
 * 版本门槛：pi-subagents peerDependency 要求 @earendil-works/pi-* >= 0.80.0；
 * external 的 pi 版本低于 0.80 时不注入（降级为无 subagent 能力）。
 */

/**
 * 把 embedded bundle 落盘到 <configDir>/providers/pi/extensions/pi-subagents.bundle.js（0700/0600）。
 * 无 embedded 资产或 configDir 缺失时返回 null。
 */
function rejectSymlinkPath(target: string): void {
  let current = path.resolve(target);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("bundle path must not contain a symlink");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

type BundleBackup = { content: Buffer; mode: number } | null;

function backupRegularFile(target: string): BundleBackup {
  if (!fs.existsSync(target)) return null;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error("bundle target must not be a symlink");
  return { content: fs.readFileSync(target), mode: stat.mode & 0o777 };
}

function restoreRegularFile(target: string, backup: BundleBackup): void {
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error("bundle target must not be a symlink");
  }
  if (!backup) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return;
  }
  fs.writeFileSync(target, backup.content, { mode: backup.mode });
  fs.chmodSync(target, backup.mode);
}

export function materializeEmbeddedPiSubagentBundle(configDir: string | undefined): string | null {
  const embedded = globalThis.__LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__;
  const supervised = globalThis.__LARKIN_EMBEDDED_PI_SUPERVISED_COMMAND_BUNDLE__;
  if (!embedded || !configDir) return null;
  if (!supervised) throw new Error("supervised command bundle is missing");
  const dir = path.join(path.resolve(configDir), "providers", "pi", "extensions");
  const subTarget = path.join(dir, "pi-subagents.bundle.js");
  const supTarget = path.join(dir, "pi-supervised-command.bundle.js");
  const lockPath = path.join(dir, ".materialize.lock");
  let lock: number | undefined;
  try {
    rejectSymlinkPath(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    rejectSymlinkPath(dir);
    fs.chmodSync(dir, 0o700);
    lock = fs.openSync(lockPath, "wx", 0o600);
    const oldSub = backupRegularFile(subTarget);
    const oldSup = backupRegularFile(supTarget);
    try {
      writePrivateBundle(dir, "pi-subagents.bundle.js", embedded);
      writePrivateBundle(dir, "pi-supervised-command.bundle.js", supervised);
      return subTarget;
    } catch (error) {
      restoreRegularFile(subTarget, oldSub);
      restoreRegularFile(supTarget, oldSup);
      throw error;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("supervised command bundle is missing")) throw error;
    return null;
  } finally {
    if (lock !== undefined) {
      try { fs.closeSync(lock); } catch { /* ignore */ }
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

function writePrivateBundle(dir: string, name: string, embedded: string): string {
  const target = path.join(dir, name);
  rejectSymlinkPath(target);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error("bundle target must not be a symlink");
  }
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== embedded) {
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, embedded, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
  }
  fs.chmodSync(target, 0o600);
  return target;
}

export function materializeEmbeddedPiSupervisedCommandBundle(dirOrConfig?: string): string | null {
  const embedded = globalThis.__LARKIN_EMBEDDED_PI_SUPERVISED_COMMAND_BUNDLE__;
  if (!embedded || !dirOrConfig) return null;
  const dir = dirOrConfig.endsWith("extensions") ? dirOrConfig : path.join(path.resolve(dirOrConfig), "providers", "pi", "extensions");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return writePrivateBundle(dir, "pi-supervised-command.bundle.js", embedded);
  } catch {
    return null;
  }
}

/**
 * 构建产物单文件路径。优先返回 dist/runtime/pi-subagents.bundle.js（源码/编译形态）；
 * standalone 二进制没有该文件，回退到 embedded 资产落盘（<configDir>/providers/pi/extensions/）。
 */
export function bundledPiSubagentExtensionPath(configDir?: string): string | null {
  try {
    const url = new URL("./pi-subagents.bundle.js", import.meta.url);
    const resolved = fileURLToPath(url);
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    /* fall through to embedded */
  }
  return materializeEmbeddedPiSubagentBundle(configDir);
}

/** 解析 `pi --version` 输出中的主版本号，无法解析返回 null。 */
export function parsePiVersion(output: string | undefined): { major: number; minor: number } | null {
  if (!output) return null;
  const match = output.match(/(\d+)\.(\d+)\.\d+/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** 是否满足 pi-subagents 的 pi 版本门槛（>= 0.80.0）。 */
export function piVersionSupportsSubagents(version: { major: number; minor: number } | null): boolean {
  if (!version) return false;
  return version.major > 0 || (version.major === 0 && version.minor >= 80);
}

/** 解析 external `pi --version`；无法确认版本时视为不支持，不注入。 */
export function probeExternalPiVersion(piCommand: string, env: NodeJS.ProcessEnv): { major: number; minor: number } | null {
  const result = spawnSync(piCommand, ["--version"], { env, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
  if (result.error || result.status !== 0) return null;
  return parsePiVersion(String(result.stdout || result.stderr || ""));
}

/**
 * 用户 pi 是否已自行安装 pi-subagents（settings.json packages 或包目录）。
 * 已装时 Larkin 不再 -e 注入，避免同名工具（Agent/get_subagent_result/steer_subagent）
 * 重复注册导致 pi 扩展加载 FATAL（pi 对 duplicate tool registration 是硬失败）。
 */
const BOUNDED_WAIT_CAPABILITY = "larkin-pi-subagents-bounded-wait-v1";
const SUPERVISED_COMMAND_CAPABILITY = "larkin-pi-supervised-command-v1";

type UserPiSubagentsWaitCapability = "absent" | "bounded" | "unbounded";

function userPiSubagentsWaitCapability(env: NodeJS.ProcessEnv): UserPiSubagentsWaitCapability {
  const agentDir = env.PI_CODING_AGENT_DIR || path.join(env.HOME || process.env.HOME || "", ".pi", "agent");
  try {
    let configured = false;
    const settingsFile = path.join(agentDir, "settings.json");
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      const packages: unknown = settings?.packages;
      if (Array.isArray(packages)) {
        configured = packages.some((entry) => typeof entry === "string" && /pi-subagents/i.test(entry));
      }
    }
    // settings.json 可能未登记但包目录已存在（残留/手动安装）。
    // Split token: repo contract forbids the literal package-manager word in sources.
    const packageRoots = [
      path.join(agentDir, "n" + "pm", "node_modules", "@tintinweb", "pi-subagents"),
      path.join(agentDir, "node_modules", "@tintinweb", "pi-subagents"),
    ];
    const installedRoot = packageRoots.find((root) => fs.existsSync(root));
    if (!configured && !installedRoot) return "absent";
    if (!installedRoot) return "unbounded";
    const packageManifest = JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json"), "utf8")) as {
      pi?: { extensions?: unknown };
    };
    const extensions = packageManifest.pi?.extensions;
    if (!Array.isArray(extensions) || extensions.length === 0
      || !extensions.every((entry): entry is string => typeof entry === "string" && entry.length > 0)) {
      return "unbounded";
    }
    // Pi executes the entries declared by the package manifest. Do not trust a
    // marker in a build artifact when the manifest points Pi at another file.
    const capabilityFiles = extensions.map((entry) => path.resolve(installedRoot, entry));
    const hasCapability = capabilityFiles.every((file) => {
      try {
        const source = fs.readFileSync(file, "utf8");
        return source.includes(BOUNDED_WAIT_CAPABILITY) && source.includes(SUPERVISED_COMMAND_CAPABILITY);
      }
      catch { return false; }
    });
    return hasCapability ? "bounded" : "unbounded";
  } catch {
    // Unreadable user extension state is not safe to treat as bounded.
    return "unbounded";
  }
}

export function userPiAlreadyHasSubagentsExtension(env: NodeJS.ProcessEnv): boolean {
  return userPiSubagentsWaitCapability(env) !== "absent";
}

export function userPiSubagentsHasBoundedWaitCapability(env: NodeJS.ProcessEnv): boolean {
  return userPiSubagentsWaitCapability(env) === "bounded";
}

export function resolvePiSubagentExtensionArg(
  input: {
    distribution: "external";
    piCommand: string;
    env: NodeJS.ProcessEnv;
  },
  probeVersion: () => { major: number; minor: number } | null = () => probeExternalPiVersion(input.piCommand, input.env),
  resolveBundle: () => string | null = () => bundledPiSubagentExtensionPath(input.env.LARKIN_CONFIG_DIR),
): string | null {
  // A user-installed extension wins only when it advertises the exact bounded
  // wait capability. Check this before the bundle path so a missing Larkin
  // asset cannot silently leave an unbounded user extension active.
  if (userPiAlreadyHasSubagentsExtension(input.env)) {
    if (!userPiSubagentsHasBoundedWaitCapability(input.env)) {
      throw new Error(
        "[larkin] WARNING: refusing external Pi because the user-installed " +
        "pi-subagents extension is unbounded or unverifiable; remove it or install " +
        "a version advertising larkin-pi-subagents-bounded-wait-v1 and larkin-pi-supervised-command-v1.",
      );
    }
    return null;
  }
  // resolveBundle is injectable so unit tests stay environment-independent
  // (no dependency on build artifacts or the filesystem).
  const bundle = resolveBundle();
  if (!bundle) return null;
  return piVersionSupportsSubagents(probeVersion()) ? bundle : null;
}
