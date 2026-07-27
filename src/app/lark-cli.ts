#!/usr/bin/env bun

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentStateStore, type AgentStateStore } from "../agent/agent-state-store.js";
import * as larkinConfig from "../platform/config.js";
import { resolvePinnedLarkCliCommand, type PinnedLarkCliCommand } from "./runtime-agent-config.js";

type Env = Record<string, string | undefined>;

export interface LarkCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface LarkCliLauncherDependencies {
  io?: LarkCliIo;
  spawn?: typeof spawnSync;
  upstreamScript?: string;
  nativeCommand?: PinnedLarkCliCommand;
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
const POLICY_VALUE_FLAGS = new Set([
  "--as", "--profile", "--config-dir", "--agent", "--chat-id", "--user-id", "--message-id", "--idempotency-key", "--draft-id",
]);
const PROTECTED_VALUE_FLAGS = new Set([
  ...POLICY_VALUE_FLAGS,
  "--text", "--markdown", "--content", "--image", "--file", "--video", "--video-cover", "--audio", "--msg-type",
  "--format", "--jq", "-q", "--output", "-o", "--data", "--params", "--receive-id-type", "--thread-id", "--uuid",
  "--page-delay", "--page-limit", "--page-size",
]);
const RAW_IM_WRITE_OPERATIONS = new Set([
  "create", "reply", "patch", "update", "forward", "merge_forward", "delete", "urgent_app", "urgent_phone", "urgent_sms",
]);

type ProtectedOperation = "send" | "reply" | "card-patch" | "card-update" | "raw-create" | "raw-reply"
  | "raw-forward" | "raw-merge_forward" | "raw-delete" | "raw-urgent_app" | "raw-urgent_phone" | "raw-urgent_sms"
  | "thread-forward" | "thread-merge_forward" | "api" | "draft";

interface PolicyArgv {
  commandArgv: readonly string[];
  flags: ReadonlyMap<string, string>;
  help: boolean;
  error: string | null;
}

function defaultIo(): LarkCliIo {
  return { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };
}

function exactPath(argv: readonly string[], pathSegments: readonly string[]): boolean {
  return pathSegments.every((segment, index) => argv[index] === segment);
}

function nativeArgvBeforeBoundary(argv: readonly string[]): readonly string[] {
  const boundary = argv.indexOf("--");
  return argv.slice(0, boundary < 0 ? argv.length : boundary);
}

function protectedSyntaxTokens(argv: readonly string[]): string[] {
  const tokens: string[] = [];
  const nativeArgv = nativeArgvBeforeBoundary(argv);
  for (let index = 0; index < nativeArgv.length; index += 1) {
    const argument = nativeArgv[index];
    const inlineFlag = [...PROTECTED_VALUE_FLAGS].find((flag) => argument.startsWith(`${flag}=`));
    if (inlineFlag) {
      tokens.push(inlineFlag);
      continue;
    }
    tokens.push(argument);
    if (PROTECTED_VALUE_FLAGS.has(argument) && index + 1 < nativeArgv.length) index += 1;
  }
  return tokens;
}

function hasNativeHelpFlag(argv: readonly string[]): boolean {
  return protectedSyntaxTokens(argv).some((argument) => HELP_FLAGS.has(argument));
}

function protectedOperations(argv: readonly string[]): ProtectedOperation[] {
  const tokens = protectedSyntaxTokens(argv);
  const operations: ProtectedOperation[] = [];
  for (const token of tokens) {
    if (token === "+messages-send") operations.push("send");
    else if (token === "+messages-reply") operations.push("reply");
    else if (token === "api") operations.push("api");
    else if (token === "larkin-draft") operations.push("draft");
  }
  const hasIm = tokens.includes("im");
  if (hasIm && tokens.includes("messages")) {
    for (const token of tokens) {
      if (!RAW_IM_WRITE_OPERATIONS.has(token)) continue;
      operations.push((token === "patch" || token === "update" ? `card-${token}` : `raw-${token}`) as ProtectedOperation);
    }
  }
  if (hasIm && tokens.includes("threads")) {
    for (const token of tokens) {
      if (token === "forward" || token === "merge_forward") operations.push(`thread-${token}` as ProtectedOperation);
    }
  }
  return operations;
}

function uniqueProtectedOperation(operations: readonly ProtectedOperation[], expected: ProtectedOperation): boolean {
  return operations.length === 1 && operations[0] === expected;
}

function noncanonicalProtectedDecision(): LarkCliCommandDecision {
  return {
    kind: "denied",
    reason: "受保护的 write/API 命令路径不明确；请把 service/subcommand 放在前面，再按原生 --help 提示传入 flags",
  };
}

function parsePolicyArgv(argv: readonly string[]): PolicyArgv {
  const nativeArgv = nativeArgvBeforeBoundary(argv);
  const help = hasNativeHelpFlag(argv);
  // Native help is an observational path. It must reach Cobra byte-for-byte even
  // when the surrounding argv would be rejected for a real operation.
  if (help) return { commandArgv: nativeArgv, flags: new Map(), help: true, error: null };
  const commandArgv: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < nativeArgv.length; index += 1) {
    const argument = nativeArgv[index];
    const inlineFlag = [...POLICY_VALUE_FLAGS].find((flag) => argument.startsWith(`${flag}=`));
    const flag = POLICY_VALUE_FLAGS.has(argument) ? argument : inlineFlag;
    if (!flag) {
      commandArgv.push(argument);
      continue;
    }
    const value = inlineFlag ? argument.slice(flag.length + 1) : nativeArgv[index + 1];
    if (!inlineFlag) index += 1;
    if (!value || value.startsWith("-")) return { commandArgv, flags, help: false, error: `${flag} 缺少有效值` };
    if (flags.has(flag)) return { commandArgv, flags, help: false, error: `${flag} 不允许重复或冲突赋值` };
    flags.set(flag, value);
  }
  return { commandArgv, flags, help: false, error: null };
}

