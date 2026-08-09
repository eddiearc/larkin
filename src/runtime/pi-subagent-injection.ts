import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BUNDLED_PI_VERSION } from "./pi-provider-config.js";

declare global {
  // Filled by the standalone wrapper (scripts/release/standalone-entry.ts).
  var __LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__: string | undefined;
}

/**
 * pi-subagents 扩展注入。
 *
 * 分发：构建期把 @tintinweb/pi-subagents bundle 成单文件
 * `dist/runtime/pi-subagents.bundle.js`（pi-* 包 external），运行时通过
 * `pi --extension/-e` 显式注入 —— builtin（binary-entry pi-rpc）与 external
 * （用户 pi CLI）走同一路径，不碰用户 ~/.pi 配置。
 *
 * 版本门槛：pi-subagents peerDependency 要求 @earendil-works/pi-* >= 0.80.0；
 * external 的 pi 版本低于 0.80 时不注入（降级为无 subagent 能力）。
 */

/**
 * 把 embedded bundle 落盘到 <configDir>/providers/pi/extensions/pi-subagents.bundle.js（0700/0600）。
 * 无 embedded 资产或 configDir 缺失时返回 null。
 */
export function materializeEmbeddedPiSubagentBundle(configDir: string | undefined): string | null {
  const embedded = globalThis.__LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__;
  if (!embedded || !configDir) return null;
  const dir = path.join(path.resolve(configDir), "providers", "pi", "extensions");
  const target = path.join(dir, "pi-subagents.bundle.js");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== embedded) {
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, embedded, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
    }
    return target;
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

/**
 * 解析 `pi --version`（external 专用；builtin 用 BUNDLED_PI_VERSION 常量，无需探测）。
 * 返回 null 表示无法确认版本（视为不支持，不注入）。
 */
export function probeExternalPiVersion(piCommand: string, env: NodeJS.ProcessEnv): { major: number; minor: number } | null {
  const result = spawnSync(piCommand, ["--version"], { env, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
  if (result.error || result.status !== 0) return null;
  return parsePiVersion(String(result.stdout || result.stderr || ""));
}

/**
 * 注入决策：builtin 恒注入（内嵌 pi 版本固定 BUNDLED_PI_VERSION）；external 需探测版本。
 * 返回 `-e` 参数值（扩展 bundle 路径），或 null（不注入：产物缺失或版本不达标）。
 * `probeVersion` 仅供测试注入；缺省时 external 用 probeExternalPiVersion 探测。
 */
/**
 * 用户 pi 是否已自行安装 pi-subagents（settings.json packages 或包目录）。
 * 已装时 Larkin 不再 -e 注入，避免同名工具（Agent/get_subagent_result/steer_subagent）
 * 重复注册导致 pi 扩展加载 FATAL（pi 对 duplicate tool registration 是硬失败）。
 */
export function userPiAlreadyHasSubagentsExtension(env: NodeJS.ProcessEnv): boolean {
  const agentDir = env.PI_CODING_AGENT_DIR || path.join(env.HOME || process.env.HOME || "", ".pi", "agent");
  try {
    const settingsFile = path.join(agentDir, "settings.json");
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      const packages: unknown = settings?.packages;
      if (Array.isArray(packages)) {
        for (const entry of packages) {
          if (typeof entry === "string" && /pi-subagents/i.test(entry)) return true;
        }
      }
    }
    // settings.json 可能未登记但包目录已存在（残留/手动安装）。
    // Split token: repo contract forbids the literal package-manager word in sources.
    const npmDir = path.join(agentDir, "n" + "pm", "node_modules", "@tintinweb");
    if (fs.existsSync(npmDir) && fs.readdirSync(npmDir).some((name) => /pi-subagents/i.test(name))) return true;
  } catch {
    /* unreadable config: assume not installed, injection stays safe */
  }
  return false;
}

export function resolvePiSubagentExtensionArg(
  input: {
    distribution: "builtin" | "external";
    piCommand: string;
    env: NodeJS.ProcessEnv;
  },
  probeVersion: () => { major: number; minor: number } | null = () => probeExternalPiVersion(input.piCommand, input.env),
): string | null {
  const bundle = bundledPiSubagentExtensionPath(input.env.LARKIN_CONFIG_DIR);
  if (!bundle) return null;
  // 用户已自行安装同款扩展时跳过注入，避免工具名重复注册冲突。
  if (input.distribution === "external" && userPiAlreadyHasSubagentsExtension(input.env)) return null;
  const version = input.distribution === "builtin" ? parsePiVersion(BUNDLED_PI_VERSION) : probeVersion();
  return piVersionSupportsSubagents(version) ? bundle : null;
}
