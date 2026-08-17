#!/usr/bin/env bun

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentStateStore, type AgentStateStore } from "../agent/agent-state-store.js";
import { evaluateFreshness, type FreshnessTarget } from "../agent/freshness-gate.js";
import {
  feishuImFreshnessAdapter, feishuImTarget, mergeFeishuImCursor, serializeFeishuImTarget,
  type FeishuImCursor, type FeishuImMessage, type FeishuImSnapshot,
} from "../feishu/im-freshness-adapter.js";
import * as larkinConfig from "../platform/config.js";
import { resolveOfficialLarkCli, type OfficialLarkCliCommand } from "./official-lark-cli.js";
import { assertAgentWorkspaceBound, managedLarkCliEnv } from "./agent-lark-cli-workspace.js";
import { parseDocumentCommentTarget } from "../feishu/document-comment.js";
import { SpanKind } from "@opentelemetry/api";
import { loadTelemetryConfig } from "../platform/telemetry-config.js";
import { telemetrySingleton, type TelemetryRuntime } from "../platform/telemetry-tracing.js";
import { packageVersion } from "../platform/build-info.js";

type Env = Record<string, string | undefined>;

export interface LarkCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface LarkCliLauncherDependencies {
  io?: LarkCliIo;
  spawn?: typeof spawnSync;
  nativeCommand?: OfficialLarkCliCommand;
  stateStore?: AgentStateStore;
  now?(): number;
  telemetry?: TelemetryRuntime;
}

function portableSignalCode(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGKILL") return 137;
  return 1;
}

export type LarkCliCommandDecision =
  | { kind: "passthrough" }
  | { kind: "guarded"; operation: "send" | "reply" | "card" | "urgent-app" }
  | { kind: "comment-reply" }
  | { kind: "denied"; reason: string };

