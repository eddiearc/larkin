#!/usr/bin/env bun

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentStateStore, type AgentStateStore } from "../agent/agent-state-store.js";
import { evaluateFreshness, type FreshnessTarget } from "../agent/freshness-gate.js";
import {
  feishuImFreshnessAdapter, feishuImTarget, mergeFeishuImCursor, serializeFeishuImTarget,
  type FeishuImCursor, type FeishuImMessage, type FeishuImSnapshot,
} from "../feishu/im-freshness-adapter.js";
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
  | { kind: "denied"; reason: string };

const HELP_FLAGS = new Set(["--help", "-h"]);
const MANAGEMENT_COMMANDS = new Set(["auth", "config", "profile", "update", "install"]);
const USER_ONLY_COMMANDS = new Set(["attendance", "mail", "okr"]);
const POLICY_VALUE_FLAGS = new Set([
  "--as", "--profile", "--config-dir", "--agent", "--chat-id", "--user-id", "--message-id", "--idempotency-key", "--thread-id",
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
const HISTORY_VALUE_FLAGS = new Set([
  ...POLICY_VALUE_FLAGS,
  "--start", "--end", "--order", "--sort", "--page-size", "--page-token", "--thread",
  "--format", "--jq", "-q", "--download-dir",
]);

type ProtectedOperation = "send" | "reply" | "card-patch" | "card-update" | "raw-create" | "raw-reply"
  | "raw-forward" | "raw-merge_forward" | "raw-delete" | "raw-urgent_app" | "raw-urgent_phone" | "raw-urgent_sms"
  | "thread-forward" | "thread-merge_forward" | "api";

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

function hasCanonicalUnprotectedCommandPath(argv: readonly string[]): boolean {
  const nativeArgv = nativeArgvBeforeBoundary(argv);
  const service = nativeArgv[0];
  const command = nativeArgv[1];
  if (!service || service.startsWith("-") || !command || command.startsWith("-")) return false;
  if (service !== "im") return service !== "api" && service !== "larkin-draft";
  if (command === "+messages-send" || command === "+messages-reply" || command === "api") {
    return false;
  }
  if (command.startsWith("+")) return true;
  const operation = nativeArgv[2];
  if (!operation || operation.startsWith("-") || operation === "api" || operation === "larkin-draft") return false;
  if (command === "messages" && RAW_IM_WRITE_OPERATIONS.has(operation)) return false;
  if (command === "threads" && (operation === "forward" || operation === "merge_forward")) return false;
  return true;
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
  for (const flag of ["--profile", "--config-dir", "--agent"]) {
    if (parsed.flags.has(flag)) return { kind: "denied", reason: `身份边界：${flag} 由 Larkin Runtime 锁定` };
  }
  const as = parsed.flags.get("--as");
  if (as && as !== "bot") return { kind: "denied", reason: "身份边界：Runtime 内 lark-cli 只允许 Bot identity" };
  const command = parsed.commandArgv[0] || "";
  if (MANAGEMENT_COMMANDS.has(command)) return { kind: "denied", reason: `身份边界：Runtime 不开放 lark-cli ${command} 管理命令` };
  if (command === "event") return { kind: "denied", reason: "Runtime 不允许另开 event 连接与 Host 争抢事件流" };
  if (USER_ONLY_COMMANDS.has(command)) return { kind: "denied", reason: `${command} 是 user-only identity 域` };
  if (hasCanonicalUnprotectedCommandPath(argv)) return { kind: "passthrough" };
  const protectedPaths = protectedOperations(argv);
  if (command === "larkin-draft") return { kind: "denied", reason: "larkin-draft 已移除；freshness conflict 后请重新判断并执行普通写命令" };
  if (exactPath(parsed.commandArgv, ["im", "+messages-send"])) return uniqueProtectedOperation(protectedPaths, "send")
    ? (parsed.flags.has("--thread-id")
      ? { kind: "denied", reason: "+messages-send 不支持 --thread-id；线程内写入请使用 +messages-reply --message-id ... --reply-in-thread" }
      : parsed.commandArgv.includes("--dry-run") ? { kind: "passthrough" } : { kind: "guarded", operation: "send" })
    : noncanonicalProtectedDecision();
  if (exactPath(parsed.commandArgv, ["im", "+messages-reply"])) return uniqueProtectedOperation(protectedPaths, "reply")
    ? (parsed.commandArgv.includes("--dry-run") ? { kind: "passthrough" } : { kind: "guarded", operation: "reply" })
    : noncanonicalProtectedDecision();
  if (exactPath(parsed.commandArgv, ["im", "messages", "patch"]) || exactPath(parsed.commandArgv, ["im", "messages", "update"])) {
    const expected = parsed.commandArgv[2] === "patch" ? "card-patch" : "card-update";
    return uniqueProtectedOperation(protectedPaths, expected)
      ? (parsed.commandArgv.includes("--dry-run") ? { kind: "passthrough" } : { kind: "guarded", operation: "card" })
      : noncanonicalProtectedDecision();
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

function callNative(
  argv: readonly string[], env: Env, io: LarkCliIo, dependencies: LarkCliLauncherDependencies,
): SpawnSyncReturns<string> {
  const native = dependencies.nativeCommand;
  const result = (dependencies.spawn ?? spawnSync)(
    native?.command ?? process.execPath,
    [...(native?.argsPrefix ?? [dependencies.upstreamScript ?? resolveUpstreamScript()]), ...argv],
    { encoding: "utf8", env: { ...process.env, ...env } },
  ) as SpawnSyncReturns<string>;
  return result;
}

function spawnNative(
  argv: readonly string[], env: Env, io: LarkCliIo, dependencies: LarkCliLauncherDependencies,
): number {
  const result = callNative(argv, env, io, dependencies);
  if (result.stdout) io.stdout(result.stdout);
  if (result.stderr) io.stderr(result.stderr);
  if (result.error) {
    io.stderr(`lark-cli: package-local launcher failed: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function guardedTarget(decision: Extract<LarkCliCommandDecision, { kind: "guarded" }>, argv: readonly string[], store: AgentStateStore): FreshnessTarget {
  if (decision.operation === "send") {
    const chatId = policyFlagValue(argv, "--chat-id");
    const userId = policyFlagValue(argv, "--user-id");
    if (!chatId || userId) throw new Error("Runtime +messages-send 必须只使用 Inbox 已确认的 --chat-id；--user-id 无法建立 freshness target");
    return feishuImTarget(`chat:${chatId}`);
  }
  const messageId = policyFlagValue(argv, "--message-id");
  if (!messageId) throw new Error(`${decision.operation} 写入缺少 --message-id`);
  const target = store.resolveInboxMessageTarget(messageId);
  if (!target) throw new Error(`无法从 Inbox 状态确定 ${messageId} 的 target；先 poll 对应消息，禁止旁路 freshness`);
  return feishuImTarget(target);
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

function probeArgv(target: FreshnessTarget): string[] {
  if (target.provider !== "feishu.im") throw new Error(`unsupported freshness provider: ${target.provider}`);
  if (target.resourceKind === "chat") {
    return ["api", "GET", "/open-apis/im/v1/messages", "--params", JSON.stringify({
      container_id_type: "chat", container_id: target.resourceId, sort_type: "ByCreateTimeDesc", page_size: 20,
    }), "--as", "bot"];
  }
  if (target.resourceKind === "thread") {
    const slash = target.resourceId.indexOf("/");
    const threadId = slash >= 0 ? target.resourceId.slice(slash + 1) : "";
    if (!threadId) throw new Error("thread freshness target is malformed");
    return ["api", "GET", "/open-apis/im/v1/messages", "--params", JSON.stringify({
      container_id_type: "thread", container_id: threadId, sort_type: "ByCreateTimeDesc", page_size: 20,
    }), "--as", "bot"];
  }
  throw new Error(`unsupported freshness resource: ${target.resourceKind}`);
}

function parseHistory(result: SpawnSyncReturns<string>, target: FreshnessTarget, requireBotIdentity = false): FeishuImSnapshot {
  if (result.error) throw new Error(`authoritative history probe failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`authoritative history probe exited ${result.status ?? "without status"}: ${result.stderr || "no details"}`);
  let value: unknown;
  try { value = JSON.parse(result.stdout || ""); } catch { throw new Error("authoritative history probe returned non-JSON output"); }
  const root = value as { ok?: unknown; identity?: unknown; data?: { messages?: unknown; items?: unknown } } | null;
  if (!root || root.ok !== true || !root.data) throw new Error("authoritative history probe returned an unsuccessful payload");
  if (requireBotIdentity && root.identity !== "bot") throw new Error("authoritative history probe did not confirm Bot identity");
  const rows = root.data.messages ?? root.data.items;
  if (!Array.isArray(rows)) throw new Error("authoritative history probe omitted messages");
  const messages = rows as FeishuImMessage[];
  for (const message of messages) {
    if (!message || typeof message !== "object" || typeof message.message_id !== "string" || !message.message_id) {
      throw new Error("authoritative history payload contained a message without message_id");
    }
    if (target.resourceKind === "chat" && message.chat_id !== target.resourceId) {
      throw new Error("authoritative history payload crossed chat target boundary");
    }
    if (target.resourceKind === "thread") {
      const [chatId, threadId] = target.resourceId.split("/", 2);
      if (message.chat_id !== chatId || message.thread_id !== threadId) {
        throw new Error("authoritative history payload crossed thread target boundary");
      }
    }
  }
  return { messages };
}

function intentId(target: string, cursor: FeishuImCursor | null, argv: readonly string[]): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([target, cursor, argv])).digest("hex");
  return `larkin-${fingerprint.slice(0, 32)}`;
}

function emitFreshnessError(io: LarkCliIo, input: {
  subtype: "freshness_conflict" | "freshness_unavailable";
  target: string;
  current?: FeishuImCursor;
  messages?: FeishuImMessage[];
  reason?: string;
}): void {
  io.stderr(`${JSON.stringify({
    ok: false,
    identity: "bot",
    error: { type: input.subtype === "freshness_conflict" ? "conflict" : "unavailable", subtype: input.subtype,
      ...(input.reason ? { message: input.reason } : {}) },
    target: input.target,
    ...(input.current ? { current_cursor: input.current } : {}),
    ...(input.messages ? { unseen_messages: input.messages } : {}),
    next: "Reconsider the returned context, then retry the ordinary send/reply/card command; history is probed again before every write.",
  })}\n`);
}

function freshnessGeneration(env: Env): string {
  return typeof env.LARKIN_RUNTIME_OBSERVATION_GENERATION === "string" && env.LARKIN_RUNTIME_OBSERVATION_GENERATION
    ? env.LARKIN_RUNTIME_OBSERVATION_GENERATION : "external";
}

function rawFlagValue(argv: readonly string[], flag: string): string | null {
  const nativeArgv = nativeArgvBeforeBoundary(argv);
  const direct = nativeArgv.indexOf(flag);
  if (direct >= 0) return nativeArgv[direct + 1] ?? null;
  const inline = nativeArgv.find((argument) => argument.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

function historyShortcut(argv: readonly string[]): "+chat-messages-list" | "+threads-messages-list" | null {
  const positional: string[] = [];
  const nativeArgv = nativeArgvBeforeBoundary(argv);
  for (let index = 0; index < nativeArgv.length; index += 1) {
    const argument = nativeArgv[index];
    const inlineFlag = [...HISTORY_VALUE_FLAGS].find((flag) => argument.startsWith(`${flag}=`));
    if (inlineFlag) continue;
    if (HISTORY_VALUE_FLAGS.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    positional.push(argument);
  }
  if (positional.length !== 2 || positional[0] !== "im") return null;
  return positional[1] === "+chat-messages-list" || positional[1] === "+threads-messages-list"
    ? positional[1] : null;
}

function boundedHistoryArgv(argv: readonly string[]): string[] {
  if (!historyShortcut(argv)) return [...argv];
  const boundary = argv.indexOf("--");
  const commandArgv = boundary < 0 ? argv : argv.slice(0, boundary);
  if (commandArgv.includes("--page-size")
      || commandArgv.some((argument) => argument.startsWith("--page-size="))) return [...argv];
  const next = [...argv];
  next.splice(boundary < 0 ? next.length : boundary, 0, "--page-size", "20");
  return next;
}

function conditionalHeadReadTarget(argv: readonly string[]): FreshnessTarget | null {
  if (["--page-token", "--start", "--end", "--jq", "-q"].some((flag) => argv.includes(flag)
      || argv.some((argument) => argument.startsWith(`${flag}=`)))) return null;
  const format = rawFlagValue(argv, "--format");
  if (format && format !== "json") return null;
  if (historyShortcut(argv) === "+chat-messages-list") {
    const chatId = rawFlagValue(argv, "--chat-id");
    const order = rawFlagValue(argv, "--order") ?? "desc";
    return chatId && order === "desc" ? feishuImTarget(`chat:${chatId}`) : null;
  }
  return null;
}

function eligibleThreadHeadRead(argv: readonly string[]): string | null {
  if (historyShortcut(argv) !== "+threads-messages-list") return null;
  if (["--page-token", "--jq", "-q"].some((flag) => argv.includes(flag)
      || argv.some((argument) => argument.startsWith(`${flag}=`)))) return null;
  const format = rawFlagValue(argv, "--format");
  const order = rawFlagValue(argv, "--order") ?? "asc";
  return (!format || format === "json") && order === "desc" ? rawFlagValue(argv, "--thread") : null;
}

function displayedHeadIds(result: SpawnSyncReturns<string>, target: FreshnessTarget): string[] {
  if (result.error || result.status !== 0) throw new Error("displayed history read failed");
  const value = JSON.parse(result.stdout || "") as { ok?: unknown; data?: { messages?: unknown; items?: unknown } };
  const rows = value?.ok === true && value.data ? (value.data.messages ?? value.data.items) : null;
  if (!Array.isArray(rows)) throw new Error("displayed history omitted messages");
  const ids: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error("displayed history contained a malformed message");
    const message = row as { message_id?: unknown; chat_id?: unknown; thread_id?: unknown };
    if (typeof message.message_id !== "string" || !message.message_id) throw new Error("displayed history omitted message_id");
    if (target.resourceKind === "chat" && message.chat_id !== target.resourceId) throw new Error("displayed history crossed chat target boundary");
    if (target.resourceKind === "thread") {
      const [chatId, threadId] = target.resourceId.split("/", 2);
      if (message.chat_id !== chatId || message.thread_id !== threadId) throw new Error("displayed history crossed thread target boundary");
    }
    ids.push(message.message_id);
  }
  return ids;
}

function passthroughWithObservation(
  argv: readonly string[], env: Env, io: LarkCliIo, dependencies: LarkCliLauncherDependencies, store: AgentStateStore,
): number {
  const effectiveArgv = boundedHistoryArgv(argv);
  const result = callNative(effectiveArgv, env, io, dependencies);
  let target = conditionalHeadReadTarget(effectiveArgv);
  const threadLocator = eligibleThreadHeadRead(effectiveArgv);
  if (!target && threadLocator && !result.error && result.status === 0) {
    try {
      const value = JSON.parse(result.stdout || "") as { ok?: unknown; data?: { messages?: unknown; items?: unknown } };
      const rows = value?.ok === true && value.data ? (value.data.messages ?? value.data.items) : null;
      if (Array.isArray(rows) && rows.length > 0) {
        const locators = new Set(rows.map((row) => {
          if (!row || typeof row !== "object") return "";
          const message = row as { chat_id?: unknown; thread_id?: unknown };
          return typeof message.chat_id === "string" && typeof message.thread_id === "string"
            ? `${message.chat_id}:${message.thread_id}` : "";
        }));
        if (locators.size === 1 && !locators.has("")) {
          const [chatId, threadId] = [...locators][0].split(":", 2);
          if (threadId === threadLocator || threadLocator.startsWith("om_")) target = feishuImTarget(`thread:${chatId}:${threadId}`);
        }
      }
    } catch { /* non-JSON successful output cannot establish a head cursor */ }
  }
  if (target && !result.error && result.status === 0) {
    try {
      const displayedIds = displayedHeadIds(result, target);
      const rawSnapshot = parseHistory(callNative(probeArgv(target), env, io, dependencies), target, true);
      const rawIds = rawSnapshot.messages.map((message) => message.message_id);
      if (displayedIds.length !== rawIds.length
          || new Set(displayedIds).size !== displayedIds.length
          || new Set(rawIds).size !== rawIds.length
          || displayedIds.some((id) => !rawIds.includes(id))) {
        throw new Error("displayed and raw history heads did not reconcile");
      }
      const cursor = feishuImFreshnessAdapter.cursor(rawSnapshot);
      if (cursor) store.mergeFreshnessCursor(serializeFeishuImTarget(target), cursor, mergeFeishuImCursor, freshnessGeneration(env));
    } catch { /* successful displayed bytes remain authoritative; failed raw reconciliation never advances seen */ }
  }
  if (result.stdout) io.stdout(result.stdout);
  if (result.stderr) io.stderr(result.stderr);
  if (result.error) {
    io.stderr(`lark-cli: package-local launcher failed: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function writeResponseMessage(result: SpawnSyncReturns<string>): FeishuImMessage | null {
  try {
    const value = JSON.parse(result.stdout || "") as { ok?: unknown; data?: unknown };
    if (value?.ok !== true || !value.data || typeof value.data !== "object" || Array.isArray(value.data)) return null;
    const data = value.data as Record<string, unknown>;
    const candidate = data.message && typeof data.message === "object" && !Array.isArray(data.message)
      ? data.message as FeishuImMessage : data as FeishuImMessage;
    return typeof candidate.message_id === "string" && candidate.message_id ? candidate : null;
  } catch { return null; }
}

function observeSuccessfulWrite(
  result: SpawnSyncReturns<string>, target: FreshnessTarget, targetKey: string, store: AgentStateStore, generation: string,
): boolean {
  if (result.error || result.status !== 0) return false;
  try {
    const candidate = writeResponseMessage(result);
    if (!candidate) return false;
    const snapshot = parseHistory({ ...result, stdout: JSON.stringify({ ok: true, data: { messages: [candidate] } }) }, target);
    const cursor = feishuImFreshnessAdapter.cursor(snapshot);
    if (cursor) store.mergeFreshnessCursor(targetKey, cursor, mergeFeishuImCursor, generation);
    return cursor !== null;
  } catch { return false; }
}

function emitNativeResult(result: SpawnSyncReturns<string>, io: LarkCliIo): number {
  if (result.stdout) io.stdout(result.stdout);
  if (result.stderr) io.stderr(result.stderr);
  if (result.error) {
    io.stderr(`lark-cli: package-local launcher failed: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function emitCommittedUnverified(
  result: SpawnSyncReturns<string>,
  io: LarkCliIo,
  input: { target: string; reason: string; current?: FeishuImCursor; messages?: FeishuImMessage[] },
): number {
  let providerResponse: unknown;
  try { providerResponse = JSON.parse(result.stdout || ""); }
  catch { providerResponse = { raw_stdout: result.stdout || "" }; }
  const providerDocument = providerResponse && typeof providerResponse === "object" && !Array.isArray(providerResponse)
    ? providerResponse as Record<string, unknown>
    : { provider_response: providerResponse };
  io.stdout(`${JSON.stringify({
    ...providerDocument,
    ok: true,
    committed: true,
    verified: false,
    cursor_advanced: false,
    target: input.target,
    verification: {
      status: "unverified",
      subtype: "post_write_unverified",
      message: input.reason,
      ...(input.current ? { current_cursor: input.current } : {}),
      ...(input.messages ? { unseen_messages: input.messages } : {}),
    },
    ...(result.stderr ? { provider_stderr_present: true } : {}),
  })}\n`);
  return 0;
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
  const store = dependencies.stateStore ?? createAgentStateStore(config.larkinHome, agent.agentId);
  if (decision.kind === "passthrough") return passthroughWithObservation(argv, privateEnv, io, nativeDependencies, store);
  try {
    const target = guardedTarget(decision, argv, store);
    const targetKey = serializeFeishuImTarget(target);
    const generation = freshnessGeneration(privateEnv);
    const seen = store.readFreshnessCursor<FeishuImCursor>(targetKey, generation);
    const gated = evaluateFreshness({
      seen,
      adapter: feishuImFreshnessAdapter,
      probe: () => parseHistory(callNative(probeArgv(target), privateEnv, io, nativeDependencies), target, true),
    });
    if (gated.status === "unavailable") {
      emitFreshnessError(io, { subtype: "freshness_unavailable", target: targetKey, reason: gated.reason });
      return 3;
    }
    if (gated.status === "conflict") {
      emitFreshnessError(io, { subtype: "freshness_conflict", target: targetKey, current: gated.current, messages: gated.context });
      store.mergeFreshnessCursor(targetKey, gated.current, mergeFeishuImCursor, generation);
      return 3;
    }
    const write = callNative(botArgv(argv, intentId(targetKey, gated.current, argv)), privateEnv, io, nativeDependencies);
    if (!write.error && write.status === 0 && !observeSuccessfulWrite(write, target, targetKey, store, generation)) {
      const responseMessage = writeResponseMessage(write);
      try {
        const postSnapshot = parseHistory(callNative(probeArgv(target), privateEnv, io, nativeDependencies), target, true);
        const postCursor = feishuImFreshnessAdapter.cursor(postSnapshot);
        const unseenAfterWrite = feishuImFreshnessAdapter.unseen(gated.current, postSnapshot);
        const confirmedOwnWrite = responseMessage && postCursor
          && unseenAfterWrite.some((message) => message.message_id === responseMessage.message_id)
          && unseenAfterWrite.every((message) => message.message_id === responseMessage.message_id);
        if (!confirmedOwnWrite) {
          return emitCommittedUnverified(write, io, {
            target: targetKey,
            ...(postCursor ? { current: postCursor } : {}),
            messages: unseenAfterWrite,
            reason: responseMessage
              ? "provider write succeeded but bounded post-write probe found an additional concurrent update; cursor was not advanced"
              : "provider write succeeded without a message id/revision and bounded post-write probe could not identify the write; cursor was not advanced",
          });
        }
        store.mergeFreshnessCursor(targetKey, postCursor, mergeFeishuImCursor, generation);
      } catch {
        return emitCommittedUnverified(write, io, {
          target: targetKey,
          reason: "provider write succeeded but bounded post-write confirmation was unavailable; cursor was not advanced",
        });
      }
    }
    return emitNativeResult(write, io);
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
