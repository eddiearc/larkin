#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { SpanKind } from "@opentelemetry/api";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { createAgentStateStore, type AgentStateStore } from "../agent/agent-state-store.js";
import * as larkinConfig from "../platform/config.js";
import { projectInboxCheck, projectInboxEvents, type InboxEnvelope } from "../agent/inbox-projection.js";
import { createReminderRoutes } from "../agent/reminder-routes.js";
import { InteractionStateMachine } from "../agent/interaction-state-machine.js";
import { issueCallbackProbe, readCallbackCapability } from "../platform/callback-capability.js";
import { requestAgentUpsert } from "./local-control.js";
export { AGENT_CLI_CAPABILITIES } from "../agent/agent-cli-capabilities.js";
import { AGENT_CLI_CAPABILITIES } from "../agent/agent-cli-capabilities.js";
import { CONFIG_CLI_USAGE, CONFIG_CLI_VALUES } from "../agent/config-cli-contract.js";
import { internalCommandSpec } from "./internal-command.js";
import { packageVersion } from "../platform/build-info.js";
import { loadTelemetryConfig } from "../platform/telemetry-config.js";
import { telemetrySingleton, type TelemetryRuntime } from "../platform/telemetry-tracing.js";
import {
  feishuImFreshnessAdapter, feishuImTarget, mergeFeishuImCursor, serializeFeishuImTarget,
  type FeishuImCursor, type FeishuImMessage,
} from "../feishu/im-freshness-adapter.js";

type Env = Record<string, string | undefined>;
type JsonObject = Record<string, unknown>;

export interface AgentCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface AgentCliDependencies {
  io?: AgentCliIo;
  modelDirectory?(input: { agentId: string; cwd: string; runtime: string }): Array<{
    id: string; label?: string; supportedReasoningEfforts?: string[]; defaultReasoningEffort?: string;
  }>;
  spawn?: typeof spawnSync;
  stateStore?: AgentStateStore;
  telemetry?: TelemetryRuntime;
  now?(): number;
  timeZone?(): string;
  requestAgentUpsert?(input: { larkinHome: string; agentId: string }): Promise<{ ok: boolean; error?: string }>;
}

type RuntimeDirectoryModel = { id: string; label?: string; supportedReasoningEfforts?: string[]; defaultReasoningEffort?: string };

function discoverRuntimeModelDirectorySync(
  input: { agentId: string; cwd: string; runtime: string },
  env: Env,
): RuntimeDirectoryModel[] {
  const childSpec = internalCommandSpec("runtime-model-directory", [input.runtime, input.cwd], env);
  const result = spawnSync(childSpec.command, childSpec.args, {
    encoding: "utf8", env: { ...process.env, ...env }, timeout: 20_000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`${input.runtime} 模型目录加载失败`);
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { throw new Error(`${input.runtime} 模型目录响应无效`); }
  const rows = (value as { models?: unknown } | null)?.models;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 512) throw new Error(`${input.runtime} 模型目录响应无效`);
  const models = rows.flatMap((row): RuntimeDirectoryModel[] => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const item = row as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id || (item.label !== undefined && typeof item.label !== "string")) return [];
    const supportedReasoningEfforts = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.filter((effort): effort is string => typeof effort === "string") : undefined;
    return [{ id: item.id, ...(typeof item.label === "string" ? { label: item.label } : {}),
      ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
      ...(typeof item.defaultReasoningEffort === "string" ? { defaultReasoningEffort: item.defaultReasoningEffort } : {}) }];
  });
  if (models.length !== rows.length || !models.some((model) => model.id === "default" && /^default: \S/.test(model.label || ""))) {
    throw new Error(`${input.runtime} 模型目录响应无效`);
  }
  return models;
}

interface ParsedOptions {
  positionals: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

function defaultIo(): AgentCliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function parseOptions(argv: readonly string[], booleanFlags: ReadonlySet<string> = new Set()): ParsedOptions {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const key = equals >= 0 ? argument.slice(0, equals) : argument;
    if (booleanFlags.has(key)) {
      if (equals >= 0) throw new Error(`${key} 不接受值`);
      if (booleans.has(key)) throw new Error(`${key} 只能指定一次`);
      booleans.add(key);
      continue;
    }
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} 需要值`);
    if (values.has(key)) throw new Error(`${key} 只能指定一次`);
    values.set(key, value);
  }
  return { positionals, values, booleans };
}

function numberOption(options: ParsedOptions, key: string): number | undefined {
  const raw = options.values.get(key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} 必须是有限数字`);
  return value;
}

