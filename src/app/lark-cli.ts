#!/usr/bin/env bun

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentStateStore, type AgentStateStore } from "../agent/agent-state-store.js";
import * as larkinConfig from "../platform/config.js";

type Env = Record<string, string | undefined>;

export interface LarkCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface LarkCliLauncherDependencies {
  io?: LarkCliIo;
  spawn?: typeof spawnSync;
  upstreamScript?: string;
  stateStore?: AgentStateStore;
  now?(): number;
}

export type LarkCliCommandDecision =
  | { kind: "passthrough" }
  | { kind: "guarded"; operation: "send" | "reply" | "card" }
  | { kind: "runtime-owned"; operation: "draft-list" | "draft-send" | "draft-abandon" }
  | { kind: "denied"; reason: string };

const HELP_FLAGS = new Set(["--help", "-h"]);
const MANAGEMENT_COMMANDS = new Set(["auth", "config", "profile", "update", "install"]);
const USER_ONLY_COMMANDS = new Set(["attendance", "mail", "okr"]);

function defaultIo(): LarkCliIo {
  return { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };
}

function exactPath(argv: readonly string[], pathSegments: readonly string[]): boolean {
  return pathSegments.every((segment, index) => argv[index] === segment);
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((argument) => argument === flag || argument.startsWith(`${flag}=`));
}

function flagValue(argv: readonly string[], flag: string): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === flag) return argv[index + 1] || null;
    if (argument.startsWith(`${flag}=`)) return argument.slice(flag.length + 1) || null;
  }
  return null;
}

export function classifyLarkCliCommand(argv: readonly string[]): LarkCliCommandDecision {
  for (const flag of ["--profile", "--config-dir", "--agent"]) {
    if (hasFlag(argv, flag)) return { kind: "denied", reason: `身份边界：${flag} 由 Larkin Runtime 锁定` };
  }
  const as = flagValue(argv, "--as");
  if (as && as !== "bot") return { kind: "denied", reason: "身份边界：Runtime 内 lark-cli 只允许 Bot identity" };
  if (argv.some((argument) => HELP_FLAGS.has(argument))) return { kind: "passthrough" };
  const command = argv[0] || "";
  if (MANAGEMENT_COMMANDS.has(command)) return { kind: "denied", reason: `身份边界：Runtime 不开放 lark-cli ${command} 管理命令` };
  if (command === "event") return { kind: "denied", reason: "Runtime 不允许另开 event 连接与 Host 争抢事件流" };
  if (USER_ONLY_COMMANDS.has(command)) return { kind: "denied", reason: `${command} 是 user-only identity 域` };
  if (exactPath(argv, ["larkin-draft", "list"])) return { kind: "runtime-owned", operation: "draft-list" };
  if (exactPath(argv, ["larkin-draft", "send"])) return { kind: "runtime-owned", operation: "draft-send" };
  if (exactPath(argv, ["larkin-draft", "abandon"])) return { kind: "runtime-owned", operation: "draft-abandon" };
  if (exactPath(argv, ["im", "+messages-send"])) return { kind: "guarded", operation: "send" };
  if (exactPath(argv, ["im", "+messages-reply"])) return { kind: "guarded", operation: "reply" };
  if (exactPath(argv, ["im", "messages", "patch"]) || exactPath(argv, ["im", "messages", "update"])) {
    return { kind: "guarded", operation: "card" };
  }
  if (exactPath(argv, ["im", "messages", "create"]) || exactPath(argv, ["im", "messages", "reply"])) {
    return { kind: "denied", reason: "该原始 IM 写入口会旁路 target freshness；请使用 +messages-send/+messages-reply" };
  }
  if (command === "api") return { kind: "denied", reason: "generic API 会旁路 Runtime identity/freshness policy" };
  return { kind: "passthrough" };
}

function resolveUpstreamScript(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("@larksuite/cli/package.json")), "scripts", "run.js");
}

