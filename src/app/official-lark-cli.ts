import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const OFFICIAL_LARK_CLI_VERSION = "1.0.79";
export const OFFICIAL_LARK_CLI_INSTALL = `npm install --global @larksuite/cli@${OFFICIAL_LARK_CLI_VERSION}`;

export interface OfficialLarkCliCommand {
  command: string;
  argsPrefix: string[];
  version: string;
}

export type OfficialLarkCliProbe =
  | { state: "ready"; command: OfficialLarkCliCommand }
  | { state: "missing"; reason: string; nextAction: string }
  | { state: "outdated"; reason: string; nextAction: string }
  | { state: "conflict"; reason: string; nextAction: string };

export interface OfficialLarkCliDependencies {
  spawn?: typeof spawnSync;
  shell?: string;
  env?: NodeJS.ProcessEnv;
}

function loginShellPath(dependencies: OfficialLarkCliDependencies): string | null {
  const env = dependencies.env ?? process.env;
  const shell = dependencies.shell || env.SHELL || "/bin/sh";
  const result = (dependencies.spawn ?? spawnSync)(shell, ["-lc", "command -v lark-cli 2>/dev/null"], {
    encoding: "utf8", env,
  }) as SpawnSyncReturns<string>;
  if (result.status !== 0 || result.error) return null;
  const candidate = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  return path.isAbsolute(candidate) ? path.resolve(candidate) : null;
}

function compatibleVersion(version: string): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const actual = parse(version);
  const minimum = parse(OFFICIAL_LARK_CLI_VERSION)!;
  if (!actual) return false;
  return actual[0] > minimum[0] || (actual[0] === minimum[0]
    && (actual[1] > minimum[1] || (actual[1] === minimum[1] && actual[2] >= minimum[2])));
}

function officialPackage(executable: string): OfficialLarkCliCommand | null {
  let resolved: string;
  try { resolved = fs.realpathSync(executable); } catch { return null; }
  let directory = path.dirname(resolved);
  while (directory !== path.dirname(directory)) {
    const manifestFile = path.join(directory, "package.json");
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
        name?: string; version?: string; bin?: { "lark-cli"?: string } | string;
      };
      const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["lark-cli"];
      if (manifest.name === "@larksuite/cli" && typeof manifest.version === "string" && /^\d+\.\d+\.\d+$/.test(manifest.version) && bin) {
        const packageRoot = fs.realpathSync(directory);
        const requested = path.resolve(packageRoot, bin);
        const relative = path.relative(packageRoot, requested);
        if ((relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."))
            && fs.realpathSync(requested) === resolved) {
          return { command: path.resolve(executable), argsPrefix: [], version: manifest.version };
        }
      }
    } catch { /* Continue towards the filesystem root. */ }
    directory = path.dirname(directory);
  }
  return null;
}

export function probeOfficialLarkCli(dependencies: OfficialLarkCliDependencies = {}): OfficialLarkCliProbe {
  const executable = loginShellPath(dependencies);
  if (!executable) return {
    state: "missing",
    reason: "真实 login shell 找不到官方 lark-cli",
    nextAction: `运行 larkin setup，并确认执行：${OFFICIAL_LARK_CLI_INSTALL}`,
  };
  const command = officialPackage(executable);
  if (!command) return {
    state: "conflict",
    reason: `真实 login shell 的 lark-cli 不是兼容的官方 @larksuite/cli ${OFFICIAL_LARK_CLI_VERSION}: ${executable}`,
    nextAction: "移除或调整冲突入口后重新运行 larkin setup",
  };
  if (!compatibleVersion(command.version)) return {
    state: "outdated",
    reason: `真实 login shell 的官方 @larksuite/cli ${command.version} 低于最低兼容版本 ${OFFICIAL_LARK_CLI_VERSION}`,
    nextAction: `升级：${OFFICIAL_LARK_CLI_INSTALL}`,
  };
  const version = (dependencies.spawn ?? spawnSync)(command.command, ["--version"], {
    encoding: "utf8", env: dependencies.env ?? process.env,
  }) as SpawnSyncReturns<string>;
  if (version.status !== 0 || version.error || !String(version.stdout || "").includes(command.version)) return {
    state: "outdated",
    reason: `官方 lark-cli 版本执行验证失败: ${command.command}`,
    nextAction: `重新安装：${OFFICIAL_LARK_CLI_INSTALL}`,
  };
  const bindHelp = (dependencies.spawn ?? spawnSync)(command.command, ["config", "bind", "--help"], {
    encoding: "utf8", env: dependencies.env ?? process.env,
  }) as SpawnSyncReturns<string>;
  const bindText = `${bindHelp.stdout || ""}\n${bindHelp.stderr || ""}`;
  if (bindHelp.status !== 0 || bindHelp.error || !/--source/.test(bindText) || !/lark-channel/.test(bindText) || !/--identity/.test(bindText)) return {
    state: "conflict",
    reason: `官方 lark-cli 缺少 lark-channel bot-only bind 能力: ${command.command}`,
    nextAction: `升级：${OFFICIAL_LARK_CLI_INSTALL}`,
  };
  return { state: "ready", command };
}

export function resolveOfficialLarkCli(dependencies: OfficialLarkCliDependencies = {}): OfficialLarkCliCommand {
  const result = probeOfficialLarkCli(dependencies);
  if (result.state !== "ready") throw new Error(`${result.reason}；${result.nextAction}`);
  return result.command;
}

export function installOfficialLarkCli(dependencies: OfficialLarkCliDependencies = {}): OfficialLarkCliCommand {
  const run = dependencies.spawn ?? spawnSync;
  const result = run("npm", ["install", "--global", `@larksuite/cli@${OFFICIAL_LARK_CLI_VERSION}`], {
    encoding: "utf8", env: dependencies.env ?? process.env, stdio: "inherit",
  }) as SpawnSyncReturns<string>;
  if (result.status !== 0 || result.error) throw new Error(`官方 lark-cli 安装失败（exit=${result.status ?? "none"}）`);
  return resolveOfficialLarkCli(dependencies);
}

export async function ensureOfficialLarkCliForSetup(input: OfficialLarkCliDependencies & {
  interactive: boolean;
  confirmInstall(command: string): boolean | Promise<boolean>;
}): Promise<{ command: OfficialLarkCliCommand; installed: boolean }> {
  const probe = probeOfficialLarkCli(input);
  if (probe.state === "ready") return { command: probe.command, installed: false };
  if (probe.state === "conflict") throw new Error(`${probe.reason}；${probe.nextAction}`);
  if (!input.interactive) {
    throw new Error(`${probe.reason}；非交互 setup 不会安装或升级依赖。请在终端运行 larkin setup，并确认：${OFFICIAL_LARK_CLI_INSTALL}`);
  }
  if (!await input.confirmInstall(OFFICIAL_LARK_CLI_INSTALL)) {
    throw new Error("未获得明确同意；没有安装官方 lark-cli，也没有写入 Agent 配置");
  }
  return { command: installOfficialLarkCli(input), installed: true };
}
