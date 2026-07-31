import "../platform/check-bun-version.cjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { daemonHasAgent, readProcessState } from "../platform/process-state.js";
import { discoverClaudeModelCatalog } from "../runtime/claude-model-catalog.js";
import { discoverCodexModelCatalog } from "../runtime/codex-model-catalog.js";
import { discoverPiModelCatalog, type PiModelCatalog } from "../runtime/pi-model-catalog.js";
import { callbackCapability } from "../platform/callback-capability.js";
import { isChannelReconnecting, projectAgentReadiness, type AgentReadinessStatus } from "./agent-readiness.js";
import { requestAgentUpsert } from "./local-control.js";
import * as larkinConfig from "../platform/config.js";
import { managedOfficialLarkCli } from "./agent-lark-cli-workspace.js";

interface RuntimeModel {
  id: string;
  label?: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

interface AgentConfig {
  agentId: string;
  name: string;
  runtime: string;
  model: string;
  effort?: string;
  stateDir: string;
  feishuProfile: string;
  larkConfigDir?: string;
  noMentionChats?: string[];
  mentionPolicy?: "require" | "free";
  chatMentionPolicies?: Record<string, "require" | "free">;
  [key: string]: unknown;
}

interface HydratedConfig {
  activeAgent: string;
  larkinHome: string;
  agents: Record<string, AgentConfig>;
  [key: string]: unknown;
}

type ConfigMutation =
  | { kind: "set-global-mention"; value: "require" | "free" }
  | { kind: "set-agent-mention"; agentId: string; value: "inherit" | "require" | "free" }
  | { kind: "set-chat-mention"; agentId: string; chatId: string; value: "inherit" | "require" | "free" }
  | { kind: "set-agent-runtime"; agentId: string; runtime: string; model?: string }
  | { kind: "set-agent-model"; agentId: string; model: string }
  | { kind: "set-agent-effort"; agentId: string; effort: string | null };

interface ConfigModule {
  loadConfig(env: NodeJS.ProcessEnv): { configDir: string; file: string; config: HydratedConfig };
  loadRuntimeModels(): Record<string, RuntimeModel[]>;
  toStored(config: HydratedConfig, configDir: string): unknown;
  defaultModelFor(runtime: string): string;
  mutateConfig(env: NodeJS.ProcessEnv, mutation: ConfigMutation, authority: { kind: "user" } | { kind: "agent"; agentId: string }): {
    revision: string; changedScope: string; persisted: true; applyState: "applied" | "saved_not_applied";
  };
  configApplyState(env: NodeJS.ProcessEnv, config: HydratedConfig): Record<string, unknown>;
  runtimeConfigSignature(config: HydratedConfig, agentId: string): string;
  markConfigApplied(env: NodeJS.ProcessEnv, agentId: string, expectedSignature: string): void;
  resolveRuntimeAuthority(env: NodeJS.ProcessEnv): string | null;
  resolveMentionPolicy(config: HydratedConfig, agentId: string, chatId: string): { effective: "require" | "free"; source: "chat" | "agent" | "global" };
  safeConfigView(config: HydratedConfig, onlyAgentId?: string, chatId?: string, applyState?: Record<string, unknown>): Record<string, unknown>;
}

interface StatusRecord extends AgentReadinessStatus {
  inboundVerifiedAt?: string;
  droughtReconnectAt?: string | null;
  droughtReconnectAbandonedAt?: string | null;
  recentErrors?: Array<{ message?: string; error?: string; [key: string]: unknown }>;
  session?: { runtime?: string; model?: string; reasoningEffort?: string; [key: string]: unknown };
  runtimeReadiness?: { state?: "missing" | "unauthenticated" | "incompatible" | "ready"; executable?: string; version?: string; reason?: string; nextAction?: string };
}


const kind = process.argv[2];
const rest = process.argv.slice(3);

const say = (...args: unknown[]): void => console.log(...args);
const die = (message: string): never => {
  console.error(`✗ ${message}`);
  if (kind === "config" && !message.includes("larkin config --help")) console.error("  下一步: larkin config --help");
  process.exit(1);
};

if (!kind || !["agents", "model", "runtime", "effort", "chats", "config"].includes(kind)) {
  die("用法: larkin agents | larkin config <show|mention|apply> | larkin model [<id>] | larkin runtime [<id>] [--model <id>] | larkin effort [<level>|clear] | larkin chats [free|strict <oc_id>]");
}

const allowedValueFlags: Record<string, ReadonlySet<string>> = {
  agents: new Set(), model: new Set(["--agent"]), runtime: new Set(["--agent", "--model"]),
  effort: new Set(["--agent"]), chats: new Set(["--agent"]), config: new Set(["--agent", "--chat"]),
};
const allowedBooleanFlags: Record<string, ReadonlySet<string>> = {
  agents: new Set(["--json"]), model: new Set(), runtime: new Set(), effort: new Set(), chats: new Set(), config: new Set(["--json"]),
};
const parsedValues = new Map<string, string>();
const parsedBooleans = new Set<string>();
const positionals: string[] = [];
for (let index = 0; index < rest.length; index += 1) {
  const argument = rest[index];
  if (!argument.startsWith("-")) { positionals.push(argument); continue; }
  const equals = argument.indexOf("=");
  const flag = equals >= 0 ? argument.slice(0, equals) : argument;
  if (allowedBooleanFlags[kind].has(flag)) {
    if (equals >= 0) die(`${flag} 不接受值`);
    if (parsedBooleans.has(flag)) die(`${flag} 只能指定一次`);
    parsedBooleans.add(flag);
    continue;
  }
  if (!allowedValueFlags[kind].has(flag)) die(`不支持参数 ${flag}`);
  const flagValue = equals >= 0 ? argument.slice(equals + 1) : rest[++index];
  if (!flagValue || flagValue.startsWith("-")) die(`${flag} 需要值`);
  if (parsedValues.has(flag)) die(`${flag} 只能指定一次`);
  parsedValues.set(flag, flagValue);
}
const flagAgent = parsedValues.get("--agent");
const flagModel = parsedValues.get("--model");
const flagChat = parsedValues.get("--chat");
const flagJson = parsedBooleans.has("--json");
const value = positionals[0];

function assertOnlyFlags(valueFlags: readonly string[], booleanFlags: readonly string[] = []): void {
  const allowedValues = new Set(valueFlags);
  const allowedBooleans = new Set(booleanFlags);
  const unsupported = [
    ...[...parsedValues.keys()].filter((flag) => !allowedValues.has(flag)),
    ...[...parsedBooleans].filter((flag) => !allowedBooleans.has(flag)),
  ];
  if (unsupported.length) die(`当前操作不支持参数 ${unsupported.join(", ")}`);
}

if (kind === "agents") {
  assertOnlyFlags([], ["--json"]);
  if (positionals.length) die("用法: larkin agents [--json]");
} else if (kind === "model") {
  assertOnlyFlags(["--agent"]);
  if (positionals.length > 1) die("用法: larkin model [<model>] [--agent <App ID>]");
} else if (kind === "runtime") {
  assertOnlyFlags(["--agent", "--model"]);
  if (positionals.length > 1 || (!positionals.length && flagModel)) die("用法: larkin runtime [<runtime>] [--model <model>] [--agent <App ID>]");
} else if (kind === "effort") {
  assertOnlyFlags(["--agent"]);
  if (positionals.length > 1) die("用法: larkin effort [<level>|clear|default] [--agent <App ID>]");
} else if (kind === "chats") {
  assertOnlyFlags(["--agent"]);
  if (![0, 2].includes(positionals.length)) die("用法: larkin chats [free|strict <oc_id>] [--agent <App ID>]");
} else if (kind === "config") {
  const [operation = "show", scope] = positionals;
  if (operation === "show") {
    assertOnlyFlags(["--agent", "--chat"], ["--json"]);
    if (positionals.length > 1) die("用法: larkin config show [--agent <App ID>] [--chat <oc_id>] [--json]");
  } else if (operation === "mention" && scope === "global") {
    assertOnlyFlags([]);
    if (positionals.length !== 3) die("用法: larkin config mention global <require|free>");
  } else if (operation === "mention" && scope === "agent") {
    assertOnlyFlags(["--agent"]);
    if (positionals.length !== 3) die("用法: larkin config mention agent <inherit|require|free> [--agent <App ID>]");
  } else if (operation === "mention" && scope === "chat") {
    assertOnlyFlags(["--agent"]);
    if (positionals.length !== 4) die("用法: larkin config mention chat <oc_id> <inherit|require|free> [--agent <App ID>]");
  } else if (operation === "apply") {
    assertOnlyFlags(["--agent"]);
    if (positionals.length !== 1) die("用法: larkin config apply [--agent <App ID>]");
  } else {
    die("config 只支持 show/mention/apply；运行 larkin config --help");
  }
}

const loaded = (() => {
  try {
    return larkinConfig.loadConfig(process.env);
  } catch {
    return die("无法加载 Larkin 配置；请检查配置格式和文件权限，或运行 larkin setup");
  }
})();
const { configDir, file, config } = loaded;
if (!fs.existsSync(file)) die("未找到 Larkin 配置，请运行 larkin setup");

if (kind === "agents") {
  const list = Object.values(config.agents || {});
  const daemon = readProcessState(config.larkinHome).daemon;
  const daemonView = {
    owned: daemon.state === "owned",
    pid: daemon.state === "owned" && Number.isSafeInteger(Number(daemon.pid)) ? Number(daemon.pid) : null,
    started_at: daemon.state === "owned" && typeof daemon.startedAt === "string" ? daemon.startedAt : null,
  };
  if (!list.length) {
    if (flagJson) say(JSON.stringify({ version: 1, daemon: daemonView, agents: [] }, null, 2));
    else say("还没有配置任何 agent，先跑 larkin setup");
    process.exit(0);
  }
  if (flagJson) {
    const agents = list.map((agent) => {
      let status: StatusRecord | null = null;
      try { status = JSON.parse(fs.readFileSync(path.join(agent.stateDir, "status.json"), "utf8")) as StatusRecord; } catch { /* absent */ }
      const effectiveModel = status?.session?.runtime === agent.runtime && status.session.model ? status.session.model : agent.model;
      return {
        agent_id: agent.agentId,
        name: agent.name,
        runtime: agent.runtime,
        model: effectiveModel,
        ...projectAgentReadiness({ agentId: agent.agentId, daemon, status }),
      };
    });
    say(JSON.stringify({
      version: 1,
      daemon: daemonView,
      agents,
    }, null, 2));
    process.exit(0);
  }
  say(`共 ${list.length} 个 agent（daemon=${daemon.running ? `运行中 pid=${daemon.pid} agents=${(daemon.agents || []).join(",")}` : "未运行"}）:\n`);
  for (const agent of list) {
    let bot: { name?: string; open_id?: string } | null = null;
    try { bot = JSON.parse(fs.readFileSync(path.join(agent.stateDir, "bot-identity.json"), "utf8")) as { name?: string; open_id?: string }; } catch { /* absent */ }
    let status: StatusRecord | null = null;
    try { status = JSON.parse(fs.readFileSync(path.join(agent.stateDir, "status.json"), "utf8")) as StatusRecord; } catch { /* absent */ }
    const credentialFile = path.join(configDir, "bots", `${agent.feishuProfile}.json`);
    const cred = fs.existsSync(credentialFile);
    let callbackStatus = "missing";
    if (cred) {
      try { callbackStatus = callbackCapability(JSON.parse(fs.readFileSync(credentialFile, "utf8")))?.status || "missing"; }
      catch { callbackStatus = "invalid"; }
    }
    const connected = daemonHasAgent(daemon, agent.agentId)
      && !!status?.connectedAt
      && Date.parse(status.connectedAt) >= Date.parse(String(daemon.startedAt || 0)) - 1000;
    const inboundVerified = connected
      && !!status?.inboundVerifiedAt
      && Date.parse(status.inboundVerifiedAt) >= Date.parse(String(daemon.startedAt || 0));
    say(`  ${agent.name}${agent.name === config.activeAgent ? " [active]" : ""}`);
    const effectiveModel = status?.session?.runtime === agent.runtime && status.session.model ? status.session.model : agent.model;
    const effectiveEffort = status?.session?.runtime === agent.runtime && status.session.reasoningEffort ? status.session.reasoningEffort : agent.effort;
    say(`    runtime=${agent.runtime}  model=${effectiveModel}${effectiveModel !== agent.model ? `  stored=${agent.model}` : ""}${effectiveEffort ? `  effort=${effectiveEffort}` : ""}`);
    if (status?.runtimeReadiness) say(`    runtime readiness=${status.runtimeReadiness.state || "incompatible"}${status.runtimeReadiness.reason ? `：${status.runtimeReadiness.reason}` : ""}${status.runtimeReadiness.nextAction ? `；下一步：${status.runtimeReadiness.nextAction}` : ""}`);
    if (status?.runtimeReadiness?.executable) say(`    runtime executable=${status.runtimeReadiness.executable}${status.runtimeReadiness.version ? `  version=${status.runtimeReadiness.version}` : ""}`);
    say(`    bot=${bot ? `${bot.name}(${bot.open_id})` : "（未连接过，无身份缓存）"}`);
    const reconnecting = connected && isChannelReconnecting(status);
    say(`    连接=${connected ? `已建立（${status?.connectedVia || "channel"}，${status?.connectedAt}）${reconnecting ? "（ws 重连中）" : ""}` : "未建立"}`);
    // 三态：已验证 / 未证实（连上但长时间零事件=疑似僵尸，host 会预防性重连）/ 尚未验证（连接还年轻）。
    const silenceMin = connected && status?.connectedAt ? Math.floor((Date.now() - Date.parse(status.connectedAt)) / 60_000) : 0;
    say(`    入站=${inboundVerified
      ? `本次运行已验证（${status?.inboundVerifiedAt}）`
      : connected && silenceMin >= 2
        ? `未证实：已连接 ${silenceMin} 分钟无任何入站事件（疑似僵尸连接，daemon 会自动预防性重连${status?.droughtReconnectAt ? `；上次重连 ${status.droughtReconnectAt}` : ""}）`
        : "本次运行尚未收到消息验证"}`);
    say(`    凭证=${cred ? `bots/${agent.feishuProfile}.json` : "无（不能建立专属 channel 长连接）"}  state=${agent.stateDir}`);
    say(`    卡片回调=${callbackStatus === "verified-effective" ? "已通过真实 callback probe 验证" : `${callbackStatus}（业务交互卡片 fail-closed；运行 interaction callback-probe）`}`);
    const recent = Array.isArray(status?.recentErrors) ? status.recentErrors.at(-1) : null;
    if (recent) say(`    最近错误=${recent.message || recent.error || JSON.stringify(recent)}`);
  }
  process.exit(0);
}

const keys = Object.keys(config.agents || {});
if (!keys.length) die("还没有配置任何 agent，先跑 larkin setup");
let runtimeAgentId: string | null = null;
try { runtimeAgentId = larkinConfig.resolveRuntimeAuthority(process.env); }
catch (error) { die(error instanceof Error ? error.message : String(error)); }
if (runtimeAgentId && !config.agents[runtimeAgentId]) die(`Runtime Agent 身份不存在：${runtimeAgentId}`);

if (kind === "config") {
  const [operation, scope, first, second] = positionals;
  const selected = flagAgent || runtimeAgentId;
  const authority = runtimeAgentId ? { kind: "agent" as const, agentId: runtimeAgentId } : { kind: "user" as const };
  const requireTarget = (): string => {
    if (selected) {
      if (!config.agents[selected]) die(`agent ${selected} 不存在；可用: ${keys.join(", ")}`);
      return selected;
    }
    if (keys.length === 1) return keys[0];
    return die(`有 ${keys.length} 个 agent，修改必须用 --agent <App ID> 指定；可用: ${keys.join(", ")}`);
  };
  if (!operation || operation === "show") {
    const view = larkinConfig.safeConfigView(config, selected || undefined, flagChat, larkinConfig.configApplyState(process.env, config));
    if (flagJson) say(JSON.stringify(view, null, 2));
    else {
      say(`全局群消息策略=${String(view.mentionPolicy)}（free 会唤醒所有继承它的 Agent）`);
      for (const item of view.agents as Array<Record<string, unknown>>) {
        const mention = item.mention as { override: string; chat?: { chatId: string; override: string; effective: string; source: string } };
        const apply = item.apply as { applyState?: string };
        say(`agent=${item.agentId} runtime=${item.runtime} model=${item.model} effort=${item.effort || "default"} mention=${mention.override} apply=${apply.applyState || "unknown"}`);
        if (mention.chat) say(`  chat=${mention.chat.chatId} override=${mention.chat.override} effective=${mention.chat.effective} source=${mention.chat.source}`);
      }
    }
    process.exit(0);
  }
  if (operation === "mention") {
    let mutation: ConfigMutation | null = null;
    if (scope === "global") {
      if (first !== "require" && first !== "free") die("用法: larkin config mention global <require|free>");
      mutation = { kind: "set-global-mention", value: first as "require" | "free" };
    } else if (scope === "agent") {
      if (!["inherit", "require", "free"].includes(first || "")) die("用法: larkin config mention agent <inherit|require|free> [--agent <App ID>]");
      mutation = { kind: "set-agent-mention", agentId: requireTarget(), value: first as "inherit" | "require" | "free" };
    } else if (scope === "chat") {
      if (!first?.startsWith("oc_") || !["inherit", "require", "free"].includes(second || "")) die("用法: larkin config mention chat <oc_id> <inherit|require|free> [--agent <App ID>]");
      mutation = { kind: "set-chat-mention", agentId: requireTarget(), chatId: first, value: second as "inherit" | "require" | "free" };
    } else die("mention scope 只支持 global/agent/chat");
    if (!mutation) die("mention mutation 无效");
    const result = larkinConfig.mutateConfig(process.env, mutation as ConfigMutation, authority);
    say(JSON.stringify({ ok: true, revision: result.revision, persisted: result.persisted, applyState: result.applyState, changedScope: result.changedScope }, null, 2));
    process.exit(0);
  }
  if (operation === "apply") {
    const agentId = requireTarget();
    const expectedSignature = larkinConfig.runtimeConfigSignature(config, agentId);
    try {
      const result = await requestAgentUpsert({ larkinHome: config.larkinHome, agentId });
      if (!result.ok) {
        const readiness = result.readiness;
        throw new Error([result.error || "daemon 拒绝应用配置",
          readiness?.reason ? `runtime=${readiness.state}: ${readiness.reason}` : null,
          readiness?.nextAction ? `下一步：${readiness.nextAction}` : null].filter(Boolean).join("；"));
      }
      larkinConfig.markConfigApplied(process.env, agentId, expectedSignature);
      say(JSON.stringify({ ok: true, agentId, applyState: "applied", result }, null, 2));
    } catch (error) { die(`配置已保存但未应用：${error instanceof Error ? error.message : String(error)}`); }
    process.exit(0);
  }
  die("config 只支持 show/mention/apply");
}
let key = flagAgent;
if (!key && runtimeAgentId) key = runtimeAgentId;
if (key && !config.agents[key]) die(`agent ${key} 不存在；可用: ${keys.join(", ")}`);
if (!key && keys.length === 1) key = keys[0];
if (!key) {
  if (!value) {
    say(`共 ${keys.length} 个 agent（用 --agent <appId> 查看/修改指定一个）:`);
    for (const candidate of keys) {
      const item = config.agents[candidate];
      say(`  ${candidate}${candidate === config.activeAgent ? " [active]" : ""}  runtime=${item.runtime}  model=${item.model}`);
    }
    process.exit(0);
  }
  die(`有 ${keys.length} 个 agent，修改必须用 --agent <appId> 指定；可用: ${keys.join(", ")}`);
}
const selectedKey = key as string;
const agent = config.agents[selectedKey];
const catalog = larkinConfig.loadRuntimeModels();
if ((["model", "effort"].includes(kind || "") && agent.runtime === "codex") || (kind === "runtime" && value === "codex")) {
  try {
    const discovered = await discoverCodexModelCatalog({ cwd: String(agent.workspaceDir), env: process.env });
    catalog.codex = [{ id: "default", label: `default: ${discovered.effectiveModel}` }, ...discovered.models];
  } catch (error) {
    die(`Codex 模型目录加载失败：${error instanceof Error ? error.message : String(error)}。请确认当前 codex CLI 支持 app-server model/list。`);
  }
}
if ((["model", "effort"].includes(kind || "") && agent.runtime === "claude") || (kind === "runtime" && value === "claude")) {
  try {
    const discovered = await discoverClaudeModelCatalog({ cwd: String(agent.workspaceDir), env: process.env });
    catalog.claude = [{ id: "default", label: `default: ${discovered.effectiveModel}` }, ...discovered.models];
  } catch (error) {
    die(`Claude 模型目录加载失败：${error instanceof Error ? error.message : String(error)}。请确认当前 Claude Code 支持 list_models control request。`);
  }
}
let piCatalog: PiModelCatalog | null = null;
if (agent.runtime === "pi" || (kind === "runtime" && value === "pi")) {
  try {
    piCatalog = await discoverPiModelCatalog({
      cwd: String(agent.workspaceDir),
      ...(process.env.PI_CODING_AGENT_DIR ? { agentDir: process.env.PI_CODING_AGENT_DIR } : {}),
    });
  } catch (error) {
    die(`Pi 模型目录加载失败：${error instanceof Error ? error.message : String(error)}。请先用官方 pi 登录或检查 PI_CODING_AGENT_DIR。`);
  }
  if (!piCatalog) die("Pi 模型目录加载失败");
  const loadedPiCatalog = piCatalog as PiModelCatalog;
  for (const diagnostic of loadedPiCatalog.diagnostics) console.error(`Pi diagnostic: ${diagnostic}`);
  catalog.pi = [{ id: "default", label: `default: ${loadedPiCatalog.effectiveModel}` }, ...loadedPiCatalog.models];
}

function listModels(runtime: string, current: string): void {
  const items = catalog[runtime];
  if (!items) {
    say(`  （无 ${runtime} 的目录数据）`);
    return;
  }
  for (const model of items) {
    const marks = [model.id === current && "← 当前"].filter(Boolean).join("，");
    const levels = model.supportedReasoningEfforts?.length ? `  thinking=${model.supportedReasoningEfforts.join("/")}` : "";
    say(`  ${model.id.padEnd(32)} ${model.label || ""}${levels}${marks ? `  [${marks}]` : ""}`);
  }
}

function writeAndHint(mutation: ConfigMutation): void {
  const authority = runtimeAgentId ? { kind: "agent" as const, agentId: runtimeAgentId } : { kind: "user" as const };
  const result = larkinConfig.mutateConfig(process.env, mutation, authority);
  say("\n✓ 已持久化配置");
  say(`  revision=${result.revision}  applyState=${result.applyState}`);
  if (result.applyState === "saved_not_applied") say("  运行 larkin config apply --agent <App ID> 后应用到新 Runtime session");
}

function effortChoicesFor(runtime: string, model: string): { list: string[]; note: string; def: string | null } | null {
  const entry = catalog[runtime]?.find((candidate) => candidate.id === model);
  if (!entry?.supportedReasoningEfforts?.length) return null;
  return { list: entry.supportedReasoningEfforts, note: "模型声明", def: entry.defaultReasoningEffort || null };
}

function dropEffortIfInvalid(next: AgentConfig): AgentConfig {
  if (!next.effort) return next;
  const choices = effortChoicesFor(next.runtime, next.model);
  if (choices?.list.includes(next.effort)) return next;
  say(choices
    ? `effort=${next.effort} 不适用于 ${next.runtime}/${next.model}，已清除（恢复 runtime 默认；可用 larkin effort 重设）`
    : `模型 ${next.runtime}/${next.model} 未显式声明 supportedReasoningEfforts，原 effort=${next.effort} 已清除`);
  const { effort: _effort, ...withoutEffort } = next;
  return withoutEffort as AgentConfig;
}

if (kind === "model") {
  const runtime = agent.runtime;
  if (!value) {
    say(`agent=${selectedKey}  runtime=${runtime}  model=${agent.model}`);
    say(`\n${runtime} 可选模型:`);
    listModels(runtime, agent.model);
    say("\n切换: larkin model <id>");
    process.exit(0);
  }
  const items = catalog[runtime];
  if (items && !items.some((model) => model.id === value)) {
    console.error(`✗ "${value}" 不是 ${runtime} 的合法模型。合法值:`);
    for (const model of items) console.error(`    ${model.id}`);
    console.error("  （Larkin 要求使用目录中的精确模型 ID，避免静默选择其它模型）");
    process.exit(1);
  }
  if (value === agent.model) {
    say(`model 已经是 ${value}，无需修改`);
    process.exit(0);
  }
  writeAndHint({ kind: "set-agent-model", agentId: selectedKey, model: value });
} else if (kind === "effort") {
  if (value === "clear" || value === "default") {
    if (!agent.effort) {
      say("effort 本来就未设置（runtime 默认），无需修改");
      process.exit(0);
    }
    say(`effort 已清除: ${agent.effort} → runtime 默认`);
    writeAndHint({ kind: "set-agent-effort", agentId: selectedKey, effort: null });
    process.exit(0);
  }
  const choices = effortChoicesFor(agent.runtime, agent.model);
  if (!choices) {
    say(`agent=${selectedKey}  runtime=${agent.runtime}  model=${agent.model}`);
    say(`模型 ${agent.runtime}/${agent.model} 未显式声明 supportedReasoningEfforts，不能设置 effort。`);
    process.exit(value ? 1 : 0);
  }
  const { list, note, def } = choices;
  if (!value) {
    say(`agent=${selectedKey}  runtime=${agent.runtime}  model=${agent.model}`);
    say(`effort=${agent.effort || `（未设置，runtime 默认${def ? `，该模型默认 ${def}` : ""}）`}`);
    say(`\n${agent.model} 可选档位（${note}）:`);
    for (const level of list) say(`  ${level.padEnd(10)}${level === agent.effort ? "  [← 当前]" : ""}${level === def ? "  [模型默认]" : ""}`);
    say("\n设置: larkin effort <level>；恢复默认: larkin effort clear");
    process.exit(0);
  }
  if (!list.includes(value)) {
    console.error(`✗ "${value}" 不是 ${agent.runtime}/${agent.model} 的合法档位。合法值: ${list.join(", ")}`);
    process.exit(1);
  }
  if (value === agent.effort) {
    say(`effort 已经是 ${value}，无需修改`);
    process.exit(0);
  }
  writeAndHint({ kind: "set-agent-effort", agentId: selectedKey, effort: value });
} else if (kind === "chats") {
  const [action, chatArg] = positionals;
  const overrides = { ...(agent.chatMentionPolicies || {}) };
  if (!action) {
    const known = new Set(Object.keys(overrides));
    try {
      const map = JSON.parse(fs.readFileSync(path.join(agent.stateDir, "feishu-map.json"), "utf8")) as Record<string, unknown>;
      for (const candidate of Object.values(map)) if (typeof candidate === "string" && candidate.startsWith("oc_")) known.add(candidate);
    } catch { /* no mapping yet */ }
    const names: Record<string, string> = {};
    try {
      if (!agent.larkConfigDir) throw new Error("缺少 lark-cli 隔离目录");
      fs.mkdirSync(agent.larkConfigDir, { recursive: true, mode: 0o700 });
      const managed = managedOfficialLarkCli(agent, process.env);
      const result = spawnSync(managed.command.command, [...managed.command.argsPrefix, "im", "+chat-list", "--json"], {
        encoding: "utf8", timeout: 15000, env: managed.env,
      });
      const parsed = JSON.parse(result.stdout) as { data?: { chats?: Array<{ chat_id: string; name?: string }> } };
      for (const chat of parsed.data?.chats || []) names[chat.chat_id] = chat.name || "";
    } catch { /* group names are optional */ }
    say(`agent=${selectedKey} 已知群与触发方式（p2p 私聊始终触发，不在此列）:`);
    if (!known.size) say("  （还没有已知群——bot 收到过消息的群才会出现在这里）");
    for (const id of known) {
      const resolved = larkinConfig.resolveMentionPolicy(config, selectedKey, id);
      say(`  ${id}  ${(names[id] || "（无名：私聊或已退出的群）").padEnd(16)} override=${overrides[id] || "inherit"} effective=${resolved.effective} source=${resolved.source}`);
    }
    say("\n免@: larkin chats free <oc_id>；恢复需@: larkin chats strict <oc_id>");
    process.exit(0);
  }
  if (!chatArg || !chatArg.startsWith("oc_")) die("用法: larkin chats [free|strict] <oc_群id>（群 id 可先用 larkin chats 查看）");
  if (action === "free") {
    if (overrides[chatArg] === "free") {
      say(`该群已是免@: ${chatArg}`);
      process.exit(0);
    }
    say(`✓ 免@已开: ${chatArg}（该群内不@也会触发）`);
  } else if (action === "strict") {
    if (overrides[chatArg] === "require") {
      say(`该群本来就需@: ${chatArg}`);
      process.exit(0);
    }
    say(`✓ 已恢复需@: ${chatArg}`);
  } else {
    die(`未知动作 "${action}"；用 free（免@）或 strict（需@）`);
  }
  writeAndHint({ kind: "set-chat-mention", agentId: selectedKey, chatId: chatArg, value: action === "free" ? "free" : "require" });
} else {
  if (!value) {
    say(`agent=${selectedKey}  runtime=${agent.runtime}  model=${agent.model}`);
    say("\n可选 runtime:");
    for (const runtime of Object.keys(catalog)) {
      say(`  ${runtime.padEnd(12)}${runtime === agent.runtime ? "  [← 当前]" : ""}  默认模型=${larkinConfig.defaultModelFor(runtime)}`);
    }
    say("\n切换: larkin runtime <id> [--model <id>]");
    process.exit(0);
  }
  if (!catalog[value]) {
    console.error(`✗ "${value}" 不是合法 runtime。合法值: ${Object.keys(catalog).join(", ")}`);
    process.exit(1);
  }
  let model = flagModel;
  if (model) {
    const items = catalog[value];
    if (!items.some((candidate) => candidate.id === model)) {
      console.error(`✗ "${model}" 不是 ${value} 的合法模型。合法值:`);
      for (const item of items) console.error(`    ${item.id}`);
      process.exit(1);
    }
  } else {
    model = larkinConfig.defaultModelFor(value);
    if (value !== agent.runtime) say(`model 随 runtime 重置为默认: ${agent.model} → ${model}（可用 --model 显式指定）`);
  }
  if (value === agent.runtime && model === agent.model) {
    say(`runtime 已经是 ${value}，无需修改`);
    process.exit(0);
  }
  writeAndHint({ kind: "set-agent-runtime", agentId: selectedKey, runtime: value, model });
}
