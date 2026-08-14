import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TargetRootLayout, resolveConfigDir as resolveRootConfigDir } from "./root-layout.js";
import { exactMode, fsyncDirectoryOf } from "./secure-metadata.js";
import { CURRENT_RUNTIME_MODELS, type RuntimeModels } from "../runtime/runtime-model-catalog.js";
import processInspect from "./process-inspect.cjs";

type Env = Record<string, string | undefined>;
type Obj = Record<string, unknown>;
export type { RuntimeModels } from "../runtime/runtime-model-catalog.js";
export type MentionPolicy = "require" | "free";
export type MentionPolicyOverride = MentionPolicy | "inherit";

export interface StoredAgent {
  runtime: string;
  model: string;
  piDistribution?: "external" | "builtin";
  effort?: string;
  mentionPolicy?: MentionPolicy;
  chatMentionPolicies?: Record<string, MentionPolicy>;
  createdAt?: string;
}

export interface HydratedAgent extends StoredAgent {
  name: string;
  agentId: string;
  feishuAppId: string;
  feishuProfile: string;
  workspaceDir: string;
  stateDir: string;
  larkConfigDir: string;
  /** Compatibility projection for older status consumers. Never stored in v4. */
  noMentionChats?: string[];
  [key: string]: unknown;
}

export interface HydratedConfig {
  version: 4;
  serverId: string | null;
  mentionPolicy: MentionPolicy;
  configDir: string;
  larkinHome: string;
  larkConfigDir: string;
  activeAgent: string | null;
  agents: Record<string, HydratedAgent>;
  [key: string]: unknown;
}

export type ConfigMutation =
  | { kind: "set-global-mention"; value: MentionPolicy }
  | { kind: "set-agent-mention"; agentId: string; value: MentionPolicyOverride }
  | { kind: "set-chat-mention"; agentId: string; chatId: string; value: MentionPolicyOverride }
  | { kind: "set-agent-runtime"; agentId: string; runtime: string; model?: string }
  | { kind: "set-agent-model"; agentId: string; model: string }
  | { kind: "set-agent-effort"; agentId: string; effort: string | null };

export type ConfigAuthority = { kind: "user" } | { kind: "agent"; agentId: string };
export interface ConfigMutationResult {
  revision: string;
  previousRevision: string;
  changedScope: "global" | "agent" | "chat";
  agentId?: string;
  persisted: true;
  applyState: "applied" | "saved_not_applied";
  config: HydratedConfig;
}

interface RuntimeApplyRecord { persistedSignature: string; appliedSignature: string | null }
interface ConfigApplyFile { version: 1; persistedRevision: string; agents: Record<string, RuntimeApplyRecord> }

const TOP_FIELDS_V3 = new Set(["version", "serverId", "activeAgent", "agents"]);
const TOP_FIELDS_V4 = new Set(["version", "serverId", "mentionPolicy", "activeAgent", "agents"]);
const AGENT_FIELDS_V3 = new Set(["runtime", "model", "effort", "noMentionChats", "createdAt"]);
const AGENT_FIELDS_V4 = new Set(["runtime", "model", "piDistribution", "effort", "mentionPolicy", "chatMentionPolicies", "createdAt"]);
const APP_ID = /^cli_[A-Za-z0-9]+$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;
const PI_EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CODEX_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const PI_MODEL = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._:@+-]+)?$/;
const CODEX_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CLAUDE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,127}$/;
const CONFIG_LIMIT_BYTES = 1024 * 1024;
const LOCK_RETRIES = 200;
const MALFORMED_LOCK_GRACE_MS = 5_000;
let runtimeModels: RuntimeModels | undefined;

interface ConfigLockRecord { pid: number; processStartToken: string; nonce: string; createdAt: string }

