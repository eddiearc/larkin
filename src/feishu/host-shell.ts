import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as channelSdk from "@larksuite/channel";
import { currentProcessMetadata } from "../platform/process-inspect.cjs";
import { reconcileAgentWorkspace } from "../platform/workspace-service.js";
import { createAgentStateStore, type AgentStateStore } from "../agent/agent-state-store.js";
import {
  HostEnvelopeProjector,
  HostStateProjection,
  SenderIdentityCache,
  projectActivityStatus,
  projectSessionStatus,
  safeConversationExcerpt,
  shouldPreventiveReconnect,
} from "./host-business-state.js";
import { ProcessingEyeOrchestrator } from "./host-processing-eye.js";
import { projectInboxEnvelope, targetKeyOfInboxEnvelope } from "../agent/inbox-projection.js";
import { HostReminderOrchestrator } from "../agent/host-reminder-orchestrator.js";
import { HostChannelBusiness } from "./host-channel-business.js";
import { HostInteractionOrchestrator } from "./interaction-orchestrator.js";
import { targetFor, type FeishuInboundEvent } from "./message-policy.js";
import type { RuntimeHost, RuntimeHostEvent } from "../runtime/runtime-host.js";
import { providerAuthenticationFailureReadiness, RuntimePrerequisiteError } from "../runtime/runtime-readiness.js";
import { verifyCallbackProbe } from "../platform/callback-capability.js";
import { loadConfig, resolveMentionPolicy } from "../platform/config.js";
import { processCommandToken } from "../app/internal-command.js";

interface ConfiguredAgent {
  agentId: string;
  name: string;
  runtime: string;
  model: string;
  effort?: string | null;
  displayName?: string | null;
  description?: string | null;
  feishuAppId: string;
  feishuAppSecret?: string;
  feishuProfile: string;
  larkConfigDir: string;
  feishuDomain?: string;
  workspaceDir: string;
  stateDir: string;
  noMentionChats?: string[];
  botOpenId?: string | null;
  botName?: string | null;
}

interface AgentState { agentId?: string; sessions: Record<string, string> }
interface AgentStateRecord { store: AgentStateStore; state: AgentState }
interface HostFrame {
  type?: string;
  agentId?: string;
  status?: string;
  activity?: string;
  sessionId?: string;
  launchId?: string;
  [key: string]: unknown;
}
interface LarkChannel {
  on(handlers: ReturnType<HostChannelBusiness["handlers"]>): void;
  dispatcher: { register(map: Record<string, (raw: unknown) => Promise<unknown> | unknown>): void };
  connect(): Promise<void>;
  disconnect?(): void | Promise<void>;
  updateCard(messageId: string, card: object): Promise<void>;
  rawClient?: { request(input: { url: string; method: string }): Promise<unknown> } | null;
  botIdentity?: { openId?: string; name?: string | null } | null;
}
interface ChannelPackage { createLarkChannel(options: Record<string, unknown>): LarkChannel }