function resolveUpstreamScript(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("@larksuite/cli/package.json")), "scripts", "run.js");
}

function policyFlagValue(argv: readonly string[], flag: string): string | null {
  return parsePolicyArgv(argv).flags.get(flag) ?? null;
}

export function classifyLarkCliCommand(argv: readonly string[]): LarkCliCommandDecision {
  const parsed = parsePolicyArgv(argv);
  if (parsed.help) return { kind: "passthrough" };
  if (parsed.error) return { kind: "denied", reason: `参数边界：${parsed.error}` };
  const protectedPaths = protectedOperations(argv);
  for (const flag of ["--profile", "--config-dir", "--agent"]) {
    if (parsed.flags.has(flag)) return { kind: "denied", reason: `身份边界：${flag} 由 Larkin Runtime 锁定` };
  }
  const as = parsed.flags.get("--as");
  if (as && as !== "bot") return { kind: "denied", reason: "身份边界：Runtime 内 lark-cli 只允许 Bot identity" };
  const command = parsed.commandArgv[0] || "";
  if (MANAGEMENT_COMMANDS.has(command)) return { kind: "denied", reason: `身份边界：Runtime 不开放 lark-cli ${command} 管理命令` };
  if (command === "event") return { kind: "denied", reason: "Runtime 不允许另开 event 连接与 Host 争抢事件流" };
  if (USER_ONLY_COMMANDS.has(command)) return { kind: "denied", reason: `${command} 是 user-only identity 域` };
  if (exactPath(parsed.commandArgv, ["larkin-draft", "list"])) return uniqueProtectedOperation(protectedPaths, "draft")
    ? { kind: "runtime-owned", operation: "draft-list" } : noncanonicalProtectedDecision();
  if (exactPath(parsed.commandArgv, ["larkin-draft", "send"])) return uniqueProtectedOperation(protectedPaths, "draft")
    ? { kind: "runtime-owned", operation: "draft-send" } : noncanonicalProtectedDecision();
  if (exactPath(parsed.commandArgv, ["larkin-draft", "abandon"])) return uniqueProtectedOperation(protectedPaths, "draft")
    ? { kind: "runtime-owned", operation: "draft-abandon" } : noncanonicalProtectedDecision();
  if (exactPath(parsed.commandArgv, ["im", "+messages-send"])) return uniqueProtectedOperation(protectedPaths, "send")
    ? { kind: "guarded", operation: "send" } : noncanonicalProtectedDecision();
  if (exactPath(parsed.commandArgv, ["im", "+messages-reply"])) return uniqueProtectedOperation(protectedPaths, "reply")
    ? { kind: "guarded", operation: "reply" } : noncanonicalProtectedDecision();
  if (exactPath(parsed.commandArgv, ["im", "messages", "patch"]) || exactPath(parsed.commandArgv, ["im", "messages", "update"])) {
    const expected = parsed.commandArgv[2] === "patch" ? "card-patch" : "card-update";
    return uniqueProtectedOperation(protectedPaths, expected) ? { kind: "guarded", operation: "card" } : noncanonicalProtectedDecision();
  }
  if (exactPath(parsed.commandArgv, ["im", "messages", "create"]) || exactPath(parsed.commandArgv, ["im", "messages", "reply"])) {
    const expected = parsed.commandArgv[2] === "create" ? "raw-create" : "raw-reply";
    return uniqueProtectedOperation(protectedPaths, expected)
      ? { kind: "denied", reason: "该原始 IM 写入口会旁路 target freshness；请使用 +messages-send/+messages-reply" }
      : noncanonicalProtectedDecision();
  }
  if (["forward", "merge_forward", "delete", "urgent_app", "urgent_phone", "urgent_sms"]
    .some((operation) => exactPath(parsed.commandArgv, ["im", "messages", operation]))) {
    const expected = `raw-${parsed.commandArgv[2]}` as ProtectedOperation;
    return uniqueProtectedOperation(protectedPaths, expected)
      ? { kind: "denied", reason: "该 IM 写入口无法建立 target freshness；请先用 larkin inbox poll 读取目标，再使用受保护的 +messages-send/+messages-reply" }
      : noncanonicalProtectedDecision();
  }
  if (["forward", "merge_forward"]
    .some((operation) => exactPath(parsed.commandArgv, ["im", "threads", operation]))) {
    const expected = `thread-${parsed.commandArgv[2]}` as ProtectedOperation;
    return uniqueProtectedOperation(protectedPaths, expected)
      ? { kind: "denied", reason: "该 IM forwarding 入口无法建立 target freshness；请先用 larkin inbox poll 读取目标，再使用受保护的 +messages-send/+messages-reply" }
      : noncanonicalProtectedDecision();
  }
  if (command === "api") return uniqueProtectedOperation(protectedPaths, "api")
    ? { kind: "denied", reason: "generic API 会旁路 Runtime identity/freshness policy" }
    : noncanonicalProtectedDecision();
  if (protectedPaths.length > 0) return noncanonicalProtectedDecision();
  return { kind: "passthrough" };
}