const HELP_FLAGS = new Set(["--help", "-h"]);
const MANAGEMENT_COMMANDS = new Set(["auth", "config", "profile", "update", "install"]);
const USER_ONLY_COMMANDS = new Set(["attendance", "mail", "okr"]);
const POLICY_VALUE_FLAGS = new Set([
  "--as", "--profile", "--config-dir", "--agent", "--chat-id", "--user-id", "--message-id", "--idempotency-key", "--thread-id", "--user-id-type", "--data",
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

type ProtectedOperation = "send" | "reply" | "card-patch" | "card-update" | "urgent-app" | "raw-create" | "raw-reply"
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
  if (command === "+messages-send" || command === "+messages-reply" || command === "+messages-urgent-app" || command === "api") {
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
    else if (token === "+messages-urgent-app") operations.push("urgent-app");
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
  if (command === "comment") return exactPath(parsed.commandArgv, ["comment", "reply"])
    ? { kind: "comment-reply" }
    : { kind: "denied", reason: "comment 只支持绑定 canonical Inbox locator 的 `comment reply`" };
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
  if (exactPath(parsed.commandArgv, ["im", "+messages-urgent-app"])) {
    if (!uniqueProtectedOperation(protectedPaths, "urgent-app")) return noncanonicalProtectedDecision();
    if (parsed.commandArgv.includes("--dry-run")) {
      return { kind: "denied", reason: "+messages-urgent-app 不支持 --dry-run；官方 CLI 不认识该合成命令" };
    }
    return { kind: "guarded", operation: "urgent-app" };
  }
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

function parseCommentReply(argv: readonly string[]): { messageId: string; text: string } {
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") continue;
    const inline = ["--message-id", "--text"].find((flag) => argument.startsWith(`${flag}=`));
    const flag = inline ?? (["--message-id", "--text"].includes(argument) ? argument : null);
    if (!flag) {
      if (argument.startsWith("-")) throw new Error(`comment reply 不支持参数 ${argument}`);
      positionals.push(argument);
      continue;
    }
    if (values.has(flag)) throw new Error(`${flag} 只能指定一次`);
    const value = inline ? argument.slice(flag.length + 1) : argv[++index];
    if (value === undefined) throw new Error(`${flag} 需要值`);
    values.set(flag, value);
  }
  if (positionals.length !== 2 || positionals[0] !== "comment" || positionals[1] !== "reply") {
    throw new Error("用法: larkin comment reply --message-id <doc_comment_id> --text '<reply>' --json");
  }
  const messageId = values.get("--message-id") || "";
  const text = values.get("--text") || "";
  if (!/^doc_comment_[0-9a-f]{32}$/.test(messageId)) throw new Error("comment reply 需要 Inbox 提供的 doc_comment message id");
  if (!text.trim()) throw new Error("comment reply 的 --text 不能为空");
  if (text.length > 20_000) throw new Error("comment reply 的 --text 超过 20000 字符");
  return { messageId, text };
}

type CommentReplyLedger = {
  version: 1;
  cursors?: Record<string, unknown>;
  document_comment_replies?: Record<string, { digest: string; status: "sending" | "sent" | "failed"; updated_at: string }>;
};

type ImWriteMemoEntry = { message_id: string; updated_at: string };
type ImWriteMemoState = {
  version: 1;
  cursors?: Record<string, unknown>;
  im_write_memo?: Record<string, ImWriteMemoEntry>;
};

const IM_WRITE_MEMO_LIMIT = 512;

// 只标注、不拦截：每次成功写把「实际生效的幂等 key → 服务端返回的 message_id」记进备忘。
// 同 key 再次成功且服务端返回同一个 message_id，说明服务端走了幂等去重（没有产生新消息），
// 返回 true 供输出标注 duplicate。拦截权始终在服务端，备忘不会吞掉任何发送。
function recordImWriteMemo(store: AgentStateStore, key: string, messageId: string): boolean {
  let duplicate = false;
  store.mutateJson<ImWriteMemoState, void>("freshnessState", { version: 1, cursors: {} }, (state) => {
    state.im_write_memo ??= {};
    const prior = state.im_write_memo[key];
    if (prior && prior.message_id === messageId) duplicate = true;
    state.im_write_memo[key] = { message_id: messageId, updated_at: new Date().toISOString() };
    const keys = Object.keys(state.im_write_memo);
    for (const stale of keys.slice(0, Math.max(0, keys.length - IM_WRITE_MEMO_LIMIT))) delete state.im_write_memo[stale];
  });
  return duplicate;
}

function runCommentReply(
  argv: readonly string[], privateEnv: Env, io: LarkCliIo, dependencies: LarkCliLauncherDependencies, store: AgentStateStore,
): number {
  const input = parseCommentReply(argv);
  const targetKey = store.resolveInboxMessageTarget(input.messageId);
  const target = targetKey ? parseDocumentCommentTarget(targetKey) : null;
  if (!target) throw new Error("comment reply 无法从当前 Agent Inbox 绑定文档评论 locator；先 poll 该消息且不得跨 Agent/评论回复");
  if (!store.inboxTargetIsFresh(targetKey!)) throw new Error("comment reply 需要先 poll 当前 document-comment target 的最新 Inbox 消息");
  const digest = createHash("sha256").update(input.text).digest("hex");
  const claim = store.mutateJson<CommentReplyLedger, "ready" | "sent" | "ambiguous" | "conflict">(
    "freshnessState", { version: 1, cursors: {} }, (state) => {
      state.document_comment_replies ??= {};
      const prior = state.document_comment_replies[input.messageId];
      if (prior?.status === "sent" && prior.digest === digest) return "sent";
      if (prior?.status === "sending" && prior.digest === digest) return "ambiguous";
      if (prior && prior.status !== "failed" && prior.digest !== digest) return "conflict";
      state.document_comment_replies[input.messageId] = { digest, status: "sending", updated_at: new Date().toISOString() };
      const keys = Object.keys(state.document_comment_replies);
      for (const stale of keys.slice(0, Math.max(0, keys.length - 512))) delete state.document_comment_replies[stale];
      return "ready";
    },
  );
  if (claim === "sent") {
    io.stdout(`${JSON.stringify({ ok: true, identity: "bot", committed: true, duplicate: true, target: targetKey })}\n`);
    return 0;
  }
  if (claim === "ambiguous") throw new Error("comment reply 上次调用结果不明确，已 fail-closed 以避免重复评论；请由用户检查原评论线程");
  if (claim === "conflict") throw new Error("comment reply 已为同一 Inbox 消息提交不同正文，拒绝覆盖或重复发送");
  const nativeArgs = target.topLevel
    ? [
        "drive", "file.comments", "create_v2",
        "--file-token", target.fileToken,
        "--data", JSON.stringify({
          file_type: target.fileType,
          reply_elements: [{ type: "text", text: input.text }],
        }),
        "--as", "bot",
      ]
    : [
        "drive", "file.comment.replys", "create",
        "--file-token", target.fileToken,
        "--comment-id", target.commentId,
        "--file-type", target.fileType,
        "--data", JSON.stringify({
          content: { elements: [{ type: "text_run", text_run: { text: input.text } }] },
        }),
        "--as", "bot",
      ];
  const result = callNative(nativeArgs, privateEnv, io, dependencies);
  const terminalStatus = !result.error && result.status === 0 ? "sent"
    : definitiveProviderRejection(result) ? "failed" : null;
  if (terminalStatus) {
    store.mutateJson<CommentReplyLedger, void>("freshnessState", { version: 1, cursors: {} }, (state) => {
      state.document_comment_replies ??= {};
      state.document_comment_replies[input.messageId] = {
        digest,
        status: terminalStatus,
        updated_at: new Date().toISOString(),
      };
    });
  }
  return emitNativeResult(result, io);
}

function definitiveProviderRejection(result: SpawnSyncReturns<string>): boolean {
  if (result.error || result.signal || result.status === null || result.status === 0) return false;
  for (const text of [result.stdout, result.stderr]) {
    let value: unknown;
    try { value = JSON.parse(text || ""); } catch { continue; }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const response = value as { ok?: unknown; code?: unknown; error?: unknown };
    const error = response.error && typeof response.error === "object" && !Array.isArray(response.error)
      ? response.error as { code?: unknown } : null;
    if ((response.ok === false || (typeof response.code === "number" && response.code !== 0))
        && ((typeof response.code === "number" && response.code !== 0)
          || (typeof error?.code === "number" && error.code !== 0))) return true;
  }
  return false;
}

function callNative(
  argv: readonly string[], env: Env, io: LarkCliIo, dependencies: LarkCliLauncherDependencies,
): SpawnSyncReturns<string> {
  const native = dependencies.nativeCommand;
  const result = (dependencies.spawn ?? spawnSync)(
    native?.command ?? resolveOfficialLarkCli({ spawn: dependencies.spawn, env }).command,
    [...(native?.argsPrefix ?? []), ...argv],
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
    io.stderr(`lark-cli: official launcher failed: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? (result.signal ? portableSignalCode(result.signal) : 1);
}

async function spawnNativeTransparent(
  argv: readonly string[], env: Env, native: OfficialLarkCliCommand,
): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = spawn(native.command, [...native.argsPrefix, ...argv], {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: "inherit",
    });
    const forward = (signal: NodeJS.Signals) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    const cleanup = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    child.once("error", (error) => {
      cleanup();
      process.stderr.write(`lark-cli: official launcher failed: ${error.message}\n`);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (!signal) return resolve(code ?? 1);
      const fallback = portableSignalCode(signal);
      try { process.kill(process.pid, signal); } catch { resolve(fallback); }
      // A registered/unsupported platform signal may not terminate the process.
      setImmediate(() => resolve(fallback));
    });
  });
}

function guardedTarget(decision: Extract<LarkCliCommandDecision, { kind: "guarded" }>, argv: readonly string[], store: AgentStateStore): FreshnessTarget {
  if (decision.operation === "send" || decision.operation === "urgent-app") {
    const chatId = policyFlagValue(argv, "--chat-id");
    const userId = policyFlagValue(argv, "--user-id");
    if (!chatId || userId) {
      throw new Error(decision.operation === "urgent-app"
        ? "Runtime +messages-urgent-app 必须只使用 Inbox 已确认的 --chat-id；--user-id 无法建立 freshness target"
        : "Runtime +messages-send 必须只使用 Inbox 已确认的 --chat-id；--user-id 无法建立 freshness target");
    }
    return feishuImTarget(`chat:${chatId}`);
  }
  const messageId = policyFlagValue(argv, "--message-id");
  if (!messageId) throw new Error(`${decision.operation} 写入缺少 --message-id`);
  const target = store.resolveInboxMessageTarget(messageId);
  if (!target) throw new Error(`无法从 Inbox 状态确定 ${messageId} 的 target；先 poll 对应消息，禁止旁路 freshness`);
  return feishuImTarget(target);
}

function botArgv(argv: readonly string[], intentId: string, decision?: Extract<LarkCliCommandDecision, { kind: "guarded" }>): string[] {
  const next = [...argv];
  const parsed = parsePolicyArgv(next);
  const boundary = next.indexOf("--");
  const insertion = boundary < 0 ? next.length : boundary;
  const injected: string[] = [];
  if (!parsed.flags.has("--as")) injected.push("--as", "bot");
  if (decision?.operation !== "urgent-app" && !parsed.flags.has("--idempotency-key")) injected.push("--idempotency-key", intentId);
  next.splice(insertion, 0, ...injected);
  if (decision?.operation !== "urgent-app") return next;
  const rewritten: string[] = [];
  for (let index = 0; index < next.length; index += 1) {
    const argument = next[index];
    if (argument === "+messages-urgent-app") {
      rewritten.push("messages", "urgent_app");
      continue;
    }
    if (argument === "--chat-id" || argument === "--idempotency-key") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--chat-id=") || argument.startsWith("--idempotency-key=")) continue;
    rewritten.push(argument);
  }
  return rewritten;
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label} 必须是 JSON 对象`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 对象`);
  return parsed as Record<string, unknown>;
}

function senderRecord(message: FeishuImMessage): Record<string, unknown> | null {
  const sender = message.sender;
  return sender && typeof sender === "object" && !Array.isArray(sender) ? sender as Record<string, unknown> : null;
}

function isOwnBotMessage(message: FeishuImMessage, feishuAppId: string): boolean {
  const sender = senderRecord(message);
  if (!sender) return false;
  const senderType = sender.sender_type;
  const senderId = sender.id ?? sender.sender_id;
  return senderType === "app" && senderId === feishuAppId;
}

function assertUrgentAppPreconditions(
  argv: readonly string[],
  snapshot: FeishuImSnapshot,
  target: FreshnessTarget,
  feishuAppId: string,
): void {
  const messageId = policyFlagValue(argv, "--message-id");
  if (!messageId || !/^om_/.test(messageId)) throw new Error("Runtime +messages-urgent-app 只接受真实 Feishu om_ message_id");
  const userIdType = policyFlagValue(argv, "--user-id-type");
  if (userIdType !== "open_id") throw new Error("Runtime +messages-urgent-app 必须使用 --user-id-type open_id");
  const data = policyFlagValue(argv, "--data");
  if (!data) throw new Error("Runtime +messages-urgent-app 缺少 --data");
  const body = parseJsonObject(data, "--data");
  const userIds = body.user_id_list;
  if (!Array.isArray(userIds) || userIds.length === 0 || userIds.some((value) => typeof value !== "string" || !value.startsWith("ou_"))) {
    throw new Error("Runtime +messages-urgent-app 的 user_id_list 必须是非空 open_id 列表");
  }
  const message = snapshot.messages.find((row) => row.message_id === messageId);
  if (!message) throw new Error(`无法在当前 freshness 窗口确认 ${messageId}；禁止旁路加急未知消息`);
  if (target.resourceKind === "chat" && message.chat_id && message.chat_id !== target.resourceId) {
    throw new Error("加急目标消息不属于当前 chat freshness target");
  }
  if (!isOwnBotMessage(message, feishuAppId)) throw new Error("Runtime +messages-urgent-app 只能加急当前 Bot 自己发出的消息");
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

// 防重编号只由 target + argv 决定：同一逻辑命令的重试永远得到同一个 key，
// 服务端幂等去重才能生效。cursor（freshness 水位）会随每次观察读/冲突合并推进，
// 掺入会让「已送达但回执丢失」的重试漂移成新 key，从而发出第二条消息。
function intentId(target: string, argv: readonly string[]): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([target, argv])).digest("hex");
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
    io.stderr(`lark-cli: official launcher failed: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? (result.signal ? portableSignalCode(result.signal) : 1);
}

function requiresCapturedPassthrough(argv: readonly string[]): boolean {
  const effectiveArgv = boundedHistoryArgv(argv);
  return conditionalHeadReadTarget(effectiveArgv) !== null || eligibleThreadHeadRead(effectiveArgv) !== null;
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
    io.stderr(`lark-cli: official launcher failed: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? (result.signal ? portableSignalCode(result.signal) : 1);
}

function emitDuplicatedWrite(
  result: SpawnSyncReturns<string>,
  io: LarkCliIo,
  input: { target: string },
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
    duplicate: true,
    target: input.target,
    ...(result.stderr ? { provider_stderr_present: true } : {}),
  })}\n`);
  return 0;
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
  const effectiveArgv = argv;
  const runtimeAgentId = larkinConfig.resolveRuntimeAuthority(env);
  if (!runtimeAgentId) {
    try {
      const nativeDependencies = dependencies.nativeCommand ? dependencies
        : { ...dependencies, nativeCommand: resolveOfficialLarkCli({ spawn: dependencies.spawn, env }) };
      return spawnNative(effectiveArgv, env, io, nativeDependencies);
    } catch (error) {
      io.stderr(`lark-cli: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  let config: larkinConfig.HydratedConfig;
  let agent: larkinConfig.HydratedAgent;
  try {
    ({ config } = larkinConfig.loadConfig(env));
    agent = larkinConfig.selectAgent(config, { ...env, LARKIN_AGENT_ID: runtimeAgentId });
  } catch (error) {
    io.stderr(`lark-cli: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const decision = classifyLarkCliCommand(effectiveArgv);
  if (decision.kind === "denied") {
    io.stderr(`lark-cli: ${decision.reason}\n`);
    return 2;
  }
  const privateEnv = managedLarkCliEnv(agent, { ...env, LARKIN_AGENT_ID: agent.agentId });
  let nativeDependencies: LarkCliLauncherDependencies;
  try {
    nativeDependencies = dependencies.nativeCommand ? dependencies
      : { ...dependencies, nativeCommand: resolveOfficialLarkCli({ spawn: dependencies.spawn, env: privateEnv }) };
  } catch (error) {
    io.stderr(`lark-cli: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const store = dependencies.stateStore ?? createAgentStateStore(config.larkinHome, agent.agentId);
  if (decision.kind === "comment-reply") {
    try {
      let telemetry = dependencies.telemetry ?? telemetrySingleton();
      if (!dependencies.telemetry) {
        try {
          const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
          telemetry = telemetrySingleton(loadTelemetryConfig(env), { serviceVersion: packageVersion(sourceRoot) });
        } catch { /* telemetry is failure-isolated */ }
      }
      return telemetry.externalPhase(agent.agentId, store.paths.root, "document.comment.reply", SpanKind.CLIENT,
        () => runCommentReply(argv, privateEnv, io, nativeDependencies, store), "comment_cli") as number;
    }
    catch (error) {
      io.stderr(`lark-cli: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  if (decision.kind === "passthrough") return passthroughWithObservation(effectiveArgv, privateEnv, io, nativeDependencies, store);
  try {
    const target = guardedTarget(decision, effectiveArgv, store);
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
    if (decision.operation === "urgent-app") {
      assertUrgentAppPreconditions(effectiveArgv, gated.snapshot, target, agent.feishuAppId);
    }
    const intentKey = policyFlagValue(effectiveArgv, "--idempotency-key") ?? intentId(targetKey, effectiveArgv);
    const write = callNative(botArgv(effectiveArgv, intentKey, decision), privateEnv, io, nativeDependencies);
    if (decision.operation === "urgent-app") return emitNativeResult(write, io);
    const writeMessage = writeResponseMessage(write);
    const duplicate = !write.error && write.status === 0 && writeMessage
      ? recordImWriteMemo(store, intentKey, writeMessage.message_id) : false;
    if (duplicate) {
      observeSuccessfulWrite(write, target, targetKey, store, generation);
      emitDuplicatedWrite(write, io, { target: targetKey });
      return 0;
    }
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

export async function runLarkCliProcess(argv: readonly string[], env: Env = process.env): Promise<number> {
  const effectiveArgv = argv;
  const runtimeAgentId = larkinConfig.resolveRuntimeAuthority(env);
  if (!runtimeAgentId) {
    try {
      return await spawnNativeTransparent(effectiveArgv, env, resolveOfficialLarkCli({ env }));
    } catch (error) {
      process.stderr.write(`lark-cli: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  try {
    const { config } = larkinConfig.loadConfig(env);
    const agent = larkinConfig.selectAgent(config, { ...env, LARKIN_AGENT_ID: runtimeAgentId });
    assertAgentWorkspaceBound(agent);
    const decision = classifyLarkCliCommand(effectiveArgv);
    if (decision.kind === "passthrough" && !requiresCapturedPassthrough(effectiveArgv)) {
      const privateEnv = managedLarkCliEnv(agent, { ...env, LARKIN_AGENT_ID: agent.agentId });
      return await spawnNativeTransparent(effectiveArgv, privateEnv, resolveOfficialLarkCli({ env: privateEnv }));
    }
  } catch (error) {
    process.stderr.write(`lark-cli: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  return runLarkCli(effectiveArgv, env);
}

export async function main(argv = process.argv.slice(2), env: Env = process.env): Promise<never> {
  process.exit(await runLarkCliProcess(argv, env));
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))) void main();
