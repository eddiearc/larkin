import type { AgentStatePaths } from "../platform/root-layout.js";
import { RUNTIME_REDELIVERY_TARGET, RUNTIME_REMINDER_TARGET } from "../agent/inbox-projection.js";
import crypto from "node:crypto";
import {
  createMessageEnvelope,
  targetAliases,
  targetFor,
  type EnvelopeAgentIdentity,
  type FeishuInboundEvent,
  type MessageEnvelope,
} from "./message-policy.js";

export interface HostAgent {
  agentId: string;
  name: string;
  feishuProfile?: string | null;
}

export interface HostStateStore {
  readonly paths: AgentStatePaths;
  readJson<T>(key: "status" | "map" | "replyctx" | "senderProfiles" | "readReceipts", fallback: T): T;
  writeJson(key: "status" | "map" | "replyctx" | "senderProfiles" | "readReceipts", value: unknown): void;
  appendNdjson(key: "conversation", value: unknown): void;
}

export interface StatusLogEntry {
  at: string;
  [key: string]: unknown;
}

export interface ReplyContext {
  chat_id: string | null;
  reply_to: string | null;
  thread_id: string | null;
  in_topic: boolean;
}

export interface SenderProfileRecord {
  description: string | null;
  name: string | null;
  at: number;
}

export interface SenderSignatureResult {
  desc: string | null;
  name: string | null;
  ok: boolean;
  ttl: number;
}

export interface SenderSignatureCacheEntry extends SenderSignatureResult {
  at: number;
}