export interface HostShell {
  readonly agents: ConfiguredAgent[];
  readonly serverId: string;
  readonly log: (...parts: unknown[]) => void;
  resumeSession(agent: ConfiguredAgent, runtime: string): string | null;
  ingest(agentId: string, event: FeishuInboundEvent, options?: { wake?: boolean }): Promise<void>;
  upsertAgent(agent: ConfiguredAgent): Promise<"added" | "updated" | "unchanged">;
  start(): Promise<void>;
  shutdown(reason?: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function memberPayloadData(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  let data: Record<string, unknown> | null = null;
  if (value.ok === true && isRecord(value.data)) data = value.data;
  else if (value.code === 0 && isRecord(value.data)) data = value.data;
  if (data && isRecord(data.data)) data = data.data;
  return data;
}

/** Parse both raw OpenAPI and lark-cli wrapped member/bot response shapes. */
export function memberNamesFromPayloads(payloads: readonly unknown[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const payload of payloads) {
    const data = memberPayloadData(payload);
    if (!data) continue;
    const rows = ["items", "users", "bots", "bot_infos"].flatMap((key) =>
      Array.isArray(data[key]) ? data[key] as unknown[] : []);
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const name = String(row.name || row.bot_name || row.member_id || row.open_id || row.app_id || "");
      if (!name) continue;
      for (const key of ["member_id", "open_id", "app_id", "bot_id"] as const) {
        if (row[key]) names[String(row[key])] = name;
      }
    }
  }
  return names;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function agentConfigSignature(agent: ConfiguredAgent): string {
  return JSON.stringify({
    agentId: agent.agentId, runtime: agent.runtime, model: agent.model, effort: agent.effort ?? null,
    feishuAppId: agent.feishuAppId, feishuProfile: agent.feishuProfile,
    larkConfigDir: agent.larkConfigDir, feishuDomain: agent.feishuDomain,
    feishuAppSecret: agent.feishuAppSecret, workspaceDir: agent.workspaceDir, stateDir: agent.stateDir,
    noMentionChats: agent.noMentionChats || [],
  });
}

function loadAgents(
  env: NodeJS.ProcessEnv,
  testEventSource: boolean,
  larkinHome: string,
  reconcileAgentWorkspaceImpl: typeof reconcileAgentWorkspace,
): ConfiguredAgent[] {
  if (!env.LARKIN_AGENTS_CONFIG) throw new Error("LARKIN_AGENTS_CONFIG 缺少，必须提供非空 Agent 数组");
  let parsed: unknown;
  try { parsed = JSON.parse(env.LARKIN_AGENTS_CONFIG); }
  catch (error) { throw new Error(`LARKIN_AGENTS_CONFIG JSON 解析失败: ${errorMessage(error)}`); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("LARKIN_AGENTS_CONFIG 必须是非空 Agent 数组");
  const trustedWorkspaceRoot = path.join(larkinHome, "agents");
  return parsed.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("LARKIN_AGENTS_CONFIG Agent 必须是对象");
    const id = candidate.agentId;
    if (typeof id !== "string" || !/^cli_[A-Za-z0-9]+$/.test(id)
      || candidate.name !== id || candidate.feishuAppId !== id || candidate.feishuProfile !== id) {
      throw new Error("LARKIN_AGENTS_CONFIG Agent identity 必须全部等于合法 App ID");
    }
    for (const field of ["runtime", "model"] as const) {
      if (typeof candidate[field] !== "string" || !candidate[field]) {
        throw new Error(`LARKIN_AGENTS_CONFIG Agent ${id}.${field} 必须是非空字符串`);
      }
    }
    if (!testEventSource && (typeof candidate.feishuAppSecret !== "string" || !candidate.feishuAppSecret.trim()
      || !["https://open.feishu.cn", "https://open.larksuite.com"].includes(String(candidate.feishuDomain)))) {
      throw new Error(`LARKIN_AGENTS_CONFIG Agent ${id} 缺少有效 channel 凭证/domain`);
    }
    const expectedWorkspace = path.join(larkinHome, "agents", id);
    const expectedState = path.join(larkinHome, "state", "agents", id);
    if (path.resolve(String(candidate.workspaceDir || "")) !== expectedWorkspace
      || path.resolve(String(candidate.stateDir || "")) !== expectedState) {
      throw new Error(`LARKIN_AGENTS_CONFIG Agent ${id} workspaceDir/stateDir 不是 canonical single-root 路径`);
    }
    reconcileAgentWorkspaceImpl({ workspaceDir: expectedWorkspace, trustedWorkspaceRoot, lockDir: expectedState, agentId: id });
    return candidate as unknown as ConfiguredAgent;
  });
}

export function createHostShell({
  env = process.env,
  runtimeHost,
  channelPackage,
  eventSourceStartDelayMs = 2_000,
  channelDisconnectTimeoutMs = 2_000,
  execFileImpl = execFile,
  reconcileAgentWorkspaceImpl = reconcileAgentWorkspace,
  logImpl = (...parts: unknown[]): void => { process.stderr.write(`[host] ${parts.join(" ")}\n`); },
  onOrderedShutdownComplete,
}: {
  env?: NodeJS.ProcessEnv;
  runtimeHost: RuntimeHost;
  channelPackage?: ChannelPackage;
  eventSourceStartDelayMs?: number;
  channelDisconnectTimeoutMs?: number;
  execFileImpl?: typeof execFile;
  reconcileAgentWorkspaceImpl?: typeof reconcileAgentWorkspace;
  logImpl?: (...parts: unknown[]) => void;
  onOrderedShutdownComplete?: (exitCode: number) => void;
}): HostShell {
  const eventCommand = env.LARKIN_FEISHU_EVENT_CMD || "";
  const eventFile = env.LARKIN_FEISHU_EVENT_FILE || "";
  const testEventSource = Boolean(eventCommand || eventFile);
  if (testEventSource && env.LARKIN_FEISHU_DRYRUN !== "1") {
    throw new Error("LARKIN_FEISHU_EVENT_CMD/FILE 是测试注入，仅允许在 LARKIN_FEISHU_DRYRUN=1 时使用");
  }
  const larkinHome = env.LARKIN_HOME;
  const configDir = env.LARKIN_CONFIG_DIR;
  const serverId = env.LARKIN_SERVER_ID;
  if (!larkinHome || !configDir) throw new Error("LARKIN_HOME 和 LARKIN_CONFIG_DIR 是必需的 root 配置");
  if (path.resolve(larkinHome) !== path.resolve(configDir)) throw new Error("LARKIN_HOME 与 LARKIN_CONFIG_DIR 必须是同一个 root");
  if (!serverId) throw new Error("LARKIN_SERVER_ID 是必需的 strict server identity");
  const daemonStartedAt = new Date().toISOString();
  const agents = loadAgents(env, testEventSource, larkinHome, reconcileAgentWorkspaceImpl);
  const log = (...parts: unknown[]): void => { logImpl(...parts); };
  const stores = new Map<string, AgentStateStore>();
  const stateStore = (subject: { agentId: string }): AgentStateStore => {
    const agent = agents.find((candidate) => candidate.agentId === subject.agentId)
      ?? ("stateDir" in subject ? subject as ConfiguredAgent : null);
    if (!agent) throw new Error(`未知 Agent state store: ${subject.agentId}`);
    let store = stores.get(agent.agentId);
    if (!store) {
      store = createAgentStateStore(larkinHome, agent.agentId);
      if (path.resolve(store.paths.root) !== path.resolve(agent.stateDir)) throw new Error(`Agent ${agent.agentId} state store 路径不一致`);
      stores.set(agent.agentId, store);
    }
    return store;
  };
  const hostState = new HostStateProjection(stateStore, log);
  const agentStates = new Map<string, AgentStateRecord>();
  const saveAgentState = (record: AgentStateRecord): void => {
    try { record.store.writeJson("agentState", record.state); }
    catch (error) { log(`agent-state 写失败: ${errorMessage(error)}`); }
  };
  const initializeAgentState = (agent: ConfiguredAgent): AgentStateRecord => {
    const existing = agentStates.get(agent.agentId);
    if (existing) return existing;
    const store = stateStore(agent);
    let state: AgentState;
    try {
      const loaded = store.readJson<Partial<AgentState>>("agentState", {});
      state = { ...loaded, sessions: isRecord(loaded.sessions) ? loaded.sessions as Record<string, string> : {} };
    } catch { state = { sessions: {} }; }
    state.agentId = agent.agentId;
    const record = { store, state };
    agentStates.set(agent.agentId, record);
    saveAgentState(record);
    log(`agent 身份: name=${agent.name} agentId=${agent.agentId} sessions=${JSON.stringify(state.sessions)}`);
    return record;
  };
  for (const agent of agents) initializeAgentState(agent);

  const processingEyes = new ProcessingEyeOrchestrator({
    execFile: execFileImpl,
    log,
    recordStatusError: (agent, text) => hostState.recordStatusError(agent, text),
    readPending: (agent) => stateStore(agent as ConfiguredAgent).readJson<{ items?: Array<{ msgId: string; reactionId: string }> }>("pendingReact", {}).items || [],
    writePending: (agent, items) => stateStore(agent as ConfiguredAgent).writeJson("pendingReact", { items }),
  });
  const larkApi = (agent: ConfiguredAgent, method: string, apiPath: string, data: unknown): Promise<Record<string, unknown> | null> =>
    new Promise((resolve) => processingEyes.larkApi(agent, method, apiPath, data, (_error, result) => resolve(result)));
  const fetchMemberPayload = (agent: ConfiguredAgent, args: string[]): Promise<unknown> => new Promise((resolve) => {
    execFileImpl("lark-cli", ["--profile", agent.feishuProfile, "im", ...args, "--json"], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...env, LARKSUITE_CLI_CONFIG_DIR: agent.larkConfigDir },
    }, (error, stdout) => {
      if (error) log(`成员表子查询失败 agent=${agent.name}: ${errorMessage(error).slice(0, 100)}`);
      try { resolve(JSON.parse(String(stdout))); }
      catch { resolve(null); }
    });
  });
  const fetchChatNames = async (agent: ConfiguredAgent, chatId: string): Promise<Record<string, string> | null> => {
    const payloads = await Promise.all([
      fetchMemberPayload(agent, ["chat.members", "get", "--chat-id", chatId, "--member-id-type", "open_id", "--page-all"]),
      fetchMemberPayload(agent, ["chat.members", "bots", "--chat-id", chatId]),
    ]);
    const names = memberNamesFromPayloads(payloads);
    if (!Object.keys(names).length) {
      log(`成员表拉取失败 agent=${agent.name} chat=${chatId}`);
      return null;
    }
    return names;
  };
  const signatureTtl = 6 * 60 * 60 * 1000;
  const signatureFailTtl = 10 * 60 * 1000;
  const signatureNotFoundTtl = 7 * 24 * 60 * 60 * 1000;
  const fetchSenderSignature = async (agent: ConfiguredAgent, openId: string) => {
    const response = await larkApi(agent, "GET", `/open-apis/contact/v3/users/${openId}?user_id_type=open_id`, null);
    const data = response && isRecord(response.data) ? response.data : null;
    const user = data && isRecord(data.user) ? data.user : null;
    if (!user) return { desc: null, name: null, ok: false, ttl: response ? signatureNotFoundTtl : signatureFailTtl };
    return {
      desc: String(user.description || "").trim() || null,
      name: user.name ? String(user.name) : null,
      ok: true,
      ttl: signatureTtl,
    };
  };
  const senderIdentity = new SenderIdentityCache({
    state: hostState,
    fetchChatNames,
    fetchSenderSignature,
    signatureFailureTtlMs: signatureFailTtl,
  });
  const envelopeProjector = new HostEnvelopeProjector(
    hostState,
    (agent, chatId, senderId) => senderIdentity.noteUnknownSender(agent, chatId, senderId),
    undefined,
    undefined,
    "larkin",
  );
  const prepareAgentState = (agent: ConfiguredAgent): void => {
    fs.mkdirSync(agent.stateDir, { recursive: true });
    if (!agent.botOpenId) {
      try {
        const cached = stateStore(agent).readJson<{ open_id?: string; name?: string | null }>("botIdentity", {});
        if (cached.open_id) { agent.botOpenId = cached.open_id; agent.botName = cached.name || null; }
      } catch { /* first run */ }
    }
    processingEyes.restoreAndClear(agent);
    try {
      const known = new Set(Object.values(hostState.loadMap(agent)).filter((value) => /^oc_/.test(String(value))));
      for (const chatId of known) void senderIdentity.ensureChatNames(agent, chatId, 0);
    } catch { /* no map */ }
    senderIdentity.warmSenderProfiles(agent);
  };
  for (const agent of agents) prepareAgentState(agent);
  const reminder = new HostReminderOrchestrator({ agents, stateStore, envelopeProjector, deliveryTarget: runtimeHost, log });
  const seenEventIds = new Set<string>();
  const onFeishuMessage = async (agent: ConfiguredAgent, event: FeishuInboundEvent, options?: { wake?: boolean }): Promise<void> => {
    const wake = options?.wake !== false;
    const eventKey = `${agent.agentId}:${event.event_id || event.message_id || ""}`;
    if (event.event_id && seenEventIds.has(eventKey)) return;
    if (event.event_id) seenEventIds.add(eventKey);
    if (agent.botOpenId && event.sender_id === agent.botOpenId) { log(`agent=${agent.name} 跳过自己发的消息`); return; }
    try {
      const [names, signature] = await Promise.all([
        senderIdentity.ensureChatNames(agent, event.chat_id, 3_000),
        event._sender_is_bot ? Promise.resolve(null) : senderIdentity.ensureSenderSignature(agent, event.sender_id, 3_000),
      ]);
      const envelope = envelopeProjector.projectInbound(agent, event, { anchorReply: wake, names, signature }) as unknown as Record<string, unknown>;
      envelope.target = targetKeyOfInboxEnvelope({ ...envelope, chat_id: event.chat_id, thread_id: event.thread_id });
      if (wake) envelope.wake = true;
      const inboxEnvelope = projectInboxEnvelope(envelope, {
        chat_id: event.chat_id,
        thread_id: event.thread_id,
        sender_id: event.sender_id,
        content: String(envelope.content ?? event.content ?? ""),
      });
      try { stateStore(agent).appendNdjson("inbox", inboxEnvelope); }
      catch (error) { throw new Error(`inbox 写失败: ${errorMessage(error)}`); }
      hostState.appendConversation(agent, {
        direction: "in", from: envelope.sender_name, senderType: envelope.sender_type,
        target: targetFor(event).target, wake, text: event.content, messageId: envelope.message_id,
        at: envelope.timestamp || new Date().toISOString(),
      });
      if (!wake) return;
      const receipt = await runtimeHost.deliver(agent.agentId, envelope);
      if (receipt.status === "accepted" || receipt.status === "duplicate" || receipt.status === "deferred") {
        hostState.appendStatusLog(agent, "deliverLog", {
          from: envelope.sender_name,
          target: targetFor(event).target,
          excerpt: safeConversationExcerpt(event.content, 180),
          at: new Date().toISOString(),
        }, 30);
        if (envelope.sender_type === "human") processingEyes.add(agent, String(envelope.message_id || ""));
        if (receipt.status === "deferred") log(`Runtime 暂缓投递，消息保留在 inbox seq=${envelope.seq}: ${receipt.reason}`);
      }
    } catch (error) {
      log(`onFeishuMessage 异常 agent=${agent.name}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      hostState.recordStatusError(agent, `onFeishuMessage: ${errorMessage(error)}`);
    }
  };
  const interactionChannels = new Map<string, LarkChannel>();
  const interaction = new HostInteractionOrchestrator({
    agents,
    stateStore,
    deliveryTarget: runtimeHost,
    channelFor: (agent) => interactionChannels.get(agent.agentId),
    log,
  });
  const channelBusiness = new HostChannelBusiness({
    state: hostState,
    stateStore,
    onMessage: onFeishuMessage,
    mentionPolicy: (agentId, chatId) => {
      try { return resolveMentionPolicy(loadConfig(env).config, agentId, chatId).effective; }
      catch (error) {
        const startupAgent = agents.find((candidate) => candidate.agentId === agentId);
        const fallback = startupAgent?.noMentionChats?.includes(chatId) ? "free" : "require";
        log(`mention policy 刷新失败，使用已验证启动快照 agent=${agentId}: ${errorMessage(error)}`);
        return fallback;
      }
    },
    onCardAction: (agent, event) => {
      const value = isRecord(event.action.value) ? event.action.value : null;
      const nonce = typeof value?.larkin_callback_probe === "string" ? value.larkin_callback_probe : null;
      if (nonce) {
        const raw = isRecord(event.raw) ? event.raw : null;
        const header = raw && isRecord(raw.header) ? raw.header : null;
        const eventId = String(raw?.event_id || header?.event_id || "");
        let verified = false;
        try { verified = verifyCallbackProbe(larkinHome, agent.agentId, nonce, eventId); }
        catch (error) { log(`callback probe 验证失败 agent=${agent.name}: ${errorMessage(error)}`); }
        return { toast: { type: verified ? "success" : "error", content: verified
          ? "回调已真实送达，card.action.trigger 状态已验证生效。"
          : "验证卡已失效或不匹配，请重新生成 callback-probe。" } };
      }
      return interaction.handleCardAction(agent as ConfiguredAgent, event);
    },
    log,
  });

  const startChannelSource = (agent: ConfiguredAgent, callbacks: { onConnectFail?(error: unknown): void; onFatal?(error: Error): void }): LarkChannel => {
    const { createLarkChannel } = channelPackage ?? channelSdk as unknown as ChannelPackage;
    log(`入站(createLarkChannel): agent=${agent.name} app=${agent.feishuAppId} (群需@)`);
    const channel = createLarkChannel({
      appId: agent.feishuAppId,
      appSecret: agent.feishuAppSecret,
      domain: agent.feishuDomain || "https://open.feishu.cn",
      source: "larkin",
      policy: { dmMode: "open", requireMention: false, respondToMentionAll: true },
      handshakeTimeoutMs: 15_000,
      keepalive: {
        enabled: true,
        intervalMs: 15_000,
        onUnrecoverable: (error: unknown) => {
          log(`keepalive 无法恢复事件连接 agent=${agent.name}`);
          callbacks.onFatal?.(error instanceof Error ? error : new Error("keepalive unrecoverable"));
        },
      },
      includeRawEvent: true,
    });
    interactionChannels.set(agent.agentId, channel);
    channel.on(channelBusiness.handlers(agent));
    channelBusiness.registerReadReceipts(agent, channel.dispatcher);
    channel.connect().then(() => {
      channelBusiness.registerCardActions(agent, channel.dispatcher);
      return channelBusiness.connected(agent, channel, callbacks.onFatal);
    })
      .catch((error: unknown) => { log(`channel.connect 失败 agent=${agent.name}`); callbacks.onConnectFail?.(error); });
    return channel;
  };

  let eventSourceStop: () => void | Promise<void> = () => {};
  let eventSourceStartTimer: NodeJS.Timeout | null = null;
  let requestOrderedShutdown: (reason: string, exitCode?: number) => Promise<void> = async () => {};
  let hotUpsert: ((agent: ConfiguredAgent) => Promise<"added" | "updated" | "unchanged">) | null = null;
  const startEventSource = (): void => {
    let shuttingDown = false;
    const startChild = (agent: ConfiguredAgent, command: string, args: string[], childEnv: NodeJS.ProcessEnv = process.env): void => {
      log(`自定义事件源: agent=${agent.name} command=${command}`);
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: childEnv });
      eventSourceStop = () => { try { child.kill("SIGTERM"); } catch { /* already exited */ } };
      if (child.stdout) readline.createInterface({ input: child.stdout }).on("line", (raw) => {
        const line = raw.trim();
        if (!line) return;
        try {
          const parsed = JSON.parse(line) as unknown;
          const record = isRecord(parsed) ? parsed : {};
          const data = isRecord(record.data) ? record.data : null;
          const event = data && isRecord(data.event) ? data.event : isRecord(record.event) ? record.event : data || record;
          void onFeishuMessage(agent, event as unknown as FeishuInboundEvent);
        } catch { /* not an event */ }
      });
      child.on("exit", (code) => log(`事件源退出 agent=${agent.name} code=${code}`));
    };
    if (eventCommand) {
      const parts = eventCommand.split(" ");
      startChild(agents[0], parts[0], parts.slice(1));
      return;
    }
    if (eventFile) {
      log("文件事件源(测试):", eventFile);
      let offset = 0;
      fs.writeFileSync(eventFile, fs.existsSync(eventFile) ? fs.readFileSync(eventFile) : "");
      const fileTimer = setInterval(() => {
        try {
          const content = fs.readFileSync(eventFile, "utf8");
          if (content.length <= offset) return;
          const fresh = content.slice(offset);
          offset = content.length;
          for (const line of fresh.split("\n").filter(Boolean)) {
            try { void onFeishuMessage(agents[0], JSON.parse(line) as FeishuInboundEvent); } catch { /* partial line */ }
          }
        } catch { /* retry */ }
      }, 500);
      eventSourceStop = () => clearInterval(fileTimer);
      return;
    }
    const profileAgents = agents.filter((agent) => agent.feishuProfile);
    if (!profileAgents.length) { log("未配置 channel 事件源，入站不启动"); return; }
    const channels: LarkChannel[] = [];
    const channelOwners = new Map<LarkChannel, ConfiguredAgent>();
    const activeChannels = new Map<string, LarkChannel>();
    const reconnectFns = new Map<string, () => void>();
    const retryTimers = new Set<NodeJS.Timeout>();
    let droughtTimer: NodeJS.Timeout | null = null;
    const droughtMaintenance = new Map<string, {
      baselineInboundAt: number | null;
      failures: number;
      inFlight: boolean;
      retryScheduled: boolean;
      closed: boolean;
      failureRecorded: boolean;
    }>();
    const eventSourceStartedMs = Date.now();
    let fataling = false;
    const disconnectSafely = (channel: LarkChannel): Promise<void> => {
      try { return Promise.resolve(channel.disconnect?.()); }
      catch (error) { return Promise.reject(error); }
    };
    const disconnectWithinBound = (channel: LarkChannel): Promise<void> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("channel disconnect timeout")), channelDisconnectTimeoutMs);
      disconnectSafely(channel).then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
    });
    const connectCandidate = async (agent: ConfiguredAgent, activateImmediately = false): Promise<{
      channel: LarkChannel; activate(): void;
    }> => {
      const { createLarkChannel } = channelPackage ?? channelSdk as unknown as ChannelPackage;
      const channel = createLarkChannel({
        appId: agent.feishuAppId,
        appSecret: agent.feishuAppSecret,
        domain: agent.feishuDomain || "https://open.feishu.cn",
        source: "larkin",
        policy: { dmMode: "open", requireMention: false, respondToMentionAll: true },
        handshakeTimeoutMs: 15_000,
        keepalive: { enabled: true, intervalMs: 15_000 },
      });
      const handlers = channelBusiness.handlers(agent);
      let active = activateImmediately;
      const queuedMessages: Parameters<typeof handlers.message>[0][] = [];
      channel.on({ ...handlers,
        message: (message) => { if (active) handlers.message(message); else queuedMessages.push(message); },
        cardAction: (event) => active ? handlers.cardAction(event)
          : Promise.resolve({ toast: { type: "info", content: "Agent 配置切换中，请稍后重试。" } }),
      });
      channelBusiness.registerReadReceipts(agent, channel.dispatcher);
      try {
        await channel.connect();
        if (!channel.botIdentity?.openId) throw new Error(`Agent ${agent.agentId} channel 已连接但 bot identity 不可用`);
        await channelBusiness.connected(agent, channel);
        let activated = false;
        const activate = (): void => {
          if (activated) return;
          activated = true;
          active = true;
          channelBusiness.registerCardActions(agent, channel.dispatcher);
          for (const message of queuedMessages.splice(0)) handlers.message(message);
        };
        if (activateImmediately) activate();
        return { channel, activate };
      } catch (error) {
        await disconnectWithinBound(channel).catch(() => {});
        throw error;
      }
    };
    let channelStopPromise: Promise<void> | null = null;
    eventSourceStop = () => {
      if (channelStopPromise) return channelStopPromise;
      shuttingDown = true;
      if (droughtTimer) clearInterval(droughtTimer);
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
      log(`disconnect ${channels.length} 条事件连接…`);
      const closingChannels = [...channels];
      channelStopPromise = Promise.allSettled(closingChannels.map(disconnectWithinBound)).then((results) => {
        let failures = 0;
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          if (result.status === "fulfilled") continue;
          failures += 1;
          const agent = channelOwners.get(closingChannels[index]);
          const outcome = /timeout/i.test(errorMessage(result.reason)) ? "超时" : "失败";
          const message = `channel disconnect ${outcome}${agent ? ` agent=${agent.name}` : ""}`;
          if (agent) hostState.recordStatusError(agent, message);
          log(message);
        }
        if (failures === 0) log("已断开事件连接");
        else log(`事件连接关闭完成：成功 ${results.length - failures}，失败 ${failures}`);
      });
      return channelStopPromise;
    };
    const failEventSource = (agent: ConfiguredAgent, error: unknown): void => {
      if (fataling || shuttingDown) return;
      fataling = true;
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
      const authish = /secret|invalid|bot identity|10014|20005|unauthorized|forbidden/i.test(errorMessage(error));
      const message = `channel 入站不可用 agent=${agent.name}: ${authish ? "认证失败" : "连接重试耗尽"}`;
      hostState.recordStatusError(agent, message);
      log(`${message}；整进程退出，请修复凭证/连接后重启`);
      requestOrderedShutdown(message, 1);
    };
    for (const agent of profileAgents) {
      let retries = 0;
      const tryChannel = (): void => {
        let channel: LarkChannel;
        const removeChannel = (): void => {
          const index = channels.indexOf(channel);
          if (index >= 0) channels.splice(index, 1);
          channelOwners.delete(channel);
          if (activeChannels.get(agent.agentId) === channel) activeChannels.delete(agent.agentId);
        };
        try {
          channel = startChannelSource(agent, {
            onFatal: (error) => failEventSource(agent, error),
            onConnectFail: (error) => {
              if (shuttingDown || fataling) return;
              const authish = /secret|invalid|bot identity|10014|20005|unauthorized|forbidden/i.test(errorMessage(error));
              if (authish || retries >= 5) { failEventSource(agent, error); return; }
              const delay = Math.min(60, 5 * 2 ** retries++);
              disconnectWithinBound(channel).then(() => {
                if (shuttingDown || fataling) return;
                removeChannel();
                hostState.recordStatusError(agent, `channel.connect 失败，${delay}s 后重试`);
                log(`channel.connect ${delay}s 后重试 agent=${agent.name}（第 ${retries} 次）`);
                const timer = setTimeout(() => { retryTimers.delete(timer); tryChannel(); }, delay * 1_000);
                retryTimers.add(timer);
              }).catch((disconnectError) => failEventSource(agent, disconnectError));
            },
          });
        } catch (error) { failEventSource(agent, error); return; }
        channels.push(channel);
        channelOwners.set(channel, agent);
        activeChannels.set(agent.agentId, channel);
      };
      reconnectFns.set(agent.agentId, tryChannel);
      tryChannel();
      if (fataling) break;
    }
    hotUpsert = async (candidate): Promise<"added" | "updated" | "unchanged"> => {
      if (shuttingDown || fataling) throw new Error("HostShell 正在关闭或 channel 不可用");
      const index = agents.findIndex((agent) => agent.agentId === candidate.agentId);
      const previous = index >= 0 ? agents[index] : null;
      const unchanged = previous && agentConfigSignature(previous) === agentConfigSignature(candidate);
      if (unchanged && activeChannels.has(candidate.agentId)) return "unchanged";

      // Runtime replacement is target-only. The old channel remains connected until the
      // candidate Runtime and channel are both ready, so unrelated Agents are untouched.
      const runtimeCandidate = { ...candidate,
        sessionId: agentStates.get(candidate.agentId)?.state.sessions[candidate.runtime] || null };
      const staged = previous && runtimeHost.stage ? await runtimeHost.stage(runtimeCandidate) : null;
      const candidateReadiness = staged?.readiness ?? (runtimeHost.probe ? await runtimeHost.probe(runtimeCandidate)
        : { runtime: candidate.runtime as "codex" | "claude" | "pi", state: "ready" as const });
      if (candidateReadiness.state !== "ready") throw new RuntimePrerequisiteError(candidateReadiness);
      initializeAgentState(candidate);
      prepareAgentState(candidate);
      if (!staged) {
        if (previous) await runtimeHost.stop(previous.agentId, "target agent hot update");
        try { await runtimeHost.start([runtimeCandidate]); }
        catch (error) {
          if (previous) await runtimeHost.start([{ ...previous,
            sessionId: agentStates.get(previous.agentId)?.state.sessions[previous.runtime] || null }]).catch(() => {});
          throw error;
        }
      }
      let nextConnection: Awaited<ReturnType<typeof connectCandidate>>;
      try { nextConnection = await connectCandidate(candidate); }
      catch (error) {
        if (staged) await staged.rollback("hot attach channel rollback");
        else await runtimeHost.stop(candidate.agentId, "hot attach channel rollback");
        if (previous && !staged) await runtimeHost.start([{
          ...previous,
          sessionId: agentStates.get(previous.agentId)?.state.sessions[previous.runtime] || null,
        }]).catch(() => {});
        throw error;
      }
      const nextChannel = nextConnection.channel;
      const oldChannel = activeChannels.get(candidate.agentId);
      if (oldChannel) {
        try { await disconnectWithinBound(oldChannel); }
        catch (error) {
          await disconnectWithinBound(nextChannel).catch(() => {});
          if (staged) await staged.rollback("hot update old channel rollback");
          else await runtimeHost.stop(candidate.agentId, "hot update old channel rollback");
          if (previous && !staged) await runtimeHost.start([{
            ...previous,
            sessionId: agentStates.get(previous.agentId)?.state.sessions[previous.runtime] || null,
          }]).catch(() => {});
          throw new Error(`旧 Agent channel 无法安全断开：${errorMessage(error)}`);
        }
        const oldIndex = channels.indexOf(oldChannel);
        if (oldIndex >= 0) channels.splice(oldIndex, 1);
        channelOwners.delete(oldChannel);
      }
      if (staged) {
        try { await staged.commit(); }
        catch (error) {
          await disconnectWithinBound(nextChannel).catch(() => {});
          throw error;
        }
      }
      if (index >= 0) agents[index] = candidate;
      else agents.push(candidate);
      if (!profileAgents.some((agent) => agent.agentId === candidate.agentId)) profileAgents.push(candidate);
      else {
        const profileIndex = profileAgents.findIndex((agent) => agent.agentId === candidate.agentId);
        profileAgents[profileIndex] = candidate;
      }
      channels.push(nextChannel);
      channelOwners.set(nextChannel, candidate);
      activeChannels.set(candidate.agentId, nextChannel);
      interactionChannels.set(candidate.agentId, nextChannel);
      nextConnection.activate();
      reconnectFns.set(candidate.agentId, () => {
        void connectCandidate(candidate, true).then(({ channel }) => {
          channels.push(channel); channelOwners.set(channel, candidate); activeChannels.set(candidate.agentId, channel);
          interactionChannels.set(candidate.agentId, channel);
        }).catch((error) => failEventSource(candidate, error));
      });
      interaction.syncAgent(candidate);
      await interaction.flushPending(candidate);
      reminder.pushSnapshot(candidate, "hot attach", true);
      await reminder.redeliverUnread(candidate);
      try {
        fs.writeFileSync(path.join(larkinHome, "daemon-status.json"), JSON.stringify({
          ...currentProcessMetadata(processCommandToken("daemon", "app/runtime-process.mjs")), pid: process.pid, startedAt: daemonStartedAt,
          agents: agents.map((agent) => agent.agentId),
        }, null, 2), { mode: 0o600 });
      } catch (error) { log(`daemon ownership 更新失败: ${errorMessage(error)}`); }
      return previous ? "updated" : "added";
    };

    // 预防性重连 watchdog：连接自称健康但长期零入站事件 → 疑似僵尸连接（ws 活着、飞书事件路由死了，
    // 2026-07-17 实测；传输层 keepalive 探不出来）。主动断开重建无害——飞书会补投窗口内事件。
    // 默认 10 分钟；LARKIN_INBOUND_DROUGHT_SEC 可调（集成测试用小值），设 0 关闭。
    const droughtSecRaw = env.LARKIN_INBOUND_DROUGHT_SEC;
    const droughtSec = droughtSecRaw === undefined || droughtSecRaw === "" ? 600 : Math.max(0, Number(droughtSecRaw) || 0);
    if (droughtSec > 0) {
      const attemptDroughtMaintenance = (
        agent: ConfiguredAgent,
        channel: LarkChannel,
        maintenance: {
          baselineInboundAt: number | null;
          failures: number;
          inFlight: boolean;
          retryScheduled: boolean;
          closed: boolean;
          failureRecorded: boolean;
        },
      ): void => {
        if (shuttingDown || fataling || maintenance.inFlight || maintenance.closed) return;
        if (activeChannels.get(agent.agentId) !== channel) return;
        const latestInboundAt = Date.parse(String(hostState.readStatus(agent).inboundVerifiedAt || ""));
        if (Number.isFinite(latestInboundAt) && (maintenance.baselineInboundAt === null || latestInboundAt > maintenance.baselineInboundAt)) {
          droughtMaintenance.delete(agent.agentId);
          return;
        }
        maintenance.inFlight = true;
        log(`入站静默 ≥${droughtSec}s（连接在线但零事件），本静默周期执行一次预防性重连 agent=${agent.name}`);
        disconnectWithinBound(channel).then(() => {
          maintenance.inFlight = false;
          maintenance.closed = true;
          if (shuttingDown || fataling) return;
          if (activeChannels.get(agent.agentId) !== channel) return;
          activeChannels.delete(agent.agentId);
          channelOwners.delete(channel);
          const index = channels.indexOf(channel);
          if (index >= 0) channels.splice(index, 1);
          const droughtReconnectAt = new Date().toISOString();
          // 成功维护是中性活动；只有 disconnect 真失败才记录 recentErrors。
          hostState.appendStatusLog(agent, "activityLog", {
            at: droughtReconnectAt,
            state: "online",
            detail: `入站静默 ≥${droughtSec}s，本静默周期已完成一次预防性重连`,
          }, 80);
          hostState.updateStatus(agent, { droughtReconnectAt, droughtReconnectAbandonedAt: null });
          reconnectFns.get(agent.agentId)?.();
        }).catch((error) => {
          maintenance.inFlight = false;
          if (shuttingDown || fataling) return;
          maintenance.failures += 1;
          const timeout = /timeout/i.test(errorMessage(error));
          const reason = timeout ? "超时" : "被 SDK 拒绝";
          if (!maintenance.failureRecorded) {
            maintenance.failureRecorded = true;
            hostState.recordStatusError(agent, `预防性重连未执行：旧 channel 断开失败（${reason}），将有限重试一次`);
          }
          if (maintenance.failures >= 2) {
            maintenance.closed = true;
            const droughtReconnectAbandonedAt = new Date().toISOString();
            hostState.updateStatus(agent, { droughtReconnectAbandonedAt });
            log(`预防性重连停止：旧 channel 连续 2 次断开失败（${reason}），保留原 channel 等待真实入站后开启新周期 agent=${agent.name}`);
            return;
          }
          maintenance.retryScheduled = true;
          const retryDelayMs = Math.min(60_000, Math.max(1_000, droughtSec * 1_000));
          const timer = setTimeout(() => {
            retryTimers.delete(timer);
            maintenance.retryScheduled = false;
            attemptDroughtMaintenance(agent, channel, maintenance);
          }, retryDelayMs);
          retryTimers.add(timer);
          log(`预防性重连未执行：旧 channel 断开失败（${reason}），保留原 channel 并有限重试一次 agent=${agent.name}`);
        });
      };
      droughtTimer = setInterval(() => {
        if (shuttingDown || fataling) return;
        for (const agent of profileAgents) {
          const channel = activeChannels.get(agent.agentId);
          if (!channel) continue;
          const now = new Date();
          const status = hostState.readStatus(agent);
          const inboundAt = Date.parse(String(status.inboundVerifiedAt || ""));
          let maintenance = droughtMaintenance.get(agent.agentId);
          if (maintenance && Number.isFinite(inboundAt) && (maintenance.baselineInboundAt === null || inboundAt > maintenance.baselineInboundAt)) {
            droughtMaintenance.delete(agent.agentId);
            maintenance = undefined;
          }
          if (maintenance?.inFlight || maintenance?.retryScheduled || maintenance?.closed) continue;
          if (!shouldPreventiveReconnect(status, now, droughtSec * 1_000, eventSourceStartedMs)) continue;
          if (!maintenance) {
            maintenance = {
              baselineInboundAt: Number.isFinite(inboundAt) ? inboundAt : null,
              failures: 0,
              inFlight: false,
              retryScheduled: false,
              closed: false,
              failureRecorded: false,
            };
            droughtMaintenance.set(agent.agentId, maintenance);
          }
          attemptDroughtMaintenance(agent, channel, maintenance);
        }
      }, Math.max(1_000, Math.min(60_000, droughtSec * 500)));
      droughtTimer.unref?.();
    }
  };

  const onRuntimeEvent = (message: RuntimeHostEvent): void => {
    const agent = agents.find((candidate) => candidate.agentId === message.agentId);
    if (!agent) return;
    if (message.type === "agent-status") {
      log("agent:status", message.agentId, message.status);
      if (message.readiness) hostState.updateStatus(agent, { runtimeReadiness: message.readiness });
      else if (message.status === "active") hostState.updateStatus(agent, { runtimeReadiness: {
        runtime: agent.runtime, state: "ready",
      } });
      if (message.status === "active") {
        const redeliveryTimer = setTimeout(() => {
          void reminder.redeliverUnread(agent).catch((error) => log("启动补投失败", errorMessage(error)));
        }, 5_000);
        redeliveryTimer.unref?.();
      }
      if (message.status === "error" && message.error) hostState.recordStatusError(agent, message.error);
      if (message.status === "error" || message.status === "inactive") {
        processingEyes.clear(agent, `agent-status:${message.status}`);
      }
      return;
    }
    if (message.type === "activity") {
      if (message.isHeartbeat) return;
      const frame: HostFrame = { agentId: message.agentId, activity: message.activity,
        activityKind: message.activityKind, detailKind: message.detailKind, isHeartbeat: message.isHeartbeat };
      const patch = projectActivityStatus(hostState.readStatus(agent), frame, agent.runtime,
        agentStates.get(agent.agentId)?.state.sessions[agent.runtime] || null);
      if (patch) hostState.updateStatus(agent, patch);
      processingEyes.observeActivity(agent, message.activity);
      return;
    }
    if (message.type === "delivery") {
      hostState.appendStatusLog(agent, "deliverLog", {
        at: new Date().toISOString(), deliveryId: message.deliveryId, messageId: message.messageId,
        status: message.status, ...(message.reason ? { reason: safeConversationExcerpt(message.reason, 120) } : {}),
      }, 80);
      return;
    }
    if (message.type === "session") {
      const record = agentStates.get(agent.agentId);
      if (record && record.state.sessions[message.runtime] !== message.sessionId) {
        record.state.sessions[message.runtime] = message.sessionId;
        saveAgentState(record);
        log(`持久化 agent=${agent.name} runtime=${message.runtime} sessionId=${message.sessionId}`);
      }
      hostState.updateStatus(agent, projectSessionStatus(hostState.readStatus(agent), message.runtime, message.sessionId, message.launchId, new Date(), {
        ...(message.model ? { model: message.model } : {}),
        ...(message.reasoningEffort ? { reasoningEffort: message.reasoningEffort } : {}),
      }));
      return;
    }
    if (message.type === "runtime" && message.event.type === "input-error") {
      if (message.event.errorCategory === "auth") {
        const readiness = providerAuthenticationFailureReadiness(agent.runtime as "codex" | "claude" | "pi", message.event.upstream?.provider);
        hostState.recordStatusError(agent, `auth: ${readiness.reason}; ${readiness.nextAction}`);
      } else {
        hostState.recordStatusError(agent, `${message.event.errorCategory || "provider"}: ${message.event.message}${message.event.nextAction ? `; ${message.event.nextAction}` : ""}`);
      }
    }
  };

  let shutdownPromise: Promise<void> | null = null;
  let orderedExitDispatched = false;
  const dispatchOrderedExit = (exitCode: number): void => {
    if (orderedExitDispatched || !onOrderedShutdownComplete) return;
    orderedExitDispatched = true;
    onOrderedShutdownComplete(exitCode);
  };
  const shutdown = (reason = "shutdown"): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (eventSourceStartTimer) clearTimeout(eventSourceStartTimer);
      eventSourceStartTimer = null;
      await Promise.resolve(eventSourceStop());
      reminder.stopSync();
      interaction.stopSync();
      await runtimeHost.shutdown(reason);
    })();
    return shutdownPromise;
  };
  requestOrderedShutdown = (reason, exitCode) => {
    if (exitCode !== undefined) process.exitCode = exitCode;
    const currentExitCode = typeof process.exitCode === "number" ? process.exitCode : Number(process.exitCode) || 0;
    const requestedExitCode = exitCode ?? currentExitCode;
    return shutdown(reason).then(() => dispatchOrderedExit(requestedExitCode)).catch((error) => {
      process.exitCode = 1;
      log(`shutdown 失败: ${errorMessage(error)}`);
      dispatchOrderedExit(1);
    });
  };

  return {
    agents,
    serverId,
    log,
    resumeSession(agent, runtime): string | null { return agentStates.get(agent.agentId)?.state.sessions[runtime] || null; },
    async ingest(agentId, event, options): Promise<void> {
      const agent = agents.find((candidate) => candidate.agentId === agentId);
      if (!agent) throw new Error(`未知 Agent: ${agentId}`);
      await onFeishuMessage(agent, event, options);
    },
    async upsertAgent(candidate): Promise<"added" | "updated" | "unchanged"> {
      const validated = loadAgents({ ...env, LARKIN_AGENTS_CONFIG: JSON.stringify([candidate]) }, false, larkinHome, reconcileAgentWorkspaceImpl)[0];
      if (!hotUpsert) throw new Error("Agent control plane 尚未就绪");
      if (runtimeHost.isBusy?.(validated.agentId)) throw new Error(`Agent ${validated.agentId} 正在执行 turn，拒绝中断；请在 idle 后重试`);
      return hotUpsert(validated);
    },
    async start(): Promise<void> {
      try {
        fs.mkdirSync(larkinHome, { recursive: true });
        fs.writeFileSync(path.join(larkinHome, "daemon-status.json"), JSON.stringify({
          ...currentProcessMetadata(processCommandToken("daemon", "app/runtime-process.mjs")), pid: process.pid, startedAt: daemonStartedAt,
          agents: agents.map((agent) => agent.agentId),
        }, null, 2), { mode: 0o600 });
      } catch (error) { log(`daemon-status 写失败: ${errorMessage(error)}`); }
      runtimeHost.subscribe(onRuntimeEvent);
      process.once("SIGINT", () => requestOrderedShutdown("SIGINT", 130));
      process.once("SIGTERM", () => requestOrderedShutdown("SIGTERM", 143));
      try {
        await runtimeHost.start(agents.map((agent) => ({
          ...agent,
          sessionId: agentStates.get(agent.agentId)?.state.sessions[agent.runtime] || null,
        })));
        reminder.startSync();
        interaction.startSync();
        eventSourceStartTimer = setTimeout(() => { eventSourceStartTimer = null; startEventSource(); }, eventSourceStartDelayMs);
      } catch (error) {
        log(`Runtime Host 启动失败: ${errorMessage(error)}`);
        await requestOrderedShutdown("Runtime Host 启动失败", 1);
        throw error;
      }
    },
    shutdown,
  };
}
