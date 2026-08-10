import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PI_VERSION } from "./pi-provider-config.js";
import { parsePiVersion, piVersionSupportsSubagents, probeExternalPiVersion } from "./pi-subagent-injection.js";

declare global {
  // Filled by the standalone wrapper (scripts/release/standalone-entry.ts).
  var __LARKIN_EMBEDDED_PI_BASH_TIMEOUT_BUNDLE__: string | undefined;
}

/**
 * pi-bash-timeout 扩展注入（bash 60s 超时护栏，issue #55/#56）。
 *
 * 分发：构建期把 src/runtime/pi-bash-timeout-extension.ts bundle 成单文件
 * `dist/runtime/pi-bash-timeout.bundle.js`（pi-* 包 external），运行时通过
 * `pi --extension/-e` 显式注入 —— builtin 与 external（用户 pi CLI）走同一
 * 路径，不碰用户 ~/.pi 配置。与 pi-subagents 共享同一个 pi 版本门槛。
 */

/** 把 embedded bundle 落盘到 <configDir>/providers/pi/extensions/（0700/0600）。无 embedded 资产返回 null。 */
export function materializeEmbeddedPiBashTimeoutBundle(configDir: string | undefined): string | null {
  const embedded = globalThis.__LARKIN_EMBEDDED_PI_BASH_TIMEOUT_BUNDLE__;
  if (!embedded || !configDir) return null;
  const dir = path.join(path.resolve(configDir), "providers", "pi", "extensions");
  const target = path.join(dir, "pi-bash-timeout.bundle.js");
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

/** 构建产物单文件路径；standalone 二进制回退到 embedded 资产落盘。 */
export function bundledPiBashTimeoutExtensionPath(configDir?: string): string | null {
  try {
    const url = new URL("./pi-bash-timeout.bundle.js", import.meta.url);
    const resolved = fileURLToPath(url);
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    /* fall through to embedded */
  }
  return materializeEmbeddedPiBashTimeoutBundle(configDir);
}

/**
 * 注入决策：builtin 恒注入（内嵌 pi 版本固定）；external 需探测版本（与
 * pi-subagents 同门槛 >= 0.80.0，保证 createBashToolDefinition 可用）。
 * 返回 `-e` 参数值，或 null（产物缺失或版本不达标）。
 */
export function resolvePiBashTimeoutExtensionArg(
  input: { distribution: "builtin" | "external"; piCommand: string; env: NodeJS.ProcessEnv },
  probeVersion: () => { major: number; minor: number } | null = () => probeExternalPiVersion(input.piCommand, input.env),
  resolveBundle: () => string | null = () => bundledPiBashTimeoutExtensionPath(input.env.LARKIN_CONFIG_DIR),
): string | null {
  const bundle = resolveBundle();
  if (!bundle) return null;
  const version = input.distribution === "builtin" ? parsePiVersion(BUNDLED_PI_VERSION) : probeVersion();
  return piVersionSupportsSubagents(version) ? bundle : null;
}