function emitJson(io: AgentCliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function query(requestPath: string, name: string): string | null {
  return new URL(requestPath, "http://local").searchParams.get(name);
}

function migrationError(group: string, subcommand?: string): string | null {
  if (group === "message") {
    return "message 已移除：只读查看收件箱用 `larkin inbox check`，领取完整消息用 `larkin inbox poll`；飞书（Lark）发送、回复和查询请使用 `larkin im +messages-send`、`+messages-reply`、`+chat-messages-list` 或 `+messages-mget`。";
  }
  if (group === "channel") {
    return "channel 已移除：群聊操作请使用 `larkin im +chat-list`、`+chat-search`、`chats get`、`+chat-create`、`+chat-update` 或 `chat.members get/create/delete`。";
  }
  if (group === "attachment") {
    return "attachment 已移除：发送附件请使用 `larkin im +messages-send --file/--image/--video/--audio`；下载请使用 `larkin im +messages-resources-download`。";
  }
  if (group === "server") return "server 已移除；飞书（Lark）群与消息信息请通过 `larkin im ...` 查询。";
  if (group === "im") return "请通过 `larkin im ...` 使用飞书（Lark）命令；Runtime 会自动绑定当前 Bot identity，并在写入前执行 freshness gate。可运行 `larkin im --help` 查看帮助。";
  if (group === "profile" && subcommand !== "show") {
    return "profile 只保留只读的 `larkin profile show`；身份和凭证由 `larkin setup` 管理，不支持 update。";
  }
  return null;
}

function help(): JsonObject {
  return {
    usage: "larkin <inbox|comment|reminder|interaction|profile|config> ...",
    capabilities: AGENT_CLI_CAPABILITIES,
  };
}

function configHelp(): JsonObject {
  return {
    usage: CONFIG_CLI_USAGE,
    values: CONFIG_CLI_VALUES,
    boundary: "Safe user configuration only; credentials, Feishu identity, internal paths, serverId, activeAgent, and raw config remain unavailable.",
  };
}

function agentConfigRequest(
  argv: readonly string[],
  env: Env,
  config: larkinConfig.HydratedConfig,
  agent: larkinConfig.HydratedAgent,
  dependencies: AgentCliDependencies,
): unknown | Promise<unknown> {
  const [operation = "show", ...rest] = argv;
  const authority = { kind: "agent" as const, agentId: agent.agentId };
  const options = parseOptions(rest, new Set(["--json"]));
  const unknownFlags = [...options.values.keys()].filter((flag) => !["--agent", "--chat", "--model"].includes(flag));
  if (unknownFlags.length) throw new Error(`config 不支持参数：${unknownFlags.join(", ")}；运行 larkin config --help`);
  const assertOnlyFlags = (valueFlags: readonly string[], booleanFlags: readonly string[] = []): void => {
    const allowedValues = new Set(valueFlags);
    const allowedBooleans = new Set(booleanFlags);
    const unsupported = [
      ...[...options.values.keys()].filter((flag) => !allowedValues.has(flag)),
      ...[...options.booleans].filter((flag) => !allowedBooleans.has(flag)),
    ];
    if (unsupported.length) throw new Error(`当前 config 操作不支持参数：${unsupported.join(", ")}；运行 larkin config --help`);
  };
  const targetId = options.values.get("--agent") || agent.agentId;
  const target = config.agents[targetId];
  if (!target) throw new Error(`Agent 不存在：${targetId}；运行 larkin config show --json 查看可用 Agent`);
  const currentDirectory = (runtime = target.runtime): RuntimeDirectoryModel[] => (dependencies.modelDirectory ?? ((input) => discoverRuntimeModelDirectorySync(input, env)))({
    agentId: target.agentId, cwd: target.workspaceDir, runtime,
  });
  if (operation === "show") {
    assertOnlyFlags(["--agent", "--chat"], ["--json"]);
    if (options.positionals.length) throw new Error("config show 只接受 --agent、--chat 与 --json；运行 larkin config --help");
    const chatId = options.values.get("--chat");
    return larkinConfig.safeConfigView(config, targetId, chatId, larkinConfig.configApplyState(env, config));
  }
  let mutation: larkinConfig.ConfigMutation;
  if (operation === "runtime") {
    assertOnlyFlags(["--agent", "--model"]);
    const runtime = options.positionals[0];
    if (!runtime || options.positionals.length > 1) throw new Error("用法: larkin config runtime <runtime> [--model <model>] [--agent <App ID>]");
    const model = options.values.get("--model");
    if (model && !currentDirectory(runtime).some((item) => item.id === model)) throw new Error(`model 不在 ${runtime} 当前目录中：${model}`);
    mutation = { kind: "set-agent-runtime", agentId: targetId, runtime, ...(model ? { model } : {}) };
  } else if (operation === "model") {
    assertOnlyFlags(["--agent"]);
    const model = options.positionals[0];
    if (!model || options.positionals.length > 1) throw new Error("用法: larkin config model <model|default> [--agent <App ID>]");
    const directory = currentDirectory();
    if (!directory.some((item) => item.id === model)) throw new Error(`model 不在 ${target.runtime} 当前目录中：${model}`);
    mutation = { kind: "set-agent-model", agentId: targetId, model };
  } else if (operation === "effort") {
    assertOnlyFlags(["--agent"]);
    const effort = options.positionals[0];
    if (!effort || options.positionals.length > 1) throw new Error("用法: larkin config effort <level|default|clear> [--agent <App ID>]");
    if (effort === "default" || effort === "clear") mutation = { kind: "set-agent-effort", agentId: targetId, effort: null };
    else {
      if (target.model === "default") throw new Error("model=default 时不能设置 effort");
      const selected = currentDirectory().find((item) => item.id === target.model);
      if (!selected) throw new Error(`当前 model 不在 ${target.runtime} 当前目录中：${target.model}`);
      if (!selected.supportedReasoningEfforts?.includes(effort)) throw new Error(`effort=${effort} 未被当前模型 ${target.runtime}/${target.model} 声明支持`);
      mutation = { kind: "set-agent-effort", agentId: targetId, effort };
    }
  } else if (operation === "mention") {
    const [scope, first, second] = options.positionals;
    if (scope === "global") assertOnlyFlags([]);
    else if (scope === "agent" || scope === "chat") assertOnlyFlags(["--agent"]);
    else assertOnlyFlags([]);
    if (scope === "global" && options.positionals.length === 2 && ["require", "free"].includes(first || "") && second === undefined) {
      mutation = { kind: "set-global-mention", value: first as larkinConfig.MentionPolicy };
    } else if (scope === "agent" && options.positionals.length === 2 && ["inherit", "require", "free"].includes(first || "") && second === undefined) {
      mutation = { kind: "set-agent-mention", agentId: targetId, value: first as larkinConfig.MentionPolicyOverride };
    } else if (scope === "chat" && options.positionals.length === 3 && first?.startsWith("oc_") && ["inherit", "require", "free"].includes(second || "")) {
      mutation = { kind: "set-chat-mention", agentId: targetId, chatId: first, value: second as larkinConfig.MentionPolicyOverride };
    } else throw new Error("用法: larkin config mention global <require|free> | mention agent <inherit|require|free> | mention chat <oc_id> <inherit|require|free> [--agent <App ID>]");
  } else if (operation === "apply") {
    assertOnlyFlags(["--agent"]);
    if (options.positionals.length) throw new Error("用法: larkin config apply [--agent <App ID>]");
    const expectedSignature = larkinConfig.runtimeConfigSignature(config, targetId);
    return (dependencies.requestAgentUpsert ?? requestAgentUpsert)({ larkinHome: config.larkinHome, agentId: targetId }).then((result) => {
      if (!result.ok) throw new Error(result.error || "daemon 拒绝应用配置");
      larkinConfig.markConfigApplied(env, targetId, expectedSignature);
      return { ok: true, agentId: targetId, applyState: "applied", result };
    }).catch((error) => { throw new Error(`配置已保存但未应用：${error instanceof Error ? error.message : String(error)}`); });
  } else throw new Error("config 只支持 show/runtime/model/effort/mention/apply；运行 larkin config --help");
  const result = larkinConfig.mutateConfig(env, mutation, authority);
  return { ok: true, revision: result.revision, persisted: true, applyState: result.applyState, changedScope: result.changedScope };
}

function requireAgent(env: Env) {
  const agentId = larkinConfig.resolveRuntimeAuthority(env);
  if (!agentId) throw new Error("缺少 Runtime 注入的 Agent authority marker；Agent CLI 不会回退到 activeAgent");
  let config: larkinConfig.HydratedConfig;
  try {
    ({ config } = larkinConfig.loadConfig(env));
  } catch {
    throw new Error("无法加载 Larkin 配置；请检查配置格式和文件权限，或运行 larkin setup");
  }
  return { config, agent: larkinConfig.selectAgent(config, { ...env, LARKIN_AGENT_ID: agentId }) };
}

function reminderRequest(
  groupArgv: readonly string[],
  stateStore: AgentStateStore,
  agentId: string,
  deps: AgentCliDependencies,
): { ok: boolean; status: number; data?: unknown; error?: string } {
  // ReminderStore's lock lives beside reminders.json. Materialize the canonical
  // state directory through AgentStateStore so first use keeps its path and mode
  // guarantees instead of creating an ad-hoc directory.
  if (!fs.existsSync(stateStore.paths.reminders)) stateStore.writeJson("reminders", { reminders: [] });
  const [operation, ...rest] = groupArgv;
  const options = parseOptions(rest, new Set(["--all", "--json", "--no-delivery", "--internal"]));
  if (options.positionals.length) throw new Error(`reminder ${operation || ""} 不接受位置参数：${options.positionals.join(" ")}`);
  const id = options.values.get("--id");
  let method = "GET";
  let requestPath = "/reminders";
  const body: JsonObject = {};
  switch (operation) {
    case "schedule":
      method = "POST";
      body.title = options.values.get("--title") || "";
      if (options.values.has("--fire-at")) body.fireAt = options.values.get("--fire-at");
      if (options.values.has("--delay-seconds")) body.delaySeconds = numberOption(options, "--delay-seconds");
      if (options.values.has("--repeat")) body.repeat = options.values.get("--repeat");
      if (options.values.has("--tz")) body.tz = options.values.get("--tz");
      if (options.values.has("--message-id")) body.msgId = options.values.get("--message-id");
      if (options.values.has("--channel")) body.channel = options.values.get("--channel");
      if (options.values.has("--delivery-target")) body.deliveryTarget = options.values.get("--delivery-target");
      if (options.values.has("--target")) body.deliveryTarget = options.values.get("--target");
      if (options.booleans.has("--no-delivery") || options.booleans.has("--internal")) body.noDelivery = true;
      break;
    case "list": {
      const search = new URLSearchParams();
      if (options.values.has("--status")) search.set("status", options.values.get("--status")!);
      if (options.booleans.has("--all")) search.set("all", "true");
      requestPath += search.size ? `?${search}` : "";
      break;
    }
    case "snooze":
      if (!id) throw new Error("reminder snooze 需要 --id");
      method = "POST";
      requestPath += `/${encodeURIComponent(id)}/snooze`;
      body.delaySeconds = numberOption(options, "--delay-seconds");
      break;
    case "update":
      if (!id) throw new Error("reminder update 需要 --id");
      method = "PATCH";
      requestPath += `/${encodeURIComponent(id)}`;
      if (options.values.has("--title")) body.title = options.values.get("--title");
      if (options.values.has("--fire-at")) body.fireAt = options.values.get("--fire-at");
      if (options.values.has("--delay-seconds")) body.delaySeconds = numberOption(options, "--delay-seconds");
      if (options.values.has("--repeat")) body.repeat = options.values.get("--repeat");
      if (options.values.has("--tz")) body.tz = options.values.get("--tz");
      break;
    case "cancel":
      if (!id) throw new Error("reminder cancel 需要 --id");
      method = "DELETE";
      requestPath += `/${encodeURIComponent(id)}`;
      break;
    case "log":
      if (!id) throw new Error("reminder log 需要 --id");
      requestPath += `/${encodeURIComponent(id)}/log`;
      break;
    default:
      throw new Error("reminder 只支持 schedule/list/snooze/update/cancel/log");
  }
  const routes = createReminderRoutes({
    stateFile: stateStore.paths.reminders,
    agentId,
    query,
    log: () => undefined,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.timeZone ? { timeZone: deps.timeZone } : {}),
    currentInboxSource: () => stateStore.resolveCurrentInboxSource(),
    resolveMessageTarget: (messageId) => stateStore.resolveInboxMessageTarget(messageId),
  });
  return routes.handle({ path: requestPath, pathNoQuery: requestPath.split("?")[0], method, body });
}

