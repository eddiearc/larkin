import { mutate, newId, nowIso, parseRepeat, type ReminderRecord } from "./reminder-store.js";

export const DEFAULT_MISSED_OUTBOUND_TITLE = "Default missed-outbound scan";
export const DEFAULT_MISSED_OUTBOUND_REPEAT = "every:15m";

export function requireScanDeliveryTarget(target: string | null | undefined, anchor?: string | null): string {
  const deliveryTarget = String(target || "").trim();
  if (!deliveryTarget) {
    throw new Error("user-facing reminder 必须显式指定 delivery target，不得从标题推断收件人");
  }
  if ((deliveryTarget.startsWith("thread:") || deliveryTarget.startsWith("document-comment:"))
    && !String(anchor || "").startsWith("om_")) {
    throw new Error(`${deliveryTarget} 必须同时提供可验证的 message-id anchor`);
  }
  return deliveryTarget;
}

export interface ScanMessage {
  message_id?: string;
  sender_type?: string;
  sender?: { sender_type?: string; id?: string };
  create_time?: string;
  content?: string;
}

export type MissedOutboundKind = "unanswered-human" | "unfulfilled-follow-up" | "stalled-work";

export interface MissedOutboundHit {
  kind: MissedOutboundKind;
  messageId: string;
  summary: string;
}

const FOLLOW_UP = /下一步|我会|稍后|等你|待你确认/;
const STALL = /CI 还在跑|仍在跑|后台.*跑|等 CI/;
const DONE = /已推|已完成|全绿|已 merge|已发布/;

function isBot(message: ScanMessage, botIds: ReadonlySet<string>): boolean {
  const type = message.sender?.sender_type || message.sender_type;
  const id = String(message.sender?.id || "");
  return type === "app" || botIds.has(id);
}

function isHuman(message: ScanMessage): boolean {
  return (message.sender?.sender_type || message.sender_type) === "user";
}

export function classifyMissedOutbound(messages: ScanMessage[], botIds: ReadonlySet<string>): MissedOutboundHit | null {
  const unanswered = unansweredHumanAfterBot(messages, botIds);
  if (unanswered) {
    return { kind: "unanswered-human", messageId: unanswered, summary: "有真人消息尚未回复" };
  }
  const ordered = [...messages].sort((a, b) => String(a.create_time || "").localeCompare(String(b.create_time || "")));
  const lastBot = [...ordered].reverse().find((message) => isBot(message, botIds));
  if (!lastBot?.message_id) return null;
  const text = String(lastBot.content || "");
  const later = ordered.filter((message) => String(message.create_time || "") > String(lastBot.create_time || ""));
  const laterDone = later.some((message) => isBot(message, botIds) && DONE.test(String(message.content || "")));
  if (laterDone) return null;
  if (FOLLOW_UP.test(text)) {
    return { kind: "unfulfilled-follow-up", messageId: lastBot.message_id, summary: "有承诺的下一步尚未兑现" };
  }
  if (STALL.test(text)) {
    return { kind: "stalled-work", messageId: lastBot.message_id, summary: "工作停滞且无新的状态更新" };
  }
  return null;
}

export function unansweredHumanAfterBot(messages: ScanMessage[], botIds: ReadonlySet<string>): string | null {
  const ordered = [...messages].sort((a, b) => String(a.create_time || "").localeCompare(String(b.create_time || "")));
  let lastHuman: string | null = null;
  for (const message of ordered) {
    const type = message.sender?.sender_type || message.sender_type;
    const id = String(message.sender?.id || "");
    const isBot = type === "app" || botIds.has(id);
    const isHuman = type === "user";
    if (isHuman && message.message_id) lastHuman = message.message_id;
    if (isBot) lastHuman = null;
  }
  return lastHuman;
}

export function ensureDefaultMissedOutboundScanReminder(input: {
  storeFile: string;
  agentId: string;
  deliveryTarget?: string | null;
  deliveryAnchor?: string | null;
  nowMs?: number;
}): { created: boolean; reminderId: string } {
  const deliveryTarget = requireScanDeliveryTarget(input.deliveryTarget, input.deliveryAnchor);
  const recurrence = parseRepeat(DEFAULT_MISSED_OUTBOUND_REPEAT);
  if ("error" in recurrence) throw new Error(recurrence.error);
  const now = input.nowMs ?? Date.now();
  return mutate(input.storeFile, (store) => {
    const existing = store.reminders.find((reminder) => reminder.ownerAgentId === input.agentId
      && reminder.title === DEFAULT_MISSED_OUTBOUND_TITLE
      && reminder.status !== "canceled") as ReminderRecord | undefined;
    if (existing) return { created: false, reminderId: existing.reminderId };
    const reminderId = newId();
    store.reminders.push({
      reminderId,
      ownerAgentId: input.agentId,
      title: DEFAULT_MISSED_OUTBOUND_TITLE,
      fireAt: nowIso(now + 15 * 60_000),
      firedAt: null,
      createdAt: nowIso(now),
      status: "scheduled",
      deliveryTarget,
      deliveryAnchor: input.deliveryAnchor || null,
      deliveryMode: "user",
      repeat: DEFAULT_MISSED_OUTBOUND_REPEAT,
    });
    return { created: true, reminderId };
  });
}

export function scopedHistoryKind(deliveryTarget: string): "chat" | "thread" {
  if (deliveryTarget.startsWith("thread:")) return "thread";
  if (deliveryTarget.startsWith("chat:")) return "chat";
  throw new Error("delivery target 必须是 chat: 或 thread:，禁止推断 DM");
}

export async function executeMissedOutboundScan(input: {
  deliveryTarget?: string | null;
  deliveryAnchor?: string | null;
  botIds: ReadonlySet<string>;
  listChat(chatId: string): Promise<ScanMessage[]>;
  listThread(threadId: string): Promise<ScanMessage[]>;
  reply(post: { deliveryTarget: string; messageId: string | null; text: string }): Promise<void>;
}): Promise<{ posted: boolean; hit: MissedOutboundHit | null; scope: "chat" | "thread" }> {
  const deliveryTarget = requireScanDeliveryTarget(input.deliveryTarget, input.deliveryAnchor);
  const scope = scopedHistoryKind(deliveryTarget);
  const messages = scope === "thread"
    ? await input.listThread(deliveryTarget.split(":")[2] || "")
    : await input.listChat(deliveryTarget.slice("chat:".length));
  const hit = classifyMissedOutbound(messages, input.botIds);
  if (!hit) return { posted: false, hit: null, scope };
  await input.reply({
    deliveryTarget,
    messageId: hit.messageId,
    text: `巡检：${hit.summary}。`,
  });
  return { posted: true, hit, scope };
}