type Logger = (...parts: unknown[]) => void;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function safeConversationExcerpt(value: unknown, max = 360): string {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  text = text
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[已隐藏凭证]")
    .replace(/\b(token|secret|password|passwd)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

// —— 入站活性（僵尸连接检测）——
// 2026-07-17 实测：daemon 重载后某 agent 的 ws 可以「握手成功 + 心跳正常」但飞书服务端事件路由
// 没绑到这条会话——传输层 keepalive 探不出来，只有真实事件到达能证明链路活着。
// 这里只提供纯判定；host 侧 watchdog 据此做预防性重连（重连无害，飞书会补投窗口内事件）。
export interface InboundLivenessStatus {
  connectedAt?: unknown;
  inboundVerifiedAt?: unknown;
  reconnectingAt?: unknown;
  droughtReconnectAt?: unknown;
  droughtReconnectAbandonedAt?: unknown;
}

/** 距最后一次「连接建立或真实入站事件」的静默毫秒数；未连接返回 null。 */
export function inboundSilenceMs(status: InboundLivenessStatus, now: Date): number | null {
  const connected = Date.parse(String(status.connectedAt || ""));
  if (!Number.isFinite(connected)) return null;
  const inbound = Date.parse(String(status.inboundVerifiedAt || ""));
  const base = Number.isFinite(inbound) ? Math.max(connected, inbound) : connected;
  return Math.max(0, now.getTime() - base);
}

/**
 * 静默超阈值 → 该做预防性重连。两个不抢的例外：
 * - connectedAt 早于 connectedAfterMs（status.json 里上一轮 daemon 的残留断言，本轮还没真正连上）；
 * - SDK 自身正在重连（reconnectingAt 未过期）。
 */
export function shouldPreventiveReconnect(
  status: InboundLivenessStatus,
  now: Date,
  thresholdMs: number,
  connectedAfterMs: number | null = null,
): boolean {
  if (!(thresholdMs > 0)) return false;
  if (connectedAfterMs !== null) {
    const connected = Date.parse(String(status.connectedAt || ""));
    if (!Number.isFinite(connected) || connected < connectedAfterMs) return false;
  }
  const silence = inboundSilenceMs(status, now);
  if (silence === null || silence < thresholdMs) return false;
  const reconnecting = Date.parse(String(status.reconnectingAt || ""));
  if (Number.isFinite(reconnecting) && now.getTime() - reconnecting < thresholdMs) return false;
  // Maintenance reconnecting creates a fresh connectedAt, but that transport fact is not new
  // inbound evidence. Keep the drought cycle closed until a real inbound event arrives later.
  const persistedDroughtReconnect = Math.max(
    Date.parse(String(status.droughtReconnectAt || "")) || Number.NEGATIVE_INFINITY,
    Date.parse(String(status.droughtReconnectAbandonedAt || "")) || Number.NEGATIVE_INFINITY,
  );
  // A daemon restart opens a new maintenance cycle. Only a marker written during
  // the current event-source epoch can suppress another attempt in this run.
  const droughtReconnect = connectedAfterMs === null || persistedDroughtReconnect >= connectedAfterMs
    ? persistedDroughtReconnect
    : Number.NEGATIVE_INFINITY;
  const inbound = Date.parse(String(status.inboundVerifiedAt || ""));
  if (Number.isFinite(droughtReconnect) && (!Number.isFinite(inbound) || droughtReconnect >= inbound)) return false;
  return true;
}

export class HostStateProjection {
  constructor(
    private readonly storeFor: (agent: HostAgent) => HostStateStore,
    private readonly log: Logger = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  stateFiles(agent: HostAgent): AgentStatePaths { return this.storeFor(agent).paths; }

  readStatus(agent: HostAgent): Record<string, unknown> {
    try { return asRecord(this.storeFor(agent).readJson("status", {})); }
    catch { return {}; }
  }

  updateStatus(agent: HostAgent, patch: Record<string, unknown>): void {
    const next = { ...this.readStatus(agent), ...patch };
    try { this.storeFor(agent).writeJson("status", next); }
    catch (error) { this.log(`status 写失败 agent=${agent.name}: ${(error as Error).message}`); }
  }

  appendStatusLog(agent: HostAgent, key: string, entry: StatusLogEntry, cap: number): void {
    const current = this.readStatus(agent);
    const existing = Array.isArray(current[key]) ? current[key] : [];
    const list = [...existing, entry].slice(-cap);
    const latestKey = key === "activityLog" ? "lastActivity" : key === "deliverLog" ? "lastDeliver" : null;
    this.updateStatus(agent, { [key]: list, ...(latestKey ? { [latestKey]: entry } : {}) });
  }

  recordStatusError(agent: HostAgent, text: unknown): void {
    this.appendStatusLog(agent, "recentErrors", { at: this.now().toISOString(), text: String(text).slice(0, 200) }, 20);
  }

  appendConversation(agent: HostAgent, item: Record<string, unknown>): void {
    try {
      this.storeFor(agent).appendNdjson("conversation", { ...item, text: safeConversationExcerpt(item.text) });
    } catch (error) { this.log(`conversation 写失败 agent=${agent.name}: ${(error as Error).message}`); }
  }

  loadMap(agent: HostAgent): Record<string, string> {
    try { return asRecord(this.storeFor(agent).readJson("map", {})) as Record<string, string>; }
    catch { return {}; }
  }

  saveMap(agent: HostAgent, map: Record<string, string>): void {
    try { this.storeFor(agent).writeJson("map", map); }
    catch (error) { this.log("saveMap 失败", (error as Error).message); }
  }

  mapTargets(agent: HostAgent, targets: readonly string[], chatId: string): void {
    const map = this.loadMap(agent);
    for (const target of targets) if (target) map[target] = chatId;
    this.saveMap(agent, map);
  }

  saveReplyContext(
    agent: HostAgent,
    keys: string | readonly string[],
    chatId: string | null | undefined,
    replyTo: string | null | undefined,
    threadId: string | null | undefined,
  ): void {
    const aliases = Array.isArray(keys) ? keys : [keys];
    let map: Record<string, ReplyContext> = {};
    try { map = asRecord(this.storeFor(agent).readJson("replyctx", {})) as Record<string, ReplyContext>; }
    catch { /* first run or corrupt state retains historical fail-open behavior */ }
    const entry: ReplyContext = {
      chat_id: chatId || null,
      reply_to: replyTo || null,
      thread_id: threadId || null,
      in_topic: Boolean(threadId),
    };
    for (const alias of aliases) if (alias) map[alias] = entry;
    if (chatId) map[chatId] = entry;
    try { this.storeFor(agent).writeJson("replyctx", map); }
    catch (error) { this.log("replyctx 写失败", (error as Error).message); }
  }

  loadSenderProfiles(agent: HostAgent): Record<string, SenderProfileRecord> {
    try { return asRecord(this.storeFor(agent).readJson("senderProfiles", {})) as Record<string, SenderProfileRecord>; }
    catch { return {}; }
  }

  saveSenderProfile(agent: HostAgent, senderId: string, profile: SenderProfileRecord): void {
    const all = this.loadSenderProfiles(agent);
    all[senderId] = profile;
    try { this.storeFor(agent).writeJson("senderProfiles", all); }
    catch { /* signature cache persistence is best-effort by design */ }
  }

  recordReadReceipts(agent: HostAgent, reader: unknown, readAt: unknown, ids: unknown): void {
    let data: { receipts?: unknown[] } = { receipts: [] };
    try { data = asRecord(this.storeFor(agent).readJson("readReceipts", data)) as { receipts?: unknown[] }; }
    catch { /* first run */ }
    data.receipts = [...(Array.isArray(data.receipts) ? data.receipts : []), { ids, reader, readAt }].slice(-200);
    this.storeFor(agent).writeJson("readReceipts", data);
  }
}

export interface SenderIdentityOptions {
  state: HostStateProjection;
  fetchChatNames(agent: HostAgent, chatId: string): Promise<Record<string, string> | null>;
  fetchSenderSignature(agent: HostAgent, senderId: string): Promise<SenderSignatureResult>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  signatureFailureTtlMs?: number;
}

type ChatNameCacheValue = { names: Record<string, string>; at: number } | Promise<Record<string, string>>;
type SignatureCacheValue = SenderSignatureCacheEntry | Promise<string | null>;

export class SenderIdentityCache {
  private readonly chatNames = new Map<string, ChatNameCacheValue>();
  private readonly signatures = new Map<string, SignatureCacheValue>();
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly failureTtlMs: number;

  constructor(private readonly options: SenderIdentityOptions) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.failureTtlMs = options.signatureFailureTtlMs ?? 10 * 60 * 1000;
  }

  private chatKey(agent: HostAgent, chatId: string): string { return `${agent.agentId}:${chatId}`; }
  private signatureKey(agent: HostAgent, senderId: string): string { return `${agent.agentId}:${senderId}`; }

  ensureChatNames(agent: HostAgent, chatId: string, waitMs: number): Promise<Record<string, string>> {
    if (!chatId || !agent.feishuProfile) return Promise.resolve({});
    const key = this.chatKey(agent, chatId);
    const hit = this.chatNames.get(key);
    if (hit && !(hit instanceof Promise)) return Promise.resolve(hit.names);
    const pending = hit ?? this.options.fetchChatNames(agent, chatId).then((names) => {
      if (names) this.chatNames.set(key, { names, at: this.now() });
      else this.chatNames.delete(key);
      return names ?? {};
    });
    if (!hit) this.chatNames.set(key, pending);
    if (!waitMs) return Promise.resolve({});
    return Promise.race([pending, this.wait(waitMs).then(() => ({}))]);
  }

  noteUnknownSender(agent: HostAgent, chatId: string, senderId: string): void {
    if (!senderId || !/^(ou_|cli_|app_)/.test(senderId)) return;
    const key = this.chatKey(agent, chatId);
    const hit = this.chatNames.get(key);
    if (!hit || hit instanceof Promise || this.now() - hit.at < 60_000) return;
    this.chatNames.delete(key);
    void this.ensureChatNames(agent, chatId, 0);
  }

  ensureSenderSignature(agent: HostAgent, senderId: string, waitMs: number): Promise<string | null> {
    if (!senderId || !senderId.startsWith("ou_") || !agent.feishuProfile) return Promise.resolve(null);
    const key = this.signatureKey(agent, senderId);
    const hit = this.signatures.get(key);
    if (hit && !(hit instanceof Promise)) {
      const fresh = this.now() - hit.at < (hit.ttl || this.failureTtlMs);
      if (!fresh) {
        this.signatures.delete(key);
        void this.ensureSenderSignature(agent, senderId, 0);
      }
      return Promise.resolve(hit.desc);
    }
    const pending = hit ?? this.options.fetchSenderSignature(agent, senderId).then((result) => {
      const entry: SenderSignatureCacheEntry = { ...result, at: this.now() };
      this.signatures.set(key, entry);
      if (result.ok) this.options.state.saveSenderProfile(agent, senderId, {
        description: result.desc,
        name: result.name,
        at: entry.at,
      });
      return result.desc;
    });
    if (!hit) this.signatures.set(key, pending);
    return waitMs ? Promise.race([pending, this.wait(waitMs).then(() => null)]) : Promise.resolve(null);
  }

  warmSenderProfiles(agent: HostAgent): void {
    for (const [senderId, profile] of Object.entries(this.options.state.loadSenderProfiles(agent))) {
      this.signatures.set(this.signatureKey(agent, senderId), {
        desc: profile.description ?? null,
        name: profile.name || null,
        at: profile.at || 0,
        ok: true,
        ttl: 6 * 60 * 60 * 1000,
      });
    }
  }
}

export interface InboundEnvelopeOptions {
  anchorReply?: boolean;
  names?: Record<string, string>;
  signature?: unknown;
}

export interface ReminderEnvelope {
  kind: "reminder";
  message_id: string;
  /** Runtime wake target; deliveryTarget is the original user-facing destination. */
  target: typeof RUNTIME_REMINDER_TARGET;
  deliveryTarget: string | null;
  deliveryAnchor: string | null;
  seq: number;
  sender_name: "定时提醒";
  sender_type: "system";
  channel_type: "dm";
  channel_name: "system";
  content: string;
  timestamp: string;
  thread_id: null;
  wake: true;
}

export interface RedeliveryEnvelope {
  kind: "redelivery";
  message_id: string;
  target: typeof RUNTIME_REDELIVERY_TARGET;
  seq: number;
  sender_name: "系统";
  sender_type: "system";
  channel_type: "dm";
  channel_name: "system";
  content: string;
  timestamp: string;
  thread_id: null;
}

export interface ReminderForDelivery {
  reminderId: string;
  title: string;
  repeat?: string | null;
  fireAt: string;
  msgRef?: unknown;
  channel?: string | null;
  deliveryTarget?: string | null;
  deliveryAnchor?: string | null;
}

export class HostEnvelopeProjector {
  private readonly sequenceByAgent = new Map<string, number>();

  constructor(
    private readonly state: HostStateProjection,
    private readonly noteUnknownSender: (agent: HostAgent, chatId: string, senderId: string) => void,
    private readonly randomHex: (bytes: number) => string = (bytes) => crypto.randomBytes(bytes).toString("hex"),
    private readonly now: () => Date = () => new Date(),
    private readonly agentCliExecutable = "larkin",
  ) {}

  private agentCommand(suffix: string): string {
    return `${this.agentCliExecutable} ${suffix}`;
  }

  private larkCommand(suffix: string): string {
    return `${this.agentCliExecutable} ${suffix}`;
  }

  private nextSequence(agentId: string): number {
    const next = (this.sequenceByAgent.get(agentId) || 0) + 1;
    this.sequenceByAgent.set(agentId, next);
    return next;
  }

  projectInbound(
    agent: HostAgent & EnvelopeAgentIdentity,
    event: FeishuInboundEvent,
    options: InboundEnvelopeOptions = {},
  ): MessageEnvelope {
    const target = targetFor(event);
    const aliases = targetAliases(event, target);
    this.state.mapTargets(agent, aliases, event.chat_id);
    const messageId = event.message_id || `m_${this.randomHex(6)}`;
    if (options.anchorReply !== false) {
      this.state.saveReplyContext(agent, aliases, event.chat_id, messageId, event.thread_id || null);
    }
    const names = options.names || {};
    if (!names[event.sender_id]) this.noteUnknownSender(agent, event.chat_id, event.sender_id);
    return createMessageEnvelope({
      agent,
      event: { ...event, message_id: messageId },
      seq: this.nextSequence(agent.agentId),
      names,
      signature: options.signature,
    });
  }

  createReminderEnvelope(
    agentId: string,
    reminder: ReminderForDelivery,
    overdueMs: number,
    repeatDescription: string | null,
  ): ReminderEnvelope {
    const seq = this.nextSequence(agentId);
    const anchorMessageId = typeof reminder.deliveryAnchor === "string" && /^om_[A-Za-z0-9_-]+$/.test(reminder.deliveryAnchor)
      ? reminder.deliveryAnchor
      : typeof reminder.msgRef === "string" && /^om_[A-Za-z0-9_-]+$/.test(reminder.msgRef)
        ? reminder.msgRef
        : null;
    const deliveryTarget = typeof reminder.deliveryTarget === "string" && reminder.deliveryTarget ? reminder.deliveryTarget : null;
    const commentAnchorId = deliveryTarget?.startsWith("document-comment:") && typeof reminder.deliveryAnchor === "string"
      && /^doc_comment_[A-Za-z0-9_-]+$/.test(reminder.deliveryAnchor) ? reminder.deliveryAnchor : null;
    const anchorId = anchorMessageId || commentAnchorId;
    const lines = [
      `[定时提醒触发] ${reminder.title}`,
      `提醒ID: #${reminder.reminderId.slice(0, 8)}` + (reminder.repeat && repeatDescription
        ? `　重复: ${repeatDescription}（下次已自动排在 ${reminder.fireAt}）`
        : "　类型: 一次性"),
      overdueMs > 120_000 ? `注意: 原定时间已过 ${Math.round(overdueMs / 60_000)} 分钟（Runtime Host 离线期间错过，现补触发）` : null,
      deliveryTarget ? `原始 deliveryTarget: ${deliveryTarget}` : "本条为 internal/no-delivery reminder，不得向标题中的任何人或第三方发送消息",
      anchorId ? `锚定消息: ${anchorId}` : reminder.msgRef ? `历史锚点 ${String(reminder.msgRef)} 不是可用的 delivery anchor，不能用于回复` : null,
      anchorMessageId
        ? `回复原会话: ${this.larkCommand(`im +messages-reply --message-id ${anchorMessageId} ...`)}`
        : commentAnchorId
          ? `回复原文档评论: ${this.agentCommand(`comment reply --message-id ${commentAnchorId} --text ...`)}`
          : deliveryTarget
          ? `发送到原始 target: ${deliveryTarget}（不得从提醒标题推断收件人）`
          : null,
      `这是你之前用 ${this.agentCommand("reminder schedule")} 设置的提醒，请按标题执行相应动作。管理: ${this.agentCommand("reminder list")} / ${this.agentCommand("reminder snooze")} / ${this.agentCommand("reminder cancel")}`,
    ].filter((line): line is string => Boolean(line));
    const envelope = {
      kind: "reminder" as const,
      message_id: `rem_${reminder.reminderId.slice(0, 16)}_${seq}`,
      seq,
      sender_name: "定时提醒" as const,
      sender_type: "system" as const,
      channel_type: "dm" as const,
      channel_name: "system" as const,
      content: lines.join("\n"),
      timestamp: this.now().toISOString(),
      thread_id: null,
      wake: true as const,
      deliveryTarget,
      deliveryAnchor: anchorId,
    };
    return { ...envelope, target: RUNTIME_REMINDER_TARGET };
  }

  createRedeliveryEnvelope(agentId: string, wakeCount: number): RedeliveryEnvelope {
    const seq = this.nextSequence(agentId);
    const envelope = {
      kind: "redelivery" as const,
      message_id: `redeliver_${this.randomHex(6)}`,
      seq,
      sender_name: "系统" as const,
      sender_type: "system" as const,
      channel_type: "dm" as const,
      channel_name: "system" as const,
      content: `[启动补投] 服务重启期间有 ${wakeCount} 条本应唤醒你的消息未被读取（可能包含用户消息、@提及或定时提醒）。请先用 ${this.agentCommand("inbox check")} 看目标摘要，再用 ${this.agentCommand("inbox poll")} 领取完整消息；仅当 message_id 以 om_ 开头时才用 ${this.larkCommand("im +messages-reply")}，系统 rem_/redeliver_ ID 不可回复；有 chat_id 时可用 ${this.larkCommand("im +messages-send")}，否则先查询确认目标，禁止猜测。`,
      timestamp: this.now().toISOString(),
      thread_id: null,
    };
    return { ...envelope, target: RUNTIME_REDELIVERY_TARGET };
  }
}

export function countWakeEnvelopes(lines: readonly string[]): number {
  return lines.filter((line) => {
    try { return (JSON.parse(line) as { wake?: unknown }).wake === true; }
    catch { return false; }
  }).length;
}

interface StatusSession {
  runtime?: string;
  id?: string | null;
  launchId?: string | null;
  startedAt?: string | null;
  lastSeenAt?: string | null;
  lastTurnAt?: string | null;
  turns?: number;
  model?: string | null;
  reasoningEffort?: string | null;
}

interface StatusCompaction {
  sessionId?: string | null;
  active?: boolean;
  count?: number;
  startedAt?: string | null;
  lastFinishedAt?: string | null;
  lastEventId?: string | null;
}

export interface ProjectedStatus {
  activityLog?: unknown[];
  lastActivity?: unknown;
  session?: StatusSession;
  compaction?: StatusCompaction;
  [key: string]: unknown;
}

export interface ActivityFrameForProjection {
  activity?: string;
  activityKind?: string;
  observedAtMs?: number;
  entries?: Array<{ kind?: string; toolName?: string } | null>;
  isHeartbeat?: boolean;
  detail?: unknown;
  detailKind?: string;
  launchId?: string;
  clientSeq?: number;
  producerFactId?: string;
}

/** Project daemon activity into dashboard state without changing or interpreting Runtime transport frames. */
export function projectActivityStatus(
  current: ProjectedStatus,
  message: ActivityFrameForProjection,
  runtime: string,
  resumeSession: string | null,
  now: Date = new Date(),
): Record<string, unknown> | null {
  if (message.isHeartbeat) return null;
  const activityKind = message.activityKind || message.activity || "unknown";
  const at = Number.isFinite(message.observedAtMs)
    ? new Date(message.observedAtMs as number).toISOString()
    : now.toISOString();
  const entries = Array.isArray(message.entries) ? message.entries : [];
  const tool = [...entries].reverse().find((entry) => entry?.kind === "tool_start" && entry.toolName)?.toolName || null;
  const activityEntry = {
    state: activityKind === "text" ? "working" : (message.activity || activityKind),
    activityKind,
    detail: activityKind === "thinking" ? null : (safeConversationExcerpt(message.detail, 180) || null),
    detailKind: message.detailKind || "other",
    tool,
    at,
    launchId: message.launchId || null,
    clientSeq: Number.isFinite(message.clientSeq) ? message.clientSeq : null,
  };
  const activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
  const previousActivity = current.lastActivity && typeof current.lastActivity === "object" && !Array.isArray(current.lastActivity)
    ? current.lastActivity as Record<string, unknown>
    : null;
  const repeatedThinking = activityKind === "thinking"
    && (previousActivity?.activityKind === "thinking" || previousActivity?.state === "thinking");
  // Runtime adapters emit text/thinking once per streamed delta. Text is only a freshness signal;
  // thinking is durable on transition, then coalesced until the next state. Persisting every frame
  // otherwise evicts meaningful turn/tool/idle history from the Dashboard within milliseconds.
  const appendToHistory = activityKind !== "text" && !repeatedThinking;
  const patch: Record<string, unknown> = {
    activityLog: appendToHistory ? [...activityLog, activityEntry].slice(-80) : activityLog,
    lastActivity: activityEntry,
  };
  const entryKinds = new Set(entries.map((entry) => entry?.kind).filter(Boolean));
  const compactStarted = activityEntry.detailKind === "compacting_context" || entryKinds.has("compaction_started");
  const compactFinished = activityEntry.detailKind === "compaction_finished" || entryKinds.has("compaction_finished");
  if (compactStarted || compactFinished) {
    const previous = current.compaction || {};
    const atMs = Date.parse(at);
    const nearPreviousCompact = [previous.startedAt, previous.lastFinishedAt]
      .map((value) => typeof value === "string" ? Date.parse(value) : Number.NaN)
      .some((value) => Number.isFinite(value) && Number.isFinite(atMs) && Math.abs(atMs - value) <= 5000);
    const sameEvent = Boolean(message.producerFactId) && previous.lastEventId === message.producerFactId;
    const duplicateStart = Boolean(previous.active) || sameEvent || nearPreviousCompact;
    const shouldCountStart = compactStarted && !duplicateStart;
    patch.compaction = compactFinished ? {
      ...previous,
      sessionId: current.session?.id || previous.sessionId || null,
      active: false,
      count: Number(previous.count || 0) + (shouldCountStart ? 1 : 0),
      startedAt: shouldCountStart ? at : (previous.startedAt || at),
      lastFinishedAt: at,
      lastEventId: message.producerFactId || null,
    } : {
      sessionId: current.session?.id || null,
      active: true,
      count: Number(previous.count || 0) + (duplicateStart ? 0 : 1),
      startedAt: duplicateStart ? (previous.startedAt || at) : at,
      lastFinishedAt: previous.lastFinishedAt || null,
      lastEventId: message.producerFactId || null,
    };
  }
  if (activityEntry.detailKind === "message_received" || activityEntry.detailKind === "turn_started") {
    patch.session = {
      ...(current.session || {}),
      runtime,
      id: current.session?.id || resumeSession || null,
      startedAt: current.session?.startedAt || at,
      lastTurnAt: at,
      turns: Number(current.session?.turns || 0) + 1,
    };
  }
  return patch;
}

export function projectSessionStatus(
  current: ProjectedStatus,
  runtime: string,
  sessionId: string | null,
  launchId: string | null,
  now: Date = new Date(),
  effective: { model?: string; reasoningEffort?: string } = {},
): Record<string, unknown> {
  const sameSession = current.session?.id === sessionId;
  const at = now.toISOString();
  return {
    session: {
      runtime,
      id: sessionId,
      launchId: launchId || current.session?.launchId || null,
      startedAt: sameSession ? (current.session?.startedAt || at) : at,
      lastSeenAt: at,
      lastTurnAt: sameSession ? (current.session?.lastTurnAt || null) : null,
      turns: sameSession ? Number(current.session?.turns || 0) : 0,
      ...((effective.model || (sameSession ? current.session?.model : null))
        ? { model: effective.model || current.session?.model }
        : {}),
      ...((effective.reasoningEffort || (sameSession ? current.session?.reasoningEffort : null))
        ? { reasoningEffort: effective.reasoningEffort || current.session?.reasoningEffort }
        : {}),
    },
    ...(sameSession ? {} : {
      compaction: { sessionId, active: false, count: 0, startedAt: null, lastFinishedAt: null, lastEventId: null },
    }),
  };
}