function spawnNative(
  argv: readonly string[], env: Env, io: LarkCliIo, dependencies: LarkCliLauncherDependencies,
): number {
  const result = (dependencies.spawn ?? spawnSync)(
    process.execPath,
    [dependencies.upstreamScript ?? resolveUpstreamScript(), ...argv],
    { encoding: "utf8", env: { ...process.env, ...env } },
  ) as SpawnSyncReturns<string>;
  if (result.stdout) io.stdout(result.stdout);
  if (result.stderr) io.stderr(result.stderr);
  if (result.error) {
    io.stderr(`lark-cli: package-local launcher failed: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function guardedTarget(decision: Extract<LarkCliCommandDecision, { kind: "guarded" }>, argv: readonly string[], store: AgentStateStore): string {
  if (decision.operation === "send") {
    const chatId = flagValue(argv, "--chat-id");
    const userId = flagValue(argv, "--user-id");
    if (!chatId || userId) throw new Error("Runtime +messages-send 必须只使用 Inbox 已确认的 --chat-id；--user-id 无法建立 freshness target");
    return `chat:${chatId}`;
  }
  const messageId = flagValue(argv, "--message-id");
  if (!messageId) throw new Error(`${decision.operation} 写入缺少 --message-id`);
  const target = store.resolveInboxMessageTarget(messageId);
  if (!target) throw new Error(`无法从 Inbox 状态确定 ${messageId} 的 target；先 poll 对应消息，禁止旁路 freshness`);
  return target;
}

function botArgv(argv: readonly string[], intentId: string): string[] {
  const next = [...argv];
  if (!hasFlag(next, "--as")) next.push("--as", "bot");
  if (!hasFlag(next, "--idempotency-key")) next.push("--idempotency-key", intentId);
  return next;
}

export function runLarkCli(
  argv: readonly string[], env: Env = process.env, dependencies: LarkCliLauncherDependencies = {},
): number {
  const io = dependencies.io ?? defaultIo();
  const runtimeAgentId = larkinConfig.resolveRuntimeAuthority(env);
  if (!runtimeAgentId) return spawnNative(argv, env, io, dependencies);
  let config: larkinConfig.HydratedConfig;
  let agent: larkinConfig.HydratedAgent;
  try {
    ({ config } = larkinConfig.loadConfig(env));
    agent = larkinConfig.selectAgent(config, { ...env, LARKIN_AGENT_ID: runtimeAgentId });
  } catch (error) {
    io.stderr(`lark-cli: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const privateEnv = { ...env, LARKIN_AGENT_ID: agent.agentId, LARKSUITE_CLI_CONFIG_DIR: agent.larkConfigDir };
  const decision = classifyLarkCliCommand(argv);
  if (decision.kind === "denied") {
    io.stderr(`lark-cli: ${decision.reason}\n`);
    return 2;
  }
  if (decision.kind === "runtime-owned") {
    const store = dependencies.stateStore ?? createAgentStateStore(config.larkinHome, agent.agentId);
    const draftId = flagValue(argv, "--draft-id");
    try {
      if (decision.operation === "draft-list") {
        io.stdout(`${JSON.stringify({ drafts: store.listInboxDrafts() }, null, 2)}\n`);
        return 0;
      }
      if (!draftId) throw new Error(`${decision.operation} 需要 --draft-id`);
      if (decision.operation === "draft-abandon") {
        io.stdout(`${JSON.stringify(store.setInboxDraftStatus(draftId, "abandoned", dependencies.now?.()), null, 2)}\n`);
        return 0;
      }
      const draft = store.readInboxDraft(draftId);
      if (!draft || draft.status !== "held") throw new Error(`held draft 不存在：${draftId}`);
      const draftDecision = classifyLarkCliCommand(draft.argv);
      if (draftDecision.kind !== "guarded" || guardedTarget(draftDecision, draft.argv, store) !== draft.target) {
        throw new Error(`held draft target/command 不一致：${draftId}`);
      }
      let exitCode = 1;
      const gated = store.withFreshnessGate({
        target: draft.target,
        argv: draft.argv,
        commitDraftId: draftId,
        providerSucceeded: (code) => code === 0,
        ...(dependencies.now ? { now: dependencies.now() } : {}),
      }, (intentId) => {
        exitCode = spawnNative(botArgv(draft.argv, intentId), privateEnv, io, dependencies);
        return exitCode;
      });
      if (gated.status === "held") {
        io.stdout(`${JSON.stringify({ ok: false, status: "held", target: gated.target,
          latest_received_seq: gated.latest_received_seq, model_seen_seq: gated.model_seen_seq,
          draft_id: gated.draft.draft_id, next: `larkin inbox poll --target ${gated.target}` }, null, 2)}\n`);
        return 0;
      }
      return exitCode;
    } catch (error) {
      io.stderr(`lark-cli: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  if (decision.kind === "passthrough") return spawnNative(argv, privateEnv, io, dependencies);
  const store = dependencies.stateStore ?? createAgentStateStore(config.larkinHome, agent.agentId);
  try {
    const target = guardedTarget(decision, argv, store);
    let exitCode = 1;
    const gated = store.withFreshnessGate({ target, argv, ...(dependencies.now ? { now: dependencies.now() } : {}) }, (intentId) => {
      exitCode = spawnNative(botArgv(argv, intentId), privateEnv, io, dependencies);
      return exitCode;
    });
    if (gated.status === "held") {
      io.stdout(`${JSON.stringify({ ok: false, status: "held", target: gated.target,
        latest_received_seq: gated.latest_received_seq, model_seen_seq: gated.model_seen_seq,
        draft_id: gated.draft.draft_id, next: `larkin inbox poll --target ${gated.target}` }, null, 2)}\n`);
      return 0;
    }
    return exitCode;
  } catch (error) {
    io.stderr(`lark-cli: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

export function main(argv = process.argv.slice(2), env: Env = process.env): never {
  process.exit(runLarkCli(argv, env));
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))) main();