function isPlainObject(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function validateRuntimeModels(catalog: unknown): RuntimeModels {
  if (!isPlainObject(catalog) || Object.keys(catalog).length === 0) throw new Error("runtime 模型目录必须是非空 object");
  for (const [runtime, models] of Object.entries(catalog)) {
    if (!runtime || !Array.isArray(models) || models.length === 0) throw new Error(`runtime 模型目录 ${runtime || "<empty>"} 必须是非空数组`);
    for (const [index, model] of models.entries()) {
      if (!isPlainObject(model) || typeof model.id !== "string" || !model.id) throw new Error(`runtime 模型目录 ${runtime}[${index}].id 必须是非空字符串`);
    }
  }
  return catalog as RuntimeModels;
}

export function loadRuntimeModels(): RuntimeModels {
  if (runtimeModels !== undefined) return runtimeModels;
  runtimeModels = validateRuntimeModels(structuredClone(CURRENT_RUNTIME_MODELS));
  return runtimeModels;
}

export function defaultModelFor(runtime: string): string {
  const models = loadRuntimeModels()[runtime];
  if (!models) throw new Error(`runtime 模型目录不存在 runtime: ${runtime}`);
  return models[0].id;
}

export function resolveConfigDir(env: Env = process.env): string {
  return resolveRootConfigDir(env, os.homedir());
}

export function resolveLarkConfigDir(env: Env = process.env, configDir = resolveConfigDir(env)): string {
  return env.LARKSUITE_CLI_CONFIG_DIR || path.join(configDir, "lark-cli-config");
}

export function resolveRuntimeAuthority(env: Env = process.env): string | null {
  const primary = env.LARKIN_AGENT_ID || null;
  if (primary && !APP_ID.test(primary)) throw new Error("Runtime Agent 身份标记格式无效");
  return primary;
}

function assertAllowedFields(object: Obj, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(object)) if (!allowed.has(key)) throw new Error(`${label} 含不支持字段 ${key}`);
}

function assertPolicy(value: unknown, label: string): asserts value is MentionPolicy {
  if (value !== "require" && value !== "free") throw new Error(`${label} 只允许 require/free`);
}

function assertModel(runtime: string, model: string): void {
  if (model === "default") return;
  const safe = runtime === "pi" ? PI_MODEL.test(model)
    : runtime === "codex" ? CODEX_MODEL.test(model)
      : runtime === "claude" ? CLAUDE_MODEL.test(model) : false;
  if (!safe) throw new Error(`${runtime} model 格式不安全：${model}`);
}

function runtimeSupportsEffort(runtime: string, effort: string): boolean {
  return runtime === "pi" ? PI_EFFORTS.has(effort)
    : runtime === "codex" ? CODEX_EFFORTS.has(effort)
      : runtime === "claude" ? CLAUDE_EFFORTS.has(effort) : false;
}

function validateStoredAgent(key: string, agent: unknown, version: 3 | 4): asserts agent is Obj {
  if (!APP_ID.test(key)) throw new Error(`Agent key 必须是安全的飞书 App ID（cli_ + ASCII 字母数字）：${key}`);
  if (!isPlainObject(agent)) throw new Error(`Agent ${key} 必须是普通 object`);
  assertAllowedFields(agent, version === 3 ? AGENT_FIELDS_V3 : AGENT_FIELDS_V4, `Agent ${key}`);
  if (typeof agent.runtime !== "string" || !agent.runtime) throw new Error(`Agent ${key}.runtime 必须是非空字符串`);
  if (!loadRuntimeModels()[agent.runtime]) throw new Error(`Agent ${key}.runtime 未知：${agent.runtime}`);
  if (typeof agent.model !== "string" || !agent.model) throw new Error(`Agent ${key}.model 必须是非空字符串`);
  assertModel(agent.runtime, agent.model);
  if (Object.hasOwn(agent, "piDistribution")) {
    if (agent.runtime !== "pi" || (agent.piDistribution !== "external" && agent.piDistribution !== "builtin")) {
      throw new Error(`Agent ${key}.piDistribution 只允许 Pi runtime 使用 external/builtin`);
    }
  }
  if (Object.hasOwn(agent, "effort") && (typeof agent.effort !== "string" || !agent.effort)) throw new Error(`Agent ${key}.effort 必须是非空字符串`);
  if (agent.model === "default" && Object.hasOwn(agent, "effort")) throw new Error(`Agent ${key}.model=default 时不能保存 effort`);
  if (typeof agent.effort === "string") {
    if (!runtimeSupportsEffort(agent.runtime, agent.effort)) throw new Error(`Agent ${key}.effort=${agent.effort} 不在 ${agent.runtime} 安全档位中`);
  }
  if (version === 3 && Object.hasOwn(agent, "noMentionChats")) {
    if (!Array.isArray(agent.noMentionChats) || agent.noMentionChats.some((chat) => typeof chat !== "string" || !CHAT_ID.test(chat))) {
      throw new Error(`Agent ${key}.noMentionChats 必须是安全的群 ID 字符串数组`);
    }
  }
  if (version === 4 && Object.hasOwn(agent, "mentionPolicy")) assertPolicy(agent.mentionPolicy, `Agent ${key}.mentionPolicy`);
  if (version === 4 && Object.hasOwn(agent, "chatMentionPolicies")) {
    if (!isPlainObject(agent.chatMentionPolicies)) throw new Error(`Agent ${key}.chatMentionPolicies 必须是普通 object`);
    for (const [chatId, policy] of Object.entries(agent.chatMentionPolicies)) {
      if (!CHAT_ID.test(chatId)) throw new Error(`Agent ${key}.chatMentionPolicies 群 ID 不安全：${chatId}`);
      assertPolicy(policy, `Agent ${key}.chatMentionPolicies.${chatId}`);
    }
  }
  if (Object.hasOwn(agent, "createdAt") && (typeof agent.createdAt !== "string" || !agent.createdAt || !Number.isFinite(Date.parse(agent.createdAt)))) {
    throw new Error(`Agent ${key}.createdAt 格式无效`);
  }
}

