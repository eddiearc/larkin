import fs from "node:fs";
import * as larkinConfig from "../platform/config.js";
import {
  createOfficialPiCredentialRuntime,
  officialPiAuthStatus,
} from "../runtime/pi-official-auth.js";
import {
  configureBuiltinPiProvider,
  listBuiltinPiProviderCatalog,
  logoutBuiltinPiProvider,
} from "../runtime/pi-provider-login.js";
import { MAX_BUILTIN_PI_API_KEY_LENGTH } from "../runtime/pi-provider-config.js";

const APP_ID = /^cli_[A-Za-z0-9]+$/;
const USAGE = "Usage: larkin pi-auth status [--agent <App ID>] [--json] | larkin pi-auth providers [--json] | larkin pi-auth login <preset|custom> --agent <App ID> [--model <model>] [--base-url <url>] [--api-key-stdin] [--json] | larkin pi-auth logout <provider> [--agent <App ID>]";
const API_KEY_ARGV_MESSAGE = "existing-Agent login does not accept --api-key. Use --api-key-stdin or an interactive TTY prompt.";
const API_KEY_BUDGET_MESSAGE = "API Key 不能为空或包含控制字符";
const STDIN_CHUNK_BYTES = 1024;
const STDIN_BOM_BYTES = 3;
const STDIN_TRAILING_NEWLINE_SLACK = 32;
const MAX_STDIN_API_KEY_BYTES = MAX_BUILTIN_PI_API_KEY_LENGTH + STDIN_BOM_BYTES + STDIN_TRAILING_NEWLINE_SLACK;

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasApiKeyArgv(args: readonly string[]): boolean {
  return args.some((argument) => argument === "--api-key" || argument.startsWith("--api-key="));
}

function consumeFlags(args: readonly string[], allowed: ReadonlySet<string>, unary: ReadonlySet<string>): boolean {
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (!argument.startsWith("--")) return false;
    if (unary.has(argument)) { index += 1; continue; }
    if (allowed.has(argument) && args[index + 1] && !args[index + 1]!.startsWith("--")) { index += 2; continue; }
    return false;
  }
  return true;
}

/** 去掉 BOM 与全部尾部换行；保留内部控制字符给后续校验拒绝。 */
export function normalizeStdinApiKey(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/[\r\n]+$/g, "");
}

function assertStdinApiKeyBudget(size: number): void {
  if (size > MAX_STDIN_API_KEY_BYTES) throw new Error(API_KEY_BUDGET_MESSAGE);
}

function finishStdinApiKey(chunks: readonly Buffer[]): string {
  const normalized = normalizeStdinApiKey(Buffer.concat(chunks).toString("utf8"));
  if (normalized.length > MAX_BUILTIN_PI_API_KEY_LENGTH) throw new Error(API_KEY_BUDGET_MESSAGE);
  return normalized;
}

function readFdChunk(fd: number, buffer: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, 0, buffer.length, null, (error, bytesRead) => {
      if (error) reject(error);
      else resolve(bytesRead);
    });
  });
}

/** 按块读取 fd，超过 key 上限立即停止，不等待管道 EOF。 */
async function readBoundedFdSecret(fd: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const buffer = Buffer.alloc(STDIN_CHUNK_BYTES);
  while (true) {
    const bytesRead = await readFdChunk(fd, buffer);
    if (bytesRead === 0) break;
    size += bytesRead;
    assertStdinApiKeyBudget(size);
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return finishStdinApiKey(chunks);
}

async function readBoundedStreamSecret(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    assertStdinApiKeyBudget(size);
    chunks.push(bytes);
  }
  return finishStdinApiKey(chunks);
}

export async function readStdinSecret(stdin: NodeJS.ReadableStream): Promise<string> {
  const stream = stdin as NodeJS.ReadableStream & { fd?: number; isTTY?: boolean; pause?: () => void };
  if (typeof stream.fd === "number" && stream.fd >= 0 && !stream.isTTY) {
    if (typeof stream.pause === "function") stream.pause();
    try {
      return await readBoundedFdSecret(stream.fd);
    } catch (error) {
      if (error instanceof Error && error.message === API_KEY_BUDGET_MESSAGE) throw error;
      // 回退到异步收集，例如测试传入的假 stream。
    }
  }
  return readBoundedStreamSecret(stdin);
}

function createNoEchoQuestioner(stdin: NodeJS.ReadStream, stdout: NodeJS.WritableStream): {
  secret(prompt: string): Promise<string>;
  close(): void;
} {
  return {
    close() {},
    secret(prompt: string): Promise<string> {
      if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
        throw new Error("non-interactive API-key login requires --api-key-stdin");
      }
      stdout.write(prompt);
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.resume();
      return new Promise<string>((resolve, reject) => {
        let value = "";
        const finish = (error?: Error): void => {
          stdin.off("data", onData);
          stdin.setRawMode(Boolean(wasRaw));
          stdin.pause();
          stdout.write("\n");
          if (error) reject(error); else resolve(value);
        };
        const onData = (chunk: Buffer | string): void => {
          const bytes = Buffer.from(chunk);
          for (const byte of bytes) {
            if (byte === 3) return finish(new Error("pi-auth login cancelled"));
            if (byte === 10 || byte === 13) return finish();
            if (byte === 8 || byte === 127) { value = value.slice(0, -1); continue; }
            if (byte >= 32 && byte <= 126) value += String.fromCharCode(byte);
          }
        };
        stdin.on("data", onData);
      });
    },
  };
}

