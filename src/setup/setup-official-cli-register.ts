import { spawn as systemSpawn, type ChildProcess } from "node:child_process";
import type { OfficialLarkCliCommand } from "../app/official-lark-cli.js";
import type { LarkinTenant } from "../feishu/platform-hosts.js";

export interface OfficialCliInitResult {
  appId: string;
  authorizationUrl: string;
  brand: LarkinTenant;
}

const APP_ID = /^cli_[A-Za-z0-9]+$/;
const SETUP_URL = /https:\/\/open\.(?:larksuite\.com|feishu\.cn)\/page\/cli\?[^\s]+/;

export function parseOfficialCliAuthorizationUrl(text: string): string | null {
  return text.match(SETUP_URL)?.[0] ?? null;
}

export function parseOfficialCliInitOutput(text: string): OfficialCliInitResult {
  const authorizationUrl = parseOfficialCliAuthorizationUrl(text);
  const appId = text.match(/App ID:\s*(cli_[A-Za-z0-9]+)/)?.[1]
    || text.match(/"appId"\s*:\s*"(cli_[A-Za-z0-9]+)"/)?.[1];
  const brand = text.match(/"brand"\s*:\s*"(lark|feishu)"/)?.[1] as LarkinTenant | undefined;
  if (!authorizationUrl) throw new Error("官方 lark-cli init 未返回 /page/cli 授权链接");
  if (!appId || !APP_ID.test(appId)) throw new Error("官方 lark-cli init 未返回合法 App ID");
  if (brand !== "lark" && brand !== "feishu") throw new Error("官方 lark-cli init 未返回合法 brand");
  return { appId, authorizationUrl, brand };
}

export function officialCliInitArgs(tenant: LarkinTenant, profileName: string): string[] {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(profileName)) throw new Error("lark-cli profile name 非法");
  return ["config", "init", "--new", "--brand", tenant, "--name", profileName];
}

export async function runOfficialCliAppInit(input: {
  tenant: LarkinTenant;
  official: OfficialLarkCliCommand;
  profileName: string;
  env: NodeJS.ProcessEnv;
  onAuthorizationUrl: (url: string) => void;
  spawnImpl?: typeof systemSpawn;
  signal?: AbortSignal;
  onChild?: (child: ChildProcess | null) => void;
}): Promise<OfficialCliInitResult> {
  const args = [...input.official.argsPrefix, ...officialCliInitArgs(input.tenant, input.profileName)];
  const child = (input.spawnImpl ?? systemSpawn)(input.official.command, args, {
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  input.onChild?.(child);
  let output = "";
  let presented = false;
  const consume = (chunk: Buffer | string): void => {
    output += String(chunk);
    if (presented) return;
    const url = parseOfficialCliAuthorizationUrl(output);
    if (!url) return;
    presented = true;
    input.onAuthorizationUrl(url);
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);
  const abort = (): void => {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 1_000);
    killTimer.unref?.();
  };
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    if (input.signal?.aborted) throw new Error("官方 lark-cli init 已取消");
    const parsed = parseOfficialCliInitOutput(output);
    if (status !== 0) throw new Error(`官方 lark-cli init 失败（exit=${status ?? "none"}）`);
    return parsed;
  } finally {
    input.signal?.removeEventListener("abort", abort);
    input.onChild?.(null);
  }
}