function hydratedStoredAgent(key: string, agent: Obj, version: 3 | 4): StoredAgent & { noMentionChats?: string[] } {
  const chatMentionPolicies: Record<string, MentionPolicy> = {};
  if (version === 3) {
    for (const chatId of (agent.noMentionChats as string[] | undefined) || []) chatMentionPolicies[chatId] = "free";
  } else if (isPlainObject(agent.chatMentionPolicies)) {
    for (const [chatId, policy] of Object.entries(agent.chatMentionPolicies)) chatMentionPolicies[chatId] = policy as MentionPolicy;
  }
  return {
    runtime: agent.runtime as string,
    model: agent.model as string,
    ...(agent.piDistribution === "external" || agent.piDistribution === "builtin" ? { piDistribution: agent.piDistribution } : {}),
    ...(typeof agent.effort === "string" ? { effort: agent.effort } : {}),
    ...(version === 4 && (agent.mentionPolicy === "require" || agent.mentionPolicy === "free") ? { mentionPolicy: agent.mentionPolicy } : {}),
    ...(Object.keys(chatMentionPolicies).length ? { chatMentionPolicies, noMentionChats: Object.entries(chatMentionPolicies).filter(([, policy]) => policy === "free").map(([chatId]) => chatId) } : {}),
    ...(typeof agent.createdAt === "string" ? { createdAt: agent.createdAt } : {}),
  };
}

export function hydrateAgent(key: string, agent: StoredAgent & { noMentionChats?: string[] }, configDir: string): HydratedAgent {
  const layout = TargetRootLayout.fromConfigDir(configDir);
  return {
    name: key, agentId: key, feishuAppId: key, feishuProfile: key,
    runtime: agent.runtime, model: agent.model,
    ...(agent.piDistribution ? { piDistribution: agent.piDistribution } : {}),
    workspaceDir: layout.workspaceDir(key), stateDir: layout.agentStateDir(key),
    larkConfigDir: path.join(layout.agentStateDir(key), "lark-cli-config"),
    ...(agent.effort ? { effort: agent.effort } : {}),
    ...(agent.mentionPolicy ? { mentionPolicy: agent.mentionPolicy } : {}),
    ...(agent.chatMentionPolicies ? { chatMentionPolicies: { ...agent.chatMentionPolicies } } : {}),
    ...(agent.noMentionChats ? { noMentionChats: [...agent.noMentionChats] } : {}),
    ...(agent.createdAt ? { createdAt: agent.createdAt } : {}),
  };
}

