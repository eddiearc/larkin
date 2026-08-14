import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SmokeEnvironmentInput {
  platform: NodeJS.Platform;
  home: string;
  larkinHome: string;
  restrictedPath: string;
  temporaryDirectory?: string;
  systemEnvironment?: NodeJS.ProcessEnv;
}

function windowsRoot(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.WINDIR;
  if (!root || /[\r\n\0]/.test(root)) throw new Error("release smoke requires a valid Windows system root");
  return root;
}

export function prepareRestrictedSmokePath(
  platform: NodeJS.Platform,
  restrictedBin: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync,
  symlink: (target: string, file: string) => void = fs.symlinkSync,
): string {
  if (platform === "win32") {
    const powerShell = path.win32.join(windowsRoot(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (!exists(powerShell)) throw new Error("release smoke requires Windows PowerShell for fail-closed process inspection");
    return path.win32.dirname(powerShell);
  }

  const systemPs = ["/bin/ps", "/usr/bin/ps"].find(exists);
  if (!systemPs) throw new Error("release smoke requires the platform ps executable");
  symlink(systemPs, path.join(restrictedBin, "ps"));
  return restrictedBin;
}

export function smokeArtifactEnvironment(input: SmokeEnvironmentInput): NodeJS.ProcessEnv {
  const temporaryDirectory = input.temporaryDirectory || os.tmpdir();
  const common: NodeJS.ProcessEnv = {
    HOME: input.home,
    LARKIN_HOME: input.larkinHome,
    LARKIN_CONFIG_DIR: input.larkinHome,
    PATH: input.restrictedPath,
    NO_COLOR: "1",
  };
  if (input.platform === "win32") {
    const root = windowsRoot(input.systemEnvironment || process.env);
    return {
      ...common,
      USERPROFILE: input.home,
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
      SystemRoot: root,
      WINDIR: root,
    };
  }
  return { ...common, TMPDIR: temporaryDirectory };
}

export type SmokeTerminationPlan =
  | { kind: "windows-tree"; command: string; args: string[] }
  | { kind: "signals"; graceful: "SIGTERM"; force: "SIGKILL" };

export function smokeTerminationPlan(
  platform: NodeJS.Platform,
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
): SmokeTerminationPlan {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("release smoke cannot terminate a child without a valid pid");
  if (platform === "win32") {
    return {
      kind: "windows-tree",
      command: path.win32.join(windowsRoot(env), "System32", "taskkill.exe"),
      args: ["/PID", String(pid), "/T", "/F"],
    };
  }
  return { kind: "signals", graceful: "SIGTERM", force: "SIGKILL" };
}