function readBoundedJsonFile(file: string, label: string): unknown {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 必须是非 symlink 普通文件`);
  if (stat.size > 64 * 1024) throw new Error(`${label} 超过 64 KiB`);
  try { return JSON.parse(fs.readFileSync(resolved, "utf8")); }
  catch (error) { throw new Error(`${label} JSON 解析失败：${(error as Error).message}`); }
}

function interactionRequest(
  groupArgv: readonly string[],
  stateStore: AgentStateStore,
  agentId: string,
  larkinHome: string,
  deps: AgentCliDependencies,
): unknown {
  const [operation, ...rest] = groupArgv;
  const options = parseOptions(rest);
  if (options.positionals.length) throw new Error(`interaction ${operation || ""} 不接受位置参数：${options.positionals.join(" ")}`);
  const machine = new InteractionStateMachine({ stateStore, agentId, ...(deps.now ? { now: deps.now } : {}) });
  if (operation === "callback-status") {
    if (options.values.size) throw new Error("interaction callback-status 不接受参数");
    const capability = readCallbackCapability(larkinHome, agentId);
    return { status: capability?.status || "missing", capability };
  }
  if (operation === "callback-probe") {
    if (options.values.size) throw new Error("interaction callback-probe 不接受参数");
    const issued = issueCallbackProbe(larkinHome, agentId, deps.now?.());
    if (issued.capability.status === "verified-effective") return { status: "verified-effective", message_content: null };
    const card = {
      schema: "2.0",
      header: { title: { tag: "plain_text", content: "验证 Larkin 卡片回调" } },
      body: { elements: [
        { tag: "markdown", content: "点击按钮验证 card.action.trigger 已发布并通过长连接实际送达。此卡片不会执行任何业务操作。" },
        {
          tag: "button",
          type: "primary_filled",
          width: "fill",
          text: { tag: "plain_text", content: "验证回调" },
          behaviors: [{ type: "callback", value: { larkin_callback_probe: issued.nonce } }],
        },
      ] },
    };
    return { status: "probe-issued", message_content: JSON.stringify(card), card };
  }
  if (operation === "create") {
    const specFile = options.values.get("--spec-file");
    const chatId = options.values.get("--chat-id");
    if (!specFile || !chatId) throw new Error("interaction create 需要 --spec-file 和 --chat-id");
    const credentialFile = path.join(larkinHome, "bots", `${agentId}.json`);
    let callbackReady = false;
    try {
      const stat = fs.lstatSync(credentialFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid bot credential path");
      callbackReady = readCallbackCapability(larkinHome, agentId)?.status === "verified-effective";
    } catch { /* actionable fail-closed error below */ }
    if (!callbackReady) throw new Error("card.action.trigger 尚未 verified-effective；请确认订阅已发布，运行 interaction callback-probe，将 message_content 作为 interactive 消息发送并真实点击，再用 interaction callback-status 确认后创建业务卡片");
    const created = machine.create({ definition: readBoundedJsonFile(specFile, "--spec-file"), expected_chat_id: chatId });
    return { ...created, message_content: JSON.stringify(created.card) };
  }
  if (operation === "get") {
    const instanceId = options.values.get("--instance-id");
    const runId = options.values.get("--run-id");
    if (Boolean(instanceId) === Boolean(runId)) throw new Error("interaction get 必须且只能指定 --instance-id 或 --run-id");
    return machine.get({ ...(instanceId ? { instance_id: instanceId } : {}), ...(runId ? { run_id: runId } : {}) });
  }
  if (operation === "resolve") {
    const runId = options.values.get("--run-id");
    const status = options.values.get("--status");
    const summary = options.values.get("--summary");
    const expectedVersion = numberOption(options, "--expected-version");
    if (!runId || !summary || expectedVersion === undefined || !["succeeded", "failed"].includes(status || "")) {
      throw new Error("interaction resolve 需要 --run-id、--expected-version、--status succeeded|failed 和 --summary");
    }
    let data: JsonObject = {};
    if (options.values.has("--data-json")) {
      try {
        const parsed = JSON.parse(options.values.get("--data-json")!);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be an object");
        data = parsed as JsonObject;
      } catch (error) { throw new Error(`--data-json 解析失败：${(error as Error).message}`); }
    }
    return machine.resolve({ run_id: runId, expected_version: expectedVersion, status: status as "succeeded" | "failed", summary, data, agent_id: agentId });
  }
  throw new Error("interaction 只支持 callback-status/callback-probe/create/get/resolve");
}

export function runAgentCli(
  argv: readonly string[],
  env: Env = process.env,
  dependencies: AgentCliDependencies = {},
): number | Promise<number> {
  const io = dependencies.io ?? defaultIo();
  const [group = "help", subcommand, ...rest] = argv;
  const migration = migrationError(group, subcommand);
  if (migration) {
    io.stderr(`larkin: ${migration}\n`);
    return 2;
  }
  if (group === "--version" || group === "-V") {
    const version = packageVersion(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
    io.stdout(`larkin ${version}\n`);
    return 0;
  }
  if (["help", "--help", "-h"].includes(group)) {
    emitJson(io, subcommand === "config" ? configHelp() : help());
    return 0;
  }
  if (group === "config" && ["--help", "-h"].includes(subcommand || "")) {
    emitJson(io, configHelp());
    return 0;
  }
  if (group === "config" && AGENT_CLI_CAPABILITIES.commands.config.includes(subcommand as never)
    && rest.some((argument) => argument === "--help" || argument === "-h")) {
    emitJson(io, configHelp());
    return 0;
  }
  try {
    const { config, agent } = requireAgent(env);
    const stateStore = dependencies.stateStore ?? createAgentStateStore(config.larkinHome, agent.agentId);
    if (group === "inbox") {
      if (!["check", "poll"].includes(subcommand || "")) {
        throw new Error("inbox 只支持 `larkin inbox check` 与 `larkin inbox poll`");
      }
      const options = parseOptions(rest, new Set(["--json"]));
      if (options.positionals.length || [...options.values.keys()].some((flag) => !["--target", "--limit"].includes(flag))) {
        throw new Error(`inbox ${subcommand} 只接受 --target、${subcommand === "poll" ? "--limit、" : ""}--json`);
      }
      const target = options.values.get("--target");
      if (subcommand === "check") {
        if (options.values.has("--limit")) throw new Error("inbox check 不接受 --limit");
        emitJson(io, projectInboxCheck(stateStore.readNdjson<InboxEnvelope>("inbox"), target));
        return 0;
      }
      const poll = (): number => {
        const rawLimit = options.values.get("--limit");
        const limit = rawLimit === undefined ? undefined : Number(rawLimit);
        const polled = stateStore.pollInbox<InboxEnvelope>({ ...(target ? { target } : {}), ...(limit !== undefined ? { limit } : {}) });
        const providerMessages = new Map<string, FeishuImMessage[]>();
        for (const envelope of polled.envelopes) {
          if (typeof envelope.message_id !== "string" || typeof envelope.create_time !== "string") continue;
          const localTarget = typeof envelope.target === "string" ? envelope.target
            : (typeof envelope.chat_id === "string" && envelope.chat_id
              ? (typeof envelope.thread_id === "string" && envelope.thread_id
                ? `thread:${envelope.chat_id}:${envelope.thread_id}` : `chat:${envelope.chat_id}`)
              : null);
          if (!localTarget) continue;
          const key = serializeFeishuImTarget(feishuImTarget(localTarget));
          const rows = providerMessages.get(key) ?? [];
          rows.push(envelope as FeishuImMessage);
          providerMessages.set(key, rows);
        }
        for (const [key, messages] of providerMessages) {
          const cursor = feishuImFreshnessAdapter.cursor({ messages });
          if (cursor) stateStore.mergeFreshnessCursor<FeishuImCursor>(key, cursor, mergeFeishuImCursor,
            env.LARKIN_RUNTIME_OBSERVATION_GENERATION || "external");
        }
        const projected = projectInboxEvents(polled.envelopes);
        const hasMore = polled.pendingCount > 0;
        emitJson(io, { version: 2, delivery: "direct_ack", at_most_once: true, ...projected,
          pending_count: polled.pendingCount, has_more: hasMore,
          ...(hasMore ? { next_action: "Continue polling the same Inbox scope until has_more is false." } : {}),
          seen_through_seq: polled.seenThroughSeq, consumed_delivery_ids: polled.consumedDeliveryIds });
        return 0;
      };
      let telemetry = dependencies.telemetry;
      try { telemetry ??= telemetrySingleton(loadTelemetryConfig(env), {
        serviceVersion: packageVersion(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")),
      }); } catch { /* telemetry must not alter Inbox behavior */ }
      if (!telemetry) return poll();
      const observed = telemetry.externalPhase(agent.agentId, stateStore.paths.root, "inbox.consume", SpanKind.CONSUMER, poll, "agent_cli");
      return observed && typeof (observed as Promise<number>).then === "function"
        ? Promise.resolve(observed).catch((error) => { io.stderr(`larkin: ${(error as Error).message}\n`); return 2; })
        : observed;
    }
    if (group === "reminder") {
      const result = reminderRequest([subcommand || "", ...rest], stateStore, agent.agentId, dependencies);
      if (!result.ok) {
        io.stderr(`larkin: ${result.error || `reminder 请求失败 (${result.status})`}\n`);
        return result.status >= 500 ? 1 : 2;
      }
      emitJson(io, result.data);
      return 0;
    }
    if (group === "interaction") {
      emitJson(io, interactionRequest([subcommand || "", ...rest], stateStore, agent.agentId, config.larkinHome, dependencies));
      return 0;
    }
    if (group === "profile") {
      if (subcommand !== "show" || rest.some((argument) => argument !== "--json")) {
        throw new Error("profile 只支持 `larkin profile show`");
      }
      const identity = stateStore.readJson<Record<string, unknown> | null>("botIdentity", null);
      const name = String(identity?.name || agent.name);
      emitJson(io, {
        kind: "agent", id: agent.agentId, isSelf: true, name, displayName: name,
        openId: identity?.open_id ?? identity?.openId ?? null,
        avatarUrl: identity?.avatar_url ?? identity?.avatarUrl ?? null,
        runtime: agent.runtime, model: agent.model, reasoningEffort: agent.effort ?? null,
        createdAt: agent.createdAt ?? "1970-01-01T00:00:00.000Z",
      });
      return 0;
    }
    if (group === "config") {
      const result = agentConfigRequest([subcommand || "show", ...rest], env, config, agent, dependencies);
      if (result instanceof Promise) return result.then((value) => { emitJson(io, value); return 0; }).catch((error) => {
        const message = (error as Error).message;
        io.stderr(`larkin: ${message}${message.includes("larkin config --help") ? "" : "；运行 larkin config --help"}\n`);
        return 2;
      });
      emitJson(io, result);
      return 0;
    }
    throw new Error(`不支持的 Agent 命令：${group}。可用能力见 larkin help`);
  } catch (error) {
    const message = (error as Error).message;
    io.stderr(`larkin: ${message}${group === "config" && !message.includes("larkin config --help") ? "；运行 larkin config --help" : ""}\n`);
    return 2;
  }
}

export async function main(argv = process.argv.slice(2), env: Env = process.env): Promise<never> {
  process.exit(await runAgentCli(argv, env));
}

function isMainEntry(argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(argvPath) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(argvPath) === path.resolve(modulePath);
  }
}

if (isMainEntry()) await main();