export function normalizeConfig(raw: unknown, configDir: string, { mint }: { mint?: () => string } = {}): HydratedConfig {
  const layout = TargetRootLayout.fromConfigDir(configDir);
  if (raw === null) return {
    version: 4, serverId: typeof mint === "function" ? mint() : null, mentionPolicy: "require",
    configDir: layout.configDir, larkinHome: layout.larkinHome, larkConfigDir: resolveLarkConfigDir({}, layout.root), activeAgent: null, agents: {},
  };
  if (!isPlainObject(raw)) throw new Error("config 必须是普通 object");
  const version = raw.version;
  if (version !== 3 && version !== 4) throw new Error("不支持该配置格式：larkin 只接受 version=3/4");
  const topFields = version === 3 ? TOP_FIELDS_V3 : TOP_FIELDS_V4;
  assertAllowedFields(raw, topFields, "config");
  for (const field of topFields) if (!Object.hasOwn(raw, field)) throw new Error(`config 缺少必需字段 ${field}`);
  if (typeof raw.serverId !== "string" || !raw.serverId) throw new Error("config.serverId 必须是非空字符串");
  if (version === 4) assertPolicy(raw.mentionPolicy, "config.mentionPolicy");
  if (raw.activeAgent !== null && typeof raw.activeAgent !== "string") throw new Error("config.activeAgent 必须是字符串或 null");
  if (!isPlainObject(raw.agents)) throw new Error("config.agents 必须是普通 object");
  for (const [key, agent] of Object.entries(raw.agents)) validateStoredAgent(key, agent, version);
  if (raw.activeAgent !== null && !Object.hasOwn(raw.agents, raw.activeAgent)) throw new Error(`config.activeAgent 指向不存在的 Agent：${raw.activeAgent}`);
  const agents: Record<string, HydratedAgent> = {};
  for (const [key, agent] of Object.entries(raw.agents)) agents[key] = hydrateAgent(key, hydratedStoredAgent(key, agent as Obj, version), layout.root);
  return {
    version: 4, serverId: raw.serverId, mentionPolicy: version === 4 ? raw.mentionPolicy as MentionPolicy : "require",
    configDir: layout.configDir, larkinHome: layout.larkinHome, larkConfigDir: resolveLarkConfigDir({}, layout.root), activeAgent: raw.activeAgent as string | null, agents,
  };
}

export function assertPrivateConfigMetadata(metadata: { regularFile: boolean; uid: number; mode: number }, label = "配置文件"): void {
  if (!metadata.regularFile) throw new Error(`${label} 必须是普通文件`);
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error(`${label} owner 不是当前用户`);
  if (!exactMode(metadata, 0o600)) throw new Error(`${label} 权限必须是 0600`);
}

function readPrivateFile(file: string, root: string, limit: number, label: string): Buffer | null {
  let fd: number | null = null;
  try {
    const rootReal = fs.realpathSync(root);
    const parentReal = fs.realpathSync(path.dirname(file));
    if (parentReal !== rootReal) throw new Error(`${label} 必须位于 canonical config root 内`);
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    assertPrivateConfigMetadata({ regularFile: stat.isFile(), uid: stat.uid, mode: stat.mode }, label);
    if (stat.size > limit) throw new Error(`${label} 超过 ${limit} bytes`);
    return fs.readFileSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`${label} 不允许 symlink`);
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function readConfigFile(file: string, root = path.dirname(file)): { raw: unknown; bytes: Buffer } {
  try {
    const bytes = readPrivateFile(file, root, CONFIG_LIMIT_BYTES, "配置文件");
    if (bytes === null) return { raw: null, bytes: Buffer.alloc(0) };
    return { raw: JSON.parse(bytes.toString("utf8")), bytes };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`配置文件无法解析 ${file}: ${error.message}`);
    throw error;
  }
}

export function loadConfig(env: Env = process.env, opts: { mint?: () => string } = {}): { configDir: string; file: string; revision: string; config: HydratedConfig } {
  const layout = TargetRootLayout.fromConfigDir(resolveConfigDir(env));
  const { raw, bytes } = readConfigFile(layout.configFile, layout.root);
  return { configDir: layout.configDir, file: layout.configFile, revision: revision(bytes), config: normalizeConfig(raw, layout.root, opts) };
}

export function selectAgent(config: HydratedConfig, env: Env = process.env): HydratedAgent {
  const agents = config.agents || {};
  const runtimeAgentId = resolveRuntimeAuthority(env);
  if (runtimeAgentId) {
    if (!agents[runtimeAgentId]) throw new Error(`Agent 不存在或未配置：${runtimeAgentId}`);
    return agents[runtimeAgentId];
  }
  if (!config.activeAgent) throw new Error("未配置 activeAgent，无法选择 Agent");
  if (!agents[config.activeAgent]) throw new Error(`activeAgent 指向不存在的 Agent：${config.activeAgent}`);
  return agents[config.activeAgent];
}