function resolveAgentId(args: readonly string[], env: NodeJS.ProcessEnv): string {
  const loaded = larkinConfig.loadConfig(env);
  const agentId = flag(args, "--agent") || loaded.config.activeAgent || undefined;
  if (!agentId || !APP_ID.test(agentId)) throw new Error("请用 --agent <App ID> 选择 Agent");
  const agent = loaded.config.agents[agentId];
  if (!agent) throw new Error(`Agent ${agentId} 不存在`);
  if (agent.runtime !== "pi" || agent.piDistribution !== "builtin") throw new Error(`Agent ${agentId} 不是内置 Pi`);
  return agentId;
}

export interface PiAuthCliIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  isTTY: boolean;
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: PiAuthCliIo = { stdin: process.stdin, stdout: process.stdout, isTTY: Boolean(process.stdin.isTTY) },
): Promise<void> {
  const action = args[0] || "status";
  const json = args.includes("--json");
  if (hasApiKeyArgv(args)) throw new Error(API_KEY_ARGV_MESSAGE);

  if (action === "providers") {
    if (!consumeFlags(args.slice(1), new Set(), new Set(["--json"]))) throw new Error(USAGE);
    const providers = listBuiltinPiProviderCatalog();
    if (json) {
      console.log(JSON.stringify({ providers }));
      return;
    }
    console.log("Builtin Pi providers:");
    for (const entry of providers) {
      const model = entry.defaultModel ? ` default=${entry.defaultModel}` : " (requires --base-url and --model)";
      console.log(`  ${entry.id}  ${entry.name}${model}`);
    }
    return;
  }

  if (action === "login") {
    const preset = args[1];
    const rest = args.slice(2);
    if (!preset || preset.startsWith("--")
        || !consumeFlags(rest, new Set(["--agent", "--model", "--base-url"]), new Set(["--json", "--api-key-stdin"]))) {
      throw new Error(USAGE);
    }
    const agentId = resolveAgentId(rest, env);
    const stdinKey = rest.includes("--api-key-stdin");
    let apiKey = "";
    if (stdinKey) apiKey = await readStdinSecret(io.stdin);
    else if (io.isTTY) {
      const questioner = createNoEchoQuestioner(io.stdin as NodeJS.ReadStream, io.stdout);
      try { apiKey = await questioner.secret("API Key:\n> "); }
      finally { questioner.close(); }
    } else {
      throw new Error("non-interactive API-key login requires --api-key-stdin");
    }
    const result = await configureBuiltinPiProvider({
      agentId,
      preset,
      apiKey,
      model: flag(rest, "--model"),
      baseUrl: flag(rest, "--base-url"),
      env,
    });
    const payload = {
      agentId: result.agentId,
      provider: result.provider,
      model: result.model,
      credentialType: result.credentialType,
      applyState: result.applyState,
      ...(result.applyError ? { applyError: result.applyError } : {}),
    };
    if (json) console.log(JSON.stringify(payload));
    else {
      const pending = result.applyState === "applied"
        ? "applied"
        : result.applyState === "pending"
          ? `pending${result.applyError ? ` (${result.applyError})` : ""}`
          : "saved; will apply on larkin start";
      console.log(`Agent ${result.agentId} provider=${result.provider} model=${result.model} credential=${result.credentialType} apply=${pending}`);
    }
    return;
  }

  const requestedAgent = flag(args, "--agent");
  let index = action === "logout" ? 2 : 1;
  let valid = action === "status" || action === "logout";
  while (valid && index < args.length) {
    const argument = args[index];
    if (argument === "--json" && action === "status") { index += 1; continue; }
    if (argument === "--agent" && args[index + 1]) { index += 2; continue; }
    valid = false;
  }
  if (!valid) throw new Error(USAGE);
  const loaded = larkinConfig.loadConfig(env);
  const agentId = requestedAgent || loaded.config.activeAgent || undefined;
  if (!agentId || !APP_ID.test(agentId)) throw new Error("请用 --agent <App ID> 选择 Agent");
  const agent = loaded.config.agents[agentId];
  if (!agent) throw new Error(`Agent ${agentId} 不存在`);
  if (agent.runtime !== "pi" || agent.piDistribution !== "builtin") throw new Error(`Agent ${agentId} 不是内置 Pi`);
  if (action === "status") {
    const runtime = await createOfficialPiCredentialRuntime(loaded.configDir, agentId);
    const statuses = await officialPiAuthStatus(runtime);
    if (json) console.log(JSON.stringify({ agentId, credentials: statuses }));
    else if (statuses.length === 0) console.log(`Agent ${agentId} 尚无已配置的官方 Pi credential`);
    else {
      console.log(`Agent ${agentId} 官方 Pi credential：`);
      for (const entry of statuses) console.log(`  ${entry.providerName} (${entry.providerId}): ${entry.credentialType}/${entry.source}${entry.stored ? " [stored]" : " [ambient]"}`);
    }
    return;
  }
  const providerId = args[1];
  if (!providerId || providerId.startsWith("--")) throw new Error("logout 需要安全的 provider ID");
  await logoutBuiltinPiProvider({ agentId, providerId, env });
  console.log(`Agent ${agentId} 已退出 ${providerId}；其他 provider 未修改`);
}