function spawnNative(
  argv: readonly string[], env: Env, io: LarkCliIo, dependencies: LarkCliLauncherDependencies,
): number {
  const native = dependencies.nativeCommand;
  const result = (dependencies.spawn ?? spawnSync)(
    native?.command ?? process.execPath,
    [...(native?.argsPrefix ?? [dependencies.upstreamScript ?? resolveUpstreamScript()]), ...argv],
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
    const chatId = policyFlagValue(argv, "--chat-id");
    const userId = policyFlagValue(argv, "--user-id");
    if (!chatId || userId) throw new Error("Runtime +messages-send 必须只使用 Inbox 已确认的 --chat-id；--user-id 无法建立 freshness target");
    return `chat:${chatId}`;
  }
  const messageId = policyFlagValue(argv, "--message-id");
  if (!messageId) throw new Error(`${decision.operation} 写入缺少 --message-id`);
  const target = store.resolveInboxMessageTarget(messageId);
  if (!target) throw new Error(`无法从 Inbox 状态确定 ${messageId} 的 target；先 poll 对应消息，禁止旁路 freshness`);
  return target;
}

function botArgv(argv: readonly string[], intentId: string): string[] {
  const next = [...argv];
  const parsed = parsePolicyArgv(next);
  const boundary = next.indexOf("--");
  const insertion = boundary < 0 ? next.length : boundary;
  const injected: string[] = [];
  if (!parsed.flags.has("--as")) injected.push("--as", "bot");
  if (!parsed.flags.has("--idempotency-key")) injected.push("--idempotency-key", intentId);
  next.splice(insertion, 0, ...injected);
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
  const nativeDependencies = dependencies.nativeCommand || dependencies.upstreamScript
    ? dependencies
    : { ...dependencies, nativeCommand: resolvePinnedLarkCliCommand(agent.stateDir) };
  const decision = classifyLarkCliCommand(argv);
  if (decision.kind === "denied") {
    io.stderr(`lark-cli: ${decision.reason}\n`);
    return 2;
  }
  if (decision.kind === "runtime-owned") {
    const store = dependencies.stateStore ?? createAgentStateStore(config.larkinHome, agent.agentId);
    const draftId = policyFlagValue(argv, "--draft-id");
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
      if (!draft || (draft.status !== "held" && draft.status !== "sending")) {
        throw new Error(`held/sending draft 不存在：${draftId}`);
      }
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
        exitCode = spawnNative(botArgv(draft.argv, intentId), privateEnv, io, nativeDependencies);
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
  if (decision.kind === "passthrough") return spawnNative(argv, privateEnv, io, nativeDependencies);
  const store = dependencies.stateStore ?? createAgentStateStore(config.larkinHome, agent.agentId);
  try {
    const target = guardedTarget(decision, argv, store);
    let exitCode = 1;
    const gated = store.withFreshnessGate({ target, argv, ...(dependencies.now ? { now: dependencies.now() } : {}) }, (intentId) => {
      exitCode = spawnNative(botArgv(argv, intentId), privateEnv, io, nativeDependencies);
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