export function toStored(config: HydratedConfig): { version: 4; serverId: string | null; mentionPolicy: MentionPolicy; activeAgent: string | null; agents: Record<string, StoredAgent> } {
  const out = { version: 4 as const, serverId: config.serverId, mentionPolicy: config.mentionPolicy, activeAgent: config.activeAgent, agents: {} as Record<string, StoredAgent> };
  for (const [key, agent] of Object.entries(config.agents || {})) {
    const stored: StoredAgent = { runtime: agent.runtime, model: agent.model };
    if (agent.piDistribution) stored.piDistribution = agent.piDistribution;
    if (typeof agent.effort === "string" && agent.effort) stored.effort = agent.effort;
    if (agent.mentionPolicy) stored.mentionPolicy = agent.mentionPolicy;
    if (agent.chatMentionPolicies && Object.keys(agent.chatMentionPolicies).length) stored.chatMentionPolicies = { ...agent.chatMentionPolicies };
    if (typeof agent.createdAt === "string" && agent.createdAt) stored.createdAt = agent.createdAt;
    out.agents[key] = stored;
  }
  return out;
}

export function resolveMentionPolicy(config: HydratedConfig, agentId: string, chatId: string): { effective: MentionPolicy; source: "chat" | "agent" | "global" } {
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Agent 不存在：${agentId}`);
  const chat = agent.chatMentionPolicies?.[chatId];
  if (chat) return { effective: chat, source: "chat" };
  if (agent.mentionPolicy) return { effective: agent.mentionPolicy, source: "agent" };
  return { effective: config.mentionPolicy, source: "global" };
}

/** Resolve non-chat event policy. Deliberately has no chat-id input and never reads per-chat overrides. */
export function resolveAgentGlobalMentionPolicy(config: HydratedConfig, agentId: string): {
  effective: MentionPolicy;
  source: "agent" | "global";
} {
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Agent 不存在：${agentId}`);
  if (agent.mentionPolicy) return { effective: agent.mentionPolicy, source: "agent" };
  return { effective: config.mentionPolicy, source: "global" };
}

