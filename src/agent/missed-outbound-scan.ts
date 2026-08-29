import { mutate, newId, nowIso, parseRepeat, type ReminderRecord } from "./reminder-store.js";

export const DEFAULT_MISSED_OUTBOUND_TITLE = "Default missed-outbound scan";
export const DEFAULT_MISSED_OUTBOUND_REPEAT = "every:15m";
export const SCAN_STATUS_PREFIX = "巡检：";
export const PROMISE_STALL_MIN_AGE_MS = 15 * 60_000;

const CHAT_TARGET = /^chat:(oc_[A-Za-z0-9]+)$/;
const THREAD_TARGET = /^thread:(oc_[A-Za-z0-9]+):(omt_[A-Za-z0-9]+)$/;
const OM_ID = /^om_[A-Za-z0-9]+$/;
const ASK = /[?？]|Review |Fix |Please |^(请|帮|为什么|怎么|能否)/;
const FOLLOW_UP = /下一步我|我会去|稍后回报|稍后我/;
const STALL = /CI 还在跑|仍在跑|后台.*跑|等 CI/;
const DONE = /已推|已完成|全绿|已 merge|已发布/;
const REPLY = /收到|已看|正在处理|^好的/;

export interface ParsedScanTarget {
  deliveryTarget: string;
  scope: "chat" | "thread";
  chatId: string;
  threadId: string | null;
  deliveryAnchor: string | null;
}

export function parseOmMessageId(value: string | null | undefined, label = "message-id"): string {
  const id = String(value || "").trim();
  if (!OM_ID.test(id)) throw new Error(`${label} 必须是严格 om_ 语法`);
  return id;
}

export function parseScanDeliveryTarget(target: string | null | undefined, anchor?: string | null): ParsedScanTarget {
  const deliveryTarget = String(target || "").trim();
  if (!deliveryTarget) {
    throw new Error("user-facing reminder 必须显式指定 delivery target，不得从标题推断收件人");
  }
  const chat = deliveryTarget.match(CHAT_TARGET);
  if (chat) {
    return {
      deliveryTarget,
      scope: "chat",
      chatId: chat[1],
      threadId: null,
      deliveryAnchor: anchor ? parseOmMessageId(anchor, "delivery anchor") : null,
    };
  }
  const thread = deliveryTarget.match(THREAD_TARGET);
  if (thread) {
    return {
      deliveryTarget,
      scope: "thread",
      chatId: thread[1],
      threadId: thread[2],
      deliveryAnchor: parseOmMessageId(anchor, "delivery anchor"),
    };
  }
  throw new Error("delivery target 必须是 chat:oc_… 或 thread:oc_…:omt_…，禁止推断 DM");
}

export const requireScanDeliveryTarget = (target: string | null | undefined, anchor?: string | null): string =>
  parseScanDeliveryTarget(target, anchor).deliveryTarget;

export interface ScanMessage {
  message_id?: string;
  sender_type?: string;
  sender?: { sender_type?: string; id?: string };
  create_time?: string;
  content?: string;
  mentions?: Array<{ id?: string }>;
}

export type MissedOutboundKind = "unanswered-human" | "unfulfilled-follow-up" | "stalled-work";

export interface MissedOutboundHit {
  kind: MissedOutboundKind;
  messageId: string;
  summary: string;
  occurrenceId: string;
}

function senderType(message: ScanMessage): string {
  return String(message.sender?.sender_type || message.sender_type || "");
}

function senderId(message: ScanMessage): string {
  return String(message.sender?.id || "");
}

function isThisBot(message: ScanMessage, botIds: ReadonlySet<string>): boolean {
  return senderType(message) === "app" && botIds.has(senderId(message));
}

function isHuman(message: ScanMessage): boolean {
  return senderType(message) === "user";
}

function isScanStatus(message: ScanMessage): boolean {
  return String(message.content || "").startsWith(SCAN_STATUS_PREFIX);
}

function isAsk(message: ScanMessage, botIds: ReadonlySet<string>): boolean {
  if (!isHuman(message) || !message.message_id) return false;
  const text = String(message.content || "");
  const mentioned = (message.mentions || []).some((mention) => botIds.has(String(mention.id || "")));
  return mentioned || ASK.test(text);
}

function messageTimeMs(message: ScanMessage): number {
  const raw = Number(message.create_time);
  return Number.isFinite(raw) ? raw : 0;
}

function isAged(message: ScanMessage, nowMs: number): boolean {
  return nowMs - messageTimeMs(message) >= PROMISE_STALL_MIN_AGE_MS;
}

export function unansweredHumanAfterBot(
  messages: ScanMessage[],
  botIds: ReadonlySet<string>,
  nowMs = Date.now(),
): string | null {
  const hit = classifyMissedOutbound(messages, botIds, nowMs);
  return hit?.kind === "unanswered-human" ? hit.messageId : null;
}

