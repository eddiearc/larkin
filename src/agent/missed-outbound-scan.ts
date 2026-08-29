import { mutate, newId, nowIso, parseRepeat, type ReminderRecord } from "./reminder-store.js";

export const DEFAULT_MISSED_OUTBOUND_TITLE = "Default missed-outbound scan";
export const DEFAULT_MISSED_OUTBOUND_REPEAT = "every:15m";

const CHAT_TARGET = /^chat:(oc_[A-Za-z0-9]+)$/;
const THREAD_TARGET = /^thread:(oc_[A-Za-z0-9]+):(omt_[A-Za-z0-9]+)$/;
const ASK = /[?？]|^(请|帮|为什么|怎么|能否|可以帮)/;
const FOLLOW_UP = /下一步|我会|稍后|等你|待你确认/;
const STALL = /CI 还在跑|仍在跑|后台.*跑|等 CI/;
const DONE = /已推|已完成|全绿|已 merge|已发布/;

export interface ParsedScanTarget {
  deliveryTarget: string;
  scope: "chat" | "thread";
  chatId: string;
  threadId: string | null;
  deliveryAnchor: string | null;
}

export function parseScanDeliveryTarget(target: string | null | undefined, anchor?: string | null): ParsedScanTarget {
  const deliveryTarget = String(target || "").trim();
  if (!deliveryTarget) {
    throw new Error("user-facing reminder 必须显式指定 delivery target，不得从标题推断收件人");
  }
  const chat = deliveryTarget.match(CHAT_TARGET);
  if (chat) {
    return { deliveryTarget, scope: "chat", chatId: chat[1], threadId: null, deliveryAnchor: String(anchor || "").startsWith("om_") ? String(anchor) : null };
  }
  const thread = deliveryTarget.match(THREAD_TARGET);
  if (thread) {
    const deliveryAnchor = String(anchor || "");
    if (!deliveryAnchor.startsWith("om_")) {
      throw new Error(`${deliveryTarget} 必须同时提供可验证的 message-id anchor`);
    }
    return { deliveryTarget, scope: "thread", chatId: thread[1], threadId: thread[2], deliveryAnchor };
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

function isAsk(message: ScanMessage, botIds: ReadonlySet<string>): boolean {
  if (!isHuman(message) || !message.message_id) return false;
  const text = String(message.content || "");
  const mentioned = (message.mentions || []).some((mention) => botIds.has(String(mention.id || "")));
  return mentioned || ASK.test(text);
}

export function unansweredHumanAfterBot(messages: ScanMessage[], botIds: ReadonlySet<string>): string | null {
  const hit = classifyMissedOutbound(messages, botIds);
  return hit?.kind === "unanswered-human" ? hit.messageId : null;
}

export function classifyMissedOutbound(messages: ScanMessage[], botIds: ReadonlySet<string>): MissedOutboundHit | null {
  if (botIds.size === 0) return null;
  const ordered = [...messages].sort((a, b) => String(a.create_time || "").localeCompare(String(b.create_time || "")));
  let unanswered: string | null = null;
  const openFollowUps: Array<{ messageId: string; time: string }> = [];
  const openStalls: Array<{ messageId: string; time: string }> = [];
  for (const message of ordered) {
    const time = String(message.create_time || "");
    if (isAsk(message, botIds)) unanswered = message.message_id || unanswered;
    if (isThisBot(message, botIds)) {
      unanswered = null;
      const text = String(message.content || "");
      if (DONE.test(text)) {
        openFollowUps.length = 0;
        openStalls.length = 0;
      } else {
        if (FOLLOW_UP.test(text) && message.message_id) openFollowUps.push({ messageId: message.message_id, time });
        if (STALL.test(text) && message.message_id) openStalls.push({ messageId: message.message_id, time });
      }
    }
  }
  if (unanswered) return { kind: "unanswered-human", messageId: unanswered, summary: "有真人提问尚未回复" };
  if (openFollowUps[0]) return { kind: "unfulfilled-follow-up", messageId: openFollowUps[0].messageId, summary: "有承诺的下一步尚未兑现" };
  if (openStalls[0]) return { kind: "stalled-work", messageId: openStalls[0].messageId, summary: "工作停滞且无新的状态更新" };
  return null;
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
      && reminder.title === DEFAULT_MISSED_OUTBOUND_TITLE
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

export async function executeMissedOutboundScan(input: {
  deliveryTarget?: string | null;
  deliveryAnchor?: string | null;
  botIds: ReadonlySet<string>;
  listChat(chatId: string): Promise<ScanMessage[]>;
  listThread(threadId: string): Promise<ScanMessage[]>;
  reply(post: { deliveryTarget: string; messageId: string | null; text: string; scope: "chat" | "thread" }): Promise<void>;
}): Promise<{ posted: boolean; hit: MissedOutboundHit | null; scope: "chat" | "thread" }> {
  const parsed = parseScanDeliveryTarget(input.deliveryTarget, input.deliveryAnchor);
  const messages = parsed.scope === "thread"
    ? await input.listThread(parsed.threadId || "")
    : await input.listChat(parsed.chatId);
  const hit = classifyMissedOutbound(messages, input.botIds);
  if (!hit) return { posted: false, hit: null, scope: parsed.scope };
  await input.reply({
    deliveryTarget: parsed.deliveryTarget,
    messageId: hit.messageId,
    text: `巡检：${hit.summary}。`,
    scope: parsed.scope,
  });
  return { posted: true, hit, scope: parsed.scope };
}

export function isDefaultMissedOutboundReminder(reminder: { title?: string } | null | undefined): boolean {
  return reminder?.title === DEFAULT_MISSED_OUTBOUND_TITLE;
}