function revision(bytes: Buffer | string): string {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function agentSignature(config: HydratedConfig, agentId: string): string {
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Agent 不存在：${agentId}`);
  const chats = Object.fromEntries(Object.entries(agent.chatMentionPolicies || {}).sort(([left], [right]) => left.localeCompare(right)));
  return revision(JSON.stringify({
    runtime: agent.runtime, model: agent.model, piDistribution: agent.piDistribution ?? null, effort: agent.effort ?? null,
    globalMentionPolicy: config.mentionPolicy, agentMentionPolicy: agent.mentionPolicy ?? null, chatMentionPolicies: chats,
  }));
}

export function runtimeConfigSignature(config: HydratedConfig, agentId: string): string {
  return agentSignature(config, agentId);
}

function applyStateFile(configDir: string): string { return path.join(configDir, "config-apply-state.json"); }

function readApplyFile(configDir: string): ConfigApplyFile {
  const file = applyStateFile(configDir);
  try {
    const bytes = readPrivateFile(file, configDir, 256 * 1024, "config apply state");
    if (bytes === null) return { version: 1, persistedRevision: "unknown", agents: {} };
    const value = JSON.parse(bytes.toString("utf8")) as Partial<ConfigApplyFile>;
    if (value.version !== 1 || typeof value.persistedRevision !== "string" || !isPlainObject(value.agents)) throw new Error("config apply state 无效");
    const agents: Record<string, RuntimeApplyRecord> = {};
    for (const [agentId, record] of Object.entries(value.agents)) {
      if (!APP_ID.test(agentId) || !isPlainObject(record) || typeof record.persistedSignature !== "string"
          || (record.appliedSignature !== null && typeof record.appliedSignature !== "string")) throw new Error("config apply state Agent 记录无效");
      agents[agentId] = { persistedSignature: record.persistedSignature, appliedSignature: record.appliedSignature as string | null };
    }
    return { version: 1, persistedRevision: value.persistedRevision, agents };
  } catch (error) { throw error; }
}

function writeApplyFile(configDir: string, value: ConfigApplyFile): void {
  atomicWriteConfig(applyStateFile(configDir), value);
}

export function configApplyState(env: Env, config: HydratedConfig): Record<string, unknown> {
  let state: ConfigApplyFile;
  try { state = readApplyFile(config.configDir); }
  catch { state = { version: 1, persistedRevision: "unknown", agents: {} }; }
  return {
    persistedRevision: state.persistedRevision,
    agents: Object.fromEntries(Object.entries(config.agents).map(([agentId]) => {
      const record = state.agents[agentId];
      const current = agentSignature(config, agentId);
      const applyState = !record ? "unknown" : record.persistedSignature === current && record.appliedSignature === current ? "applied" : "pending";
      return [agentId, { applyState, persistedSignature: current, appliedSignature: record?.appliedSignature ?? null }];
    })),
  };
}

export function markConfigApplied(env: Env, agentId: string, expectedSignature: string): void {
  const layout = TargetRootLayout.fromConfigDir(resolveConfigDir(env));
  withConfigLock(layout, () => {
    const current = readConfigFile(layout.configFile, layout.root);
    if (current.raw === null) throw new Error(`没找到配置 ${layout.configFile}`);
    const config = normalizeConfig(current.raw, layout.root);
    const signature = runtimeConfigSignature(config, agentId);
    if (signature !== expectedSignature) throw new Error("配置在 apply 期间发生变化；未把新配置误标为已应用");
    const state = readApplyFile(layout.root);
    state.persistedRevision = revision(current.bytes);
    state.agents[agentId] = { persistedSignature: signature, appliedSignature: signature };
    writeApplyFile(layout.root, state);
  });
}

function assertAuthority(authority: ConfigAuthority, mutation: ConfigMutation): void {
  if (authority.kind !== "user" && authority.kind !== "agent") throw new Error("配置 authority 无效");
  if (authority.kind === "agent" && !APP_ID.test(authority.agentId)) throw new Error("Runtime Agent authority 格式无效");
  void mutation;
}

function applyMutation(config: HydratedConfig, mutation: ConfigMutation): { scope: "global" | "agent" | "chat"; agentId?: string; runtimeChange: boolean; affectedAgentIds: string[] } {
  if (mutation.kind === "set-global-mention") {
    assertPolicy(mutation.value, "全局 mention policy");
    config.mentionPolicy = mutation.value;
    return { scope: "global", runtimeChange: false, affectedAgentIds: Object.keys(config.agents) };
  }
  if (!APP_ID.test(mutation.agentId) || !config.agents[mutation.agentId]) throw new Error(`Agent 不存在：${mutation.agentId}`);
  const agent = config.agents[mutation.agentId];
  if (mutation.kind === "set-agent-mention") {
    if (mutation.value === "inherit") delete agent.mentionPolicy;
    else { assertPolicy(mutation.value, "Agent mention policy"); agent.mentionPolicy = mutation.value; }
    return { scope: "agent", agentId: mutation.agentId, runtimeChange: false, affectedAgentIds: [mutation.agentId] };
  }
  if (mutation.kind === "set-chat-mention") {
    if (!CHAT_ID.test(mutation.chatId)) throw new Error(`群 ID 格式无效：${mutation.chatId}`);
    const policies = { ...(agent.chatMentionPolicies || {}) };
    if (mutation.value === "inherit") delete policies[mutation.chatId];
    else { assertPolicy(mutation.value, "群 mention policy"); policies[mutation.chatId] = mutation.value; }
    if (Object.keys(policies).length) agent.chatMentionPolicies = policies; else delete agent.chatMentionPolicies;
    agent.noMentionChats = Object.entries(policies).filter(([, value]) => value === "free").map(([chatId]) => chatId);
    return { scope: "chat", agentId: mutation.agentId, runtimeChange: false, affectedAgentIds: [mutation.agentId] };
  }
  if (mutation.kind === "set-agent-runtime") {
    if (!loadRuntimeModels()[mutation.runtime]) throw new Error(`未知 runtime：${mutation.runtime}`);
    assertModel(mutation.runtime, mutation.model || "default");
    agent.runtime = mutation.runtime;
    agent.model = mutation.model || "default";
    delete agent.effort;
  } else if (mutation.kind === "set-agent-model") {
    if (!mutation.model.trim()) throw new Error("model 不能为空");
    assertModel(agent.runtime, mutation.model);
    const changedModel = mutation.model !== agent.model;
    agent.model = mutation.model;
    if (changedModel || mutation.model === "default") delete agent.effort;
  } else {
    if (mutation.effort === null) delete agent.effort;
    else {
      if (agent.model === "default") throw new Error("model=default 时不能设置 effort");
      if (!runtimeSupportsEffort(agent.runtime, mutation.effort)) throw new Error(`effort=${mutation.effort} 不在 ${agent.runtime} 安全档位中`);
      agent.effort = mutation.effort;
    }
  }
  return { scope: "agent", agentId: mutation.agentId, runtimeChange: true, affectedAgentIds: [mutation.agentId] };
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function daemonHasConfiguredAgent(root: string, agentId: string): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(root, "daemon-status.json"), "utf8")) as { pid?: number; processStartToken?: string; commandToken?: string; agents?: string[] };
    const inspected = processInspect.inspectProcess(record.pid);
    return inspected.ok === true && typeof inspected.command === "string" && inspected.command.includes(record.commandToken || "app/runtime-process.mjs")
      && inspected.startToken === record.processStartToken && Array.isArray(record.agents) && record.agents.includes(agentId);
  } catch { return false; }
}

function currentLockRecord(): ConfigLockRecord {
  const inspected = processInspect.inspectProcess(process.pid);
  if (!inspected.ok || !inspected.startToken) throw new Error("无法取得 config lock 进程身份");
  return { pid: process.pid, processStartToken: inspected.startToken, nonce: crypto.randomUUID(), createdAt: new Date().toISOString() };
}

function readLockRecord(file: string): { record: ConfigLockRecord | null; ageMs: number; identity: string } | null {
  try {
    const stat = fs.lstatSync(file);
    const bytes = fs.readFileSync(file);
    let record: ConfigLockRecord | null = null;
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as Partial<ConfigLockRecord>;
      if (Number.isInteger(parsed.pid) && typeof parsed.processStartToken === "string" && typeof parsed.nonce === "string" && typeof parsed.createdAt === "string") {
        record = parsed as ConfigLockRecord;
      }
    } catch { /* malformed lock is reclaimed only after the grace window */ }
    return { record, ageMs: Date.now() - stat.mtimeMs, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${record?.nonce || "malformed"}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function lockIsStale(snapshot: NonNullable<ReturnType<typeof readLockRecord>>): boolean {
  if (!snapshot.record) return snapshot.ageMs >= MALFORMED_LOCK_GRACE_MS;
  const inspected = processInspect.inspectProcess(snapshot.record.pid);
  return inspected.dead === true || (inspected.ok === true && inspected.startToken !== snapshot.record.processStartToken);
}

function reclaimStaleLock(file: string, snapshot: NonNullable<ReturnType<typeof readLockRecord>>, owner: ConfigLockRecord): boolean {
  if (!lockIsStale(snapshot)) return false;
  const guard = `${file}.reclaim`;
  let guardFd: number | null = null;
  for (let attempt = 0; attempt < 2 && guardFd === null; attempt += 1) {
    try { guardFd = fs.openSync(guard, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const orphan = readLockRecord(guard);
      if (!orphan || !lockIsStale(orphan)) return false;
      const latest = readLockRecord(guard);
      if (!latest || latest.identity !== orphan.identity || !lockIsStale(latest)) return false;
      try { fs.unlinkSync(guard); } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
  if (guardFd === null) return false;
  try {
    fs.writeFileSync(guardFd, `${JSON.stringify(owner)}\n`);
    fs.fsyncSync(guardFd);
    const latest = readLockRecord(file);
    if (latest && latest.identity === snapshot.identity && lockIsStale(latest)) fs.unlinkSync(file);
    return true;
  } finally {
    fs.closeSync(guardFd);
    const current = readLockRecord(guard);
    if (current?.record?.nonce === owner.nonce && current.record.pid === owner.pid) {
      try { fs.unlinkSync(guard); } catch { /* best effort owner-only release */ }
    }
  }
}

function withConfigLock<T>(layout: TargetRootLayout, action: () => T): T {
  fs.mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  const lock = `${layout.configFile}.lock`;
  const owner = currentLockRecord();
  let acquired = false;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      acquired = true;
      break;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const snapshot = readLockRecord(lock);
      if (snapshot) reclaimStaleLock(lock, snapshot, owner);
      sleep(10);
    }
  }
  if (!acquired) throw new Error("配置正被其他进程修改，请稍后重试");
  try { return action(); }
  finally {
    const current = readLockRecord(lock);
    if (current?.record?.nonce === owner.nonce && current.record.pid === owner.pid) {
      try { fs.unlinkSync(lock); } catch { /* best effort */ }
    }
  }
}

function atomicWriteConfig(file: string, value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > CONFIG_LIMIT_BYTES) throw new Error(`配置文件超过 ${CONFIG_LIMIT_BYTES} bytes`);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    fsyncDirectoryOf(file);
  } catch (error) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } throw error; }
  return bytes;
}

export function mutateConfig(env: Env, mutation: ConfigMutation, authority: ConfigAuthority): ConfigMutationResult {
  assertAuthority(authority, mutation);
  const layout = TargetRootLayout.fromConfigDir(resolveConfigDir(env));
  return withConfigLock(layout, () => {
    const current = readConfigFile(layout.configFile, layout.root);
    if (current.raw === null) throw new Error(`没找到配置 ${layout.configFile}，先跑 larkin setup`);
    const config = normalizeConfig(current.raw, layout.root);
    const priorSignatures = Object.fromEntries(Object.keys(config.agents).map((agentId) => [agentId, agentSignature(config, agentId)]));
    const changed = applyMutation(config, mutation);
    const stored = toStored(config);
    normalizeConfig(stored, layout.root);
    const bytes = atomicWriteConfig(layout.configFile, stored);
    const nextRevision = revision(bytes);
    let fullyApplied = changed.affectedAgentIds.length === 0;
    try {
      const applyState = readApplyFile(layout.root);
      applyState.persistedRevision = nextRevision;
      fullyApplied = true;
      for (const agentId of changed.affectedAgentIds) {
        const nextSignature = agentSignature(config, agentId);
        const prior = applyState.agents[agentId];
        const daemonHasAgent = daemonHasConfiguredAgent(layout.root, agentId);
        const observedPrior = prior?.appliedSignature ?? (daemonHasAgent ? priorSignatures[agentId] : null);
        const appliedSignature = !changed.runtimeChange && daemonHasAgent && observedPrior === priorSignatures[agentId]
          ? nextSignature
          : observedPrior;
        applyState.agents[agentId] = { persistedSignature: nextSignature, appliedSignature };
        if (appliedSignature !== nextSignature) fullyApplied = false;
      }
      writeApplyFile(layout.root, applyState);
    } catch { fullyApplied = false; /* Config persistence remains authoritative. */ }
    return {
      revision: nextRevision, previousRevision: revision(current.bytes), changedScope: changed.scope,
      ...(changed.agentId ? { agentId: changed.agentId } : {}), persisted: true,
      applyState: fullyApplied ? "applied" : "saved_not_applied", config,
    };
  });
}

export function commitSetupConfig(env: Env, expectedRevision: string, nextStored: unknown): { revision: string; config: HydratedConfig } {
  const layout = TargetRootLayout.fromConfigDir(resolveConfigDir(env));
  return withConfigLock(layout, () => {
    const current = readConfigFile(layout.configFile, layout.root);
    if (revision(current.bytes) !== expectedRevision) throw new Error("setup 期间配置已被其他命令修改；未覆盖并发更新，请重试 setup");
    const config = normalizeConfig(nextStored, layout.root);
    const bytes = atomicWriteConfig(layout.configFile, toStored(config));
    return { revision: revision(bytes), config };
  });
}

export function safeConfigView(config: HydratedConfig, onlyAgentId?: string, chatId?: string, applyState?: Record<string, unknown>): Record<string, unknown> {
  const entries = onlyAgentId ? [[onlyAgentId, config.agents[onlyAgentId]]] as const : Object.entries(config.agents);
  const agents = entries.filter((entry): entry is readonly [string, HydratedAgent] => Boolean(entry[1])).map(([agentId, agent]) => ({
    agentId, runtime: agent.runtime, model: agent.model, effort: agent.effort ?? null,
    mention: {
      override: agent.mentionPolicy ?? "inherit",
      effective: agent.mentionPolicy ?? config.mentionPolicy,
      source: agent.mentionPolicy ? "agent" : "global",
      ...(chatId ? { chat: { chatId, override: agent.chatMentionPolicies?.[chatId] ?? "inherit", ...resolveMentionPolicy(config, agentId, chatId) } } : {}),
    },
    chatMentionPolicies: { ...(agent.chatMentionPolicies || {}) },
    apply: (applyState?.agents as Record<string, unknown> | undefined)?.[agentId] ?? { applyState: "unknown" },
  }));
  return { version: 4, mentionPolicy: config.mentionPolicy, persistedRevision: applyState?.persistedRevision ?? "unknown", agents };
}