export function classifyMissedOutbound(
  messages: ScanMessage[],
  botIds: ReadonlySet<string>,
  nowMs = Date.now(),
): MissedOutboundHit | null {
  if (botIds.size === 0) return null;
  const ordered = [...messages].sort((a, b) => messageTimeMs(a) - messageTimeMs(b) || String(a.create_time || "").localeCompare(String(b.create_time || "")));
  let unanswered: ScanMessage | null = null;
  const openFollowUps: ScanMessage[] = [];
  const openStalls: ScanMessage[] = [];
  for (const message of ordered) {
    if (isAsk(message, botIds)) unanswered = message;
    if (!isThisBot(message, botIds)) continue;
    if (isScanStatus(message)) continue;
    const text = String(message.content || "");
    if (DONE.test(text) || REPLY.test(text)) unanswered = null;
    if (DONE.test(text)) {
      openFollowUps.length = 0;
      openStalls.length = 0;
      continue;
    }
    if (FOLLOW_UP.test(text) && message.message_id) openFollowUps.push(message);
    if (STALL.test(text) && message.message_id) {
      openStalls.length = 0;
      openStalls.push(message);
    }
  }
  const hitFrom = (kind: MissedOutboundKind, message: ScanMessage, summary: string): MissedOutboundHit => ({
    kind,
    messageId: String(message.message_id),
    summary,
    occurrenceId: `${kind}:${message.message_id}`,
  });
  if (unanswered?.message_id) return hitFrom("unanswered-human", unanswered, "有真人提问尚未回复");
  const follow = openFollowUps.find((message) => isAged(message, nowMs));
  if (follow) return hitFrom("unfulfilled-follow-up", follow, "有承诺的下一步尚未兑现");
  const stall = openStalls.find((message) => isAged(message, nowMs));
  if (stall) return hitFrom("stalled-work", stall, "工作停滞且无新的状态更新");
  return null;
}

export function isDefaultMissedOutboundReminder(reminder: {
  title?: string;
  repeat?: unknown;
  deliveryMode?: unknown;
} | null | undefined): boolean {
  return reminder?.title === DEFAULT_MISSED_OUTBOUND_TITLE
    && reminder.repeat === DEFAULT_MISSED_OUTBOUND_REPEAT
    && reminder.deliveryMode === "user";
}

export function ensureDefaultMissedOutboundScanReminder(input: {
  storeFile: string;
  agentId: string;
  deliveryTarget?: string | null;
  deliveryAnchor?: string | null;
  nowMs?: number;
}): { created: boolean; reminderId: string; rebuilt: boolean } {
  const parsed = parseScanDeliveryTarget(input.deliveryTarget, input.deliveryAnchor);
  const recurrence = parseRepeat(DEFAULT_MISSED_OUTBOUND_REPEAT);
  if ("error" in recurrence) throw new Error(recurrence.error);
  const now = input.nowMs ?? Date.now();
  const wantedAnchor = parsed.deliveryAnchor;
  return mutate(input.storeFile, (store) => {
    const existing = store.reminders.find((reminder) => reminder.ownerAgentId === input.agentId
      && isDefaultMissedOutboundReminder(reminder)
      && reminder.status !== "canceled") as ReminderRecord | undefined;
    if (existing) {
      const sameTarget = existing.deliveryTarget === parsed.deliveryTarget
        && (existing.deliveryAnchor || null) === wantedAnchor;
      if (sameTarget) return { created: false, reminderId: existing.reminderId, rebuilt: false };
      existing.status = "canceled";
    }
    const reminderId = newId();
    store.reminders.push({
      reminderId,
      ownerAgentId: input.agentId,
      title: DEFAULT_MISSED_OUTBOUND_TITLE,
      fireAt: nowIso(now + 15 * 60_000),
      firedAt: null,
      createdAt: nowIso(now),
      status: "scheduled",
      deliveryTarget: parsed.deliveryTarget,
      deliveryAnchor: wantedAnchor,
      deliveryMode: "user",
      repeat: DEFAULT_MISSED_OUTBOUND_REPEAT,
    });
    return { created: true, reminderId, rebuilt: Boolean(existing) };
  });
}

export const scopedHistoryKind = (deliveryTarget: string): "chat" | "thread" =>
  parseScanDeliveryTarget(deliveryTarget).scope;

export function requireCommittedImResult(payload: unknown): { messageId: string } {
  if (!payload || typeof payload !== "object") throw new Error("IM 结果缺失，未提交");
  const record = payload as { ok?: unknown; data?: { message_id?: unknown } };
  if (record.ok === false) throw new Error("IM 未提交");
  return { messageId: parseOmMessageId(record.data?.message_id as string | undefined, "committed message_id") };
}

export async function executeMissedOutboundScan(input: {
  deliveryTarget?: string | null;
  deliveryAnchor?: string | null;
  botIds: ReadonlySet<string>;
  nowMs?: number;
  postedOccurrenceIds?: ReadonlySet<string>;
  listChat(chatId: string): Promise<ScanMessage[]>;
  listThread(threadId: string): Promise<ScanMessage[]>;
  reply(post: { deliveryTarget: string; messageId: string | null; text: string; scope: "chat" | "thread" }): Promise<unknown>;
}): Promise<{ posted: boolean; hit: MissedOutboundHit | null; scope: "chat" | "thread"; committedMessageId?: string }> {
  const parsed = parseScanDeliveryTarget(input.deliveryTarget, input.deliveryAnchor);
  const messages = parsed.scope === "thread"
    ? await input.listThread(parsed.threadId || "")
    : await input.listChat(parsed.chatId);
  const hit = classifyMissedOutbound(messages, input.botIds, input.nowMs ?? Date.now());
  if (!hit) return { posted: false, hit: null, scope: parsed.scope };
  if (input.postedOccurrenceIds?.has(hit.occurrenceId)) {
    return { posted: false, hit, scope: parsed.scope };
  }
  const payload = await input.reply({
    deliveryTarget: parsed.deliveryTarget,
    messageId: hit.messageId,
    text: `${SCAN_STATUS_PREFIX}${hit.summary}。`,
    scope: parsed.scope,
  });
  const committed = requireCommittedImResult(payload);
  return { posted: true, hit, scope: parsed.scope, committedMessageId: committed.messageId };
}
