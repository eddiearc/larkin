import path from "node:path";
import { mutate, newId, nowIso, parseRepeat, type ReminderRecord } from "./reminder-store.js";

export const DEFAULT_MISSED_OUTBOUND_TITLE = "Read scoped history from this reminder envelope's persisted deliveryTarget (chat: +chat-messages-list; thread: +threads-messages-list). Judge unanswered asks, undelivered follow-ups, and stalled work. On a hit, post a short status in the same conversation using that persisted deliveryTarget/anchor; otherwise stay silent. Never infer recipients from the title.";
export const DEFAULT_MISSED_OUTBOUND_REPEAT = "every:15m";

const CHAT_TARGET = /^chat:(oc_[A-Za-z0-9]+)$/;
const THREAD_TARGET = /^thread:(oc_[A-Za-z0-9]+):(omt_[A-Za-z0-9]+)$/;
const OM_ID = /^om_[A-Za-z0-9]+$/;

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

export function isDefaultMissedOutboundReminder(reminder: {
  title?: string;
  repeat?: unknown;
  deliveryMode?: unknown;
  status?: string;
} | null | undefined): boolean {
  return reminder?.title === DEFAULT_MISSED_OUTBOUND_TITLE
    && reminder.repeat === DEFAULT_MISSED_OUTBOUND_REPEAT
    && reminder.deliveryMode === "user"
    && reminder.status === "scheduled";
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
      && reminder.repeat === DEFAULT_MISSED_OUTBOUND_REPEAT
      && reminder.deliveryMode === "user"
      && reminder.deliveryTarget === parsed.deliveryTarget) as ReminderRecord | undefined;
    if (existing && existing.status === "canceled") {
      return { created: false, reminderId: existing.reminderId, rebuilt: false };
    }
    if (existing && existing.status === "scheduled") {
      const sameAnchor = (existing.deliveryAnchor || null) === wantedAnchor;
      if (sameAnchor) return { created: false, reminderId: existing.reminderId, rebuilt: false };
      existing.deliveryAnchor = wantedAnchor;
      return { created: false, reminderId: existing.reminderId, rebuilt: false };
    }
    if (existing && existing.status === "fired") existing.status = "canceled";
    const reminderId = newId();
    store.reminders.push({
      reminderId,
      ownerAgentId: input.agentId,
      title: DEFAULT_MISSED_OUTBOUND_TITLE,
      fireAt: nowIso(now + 15 * 60_000),
      firedAt: null,
      createdAt: nowIso(now),
      status: "scheduled",
      version: 1,
      events: [],
      deliveryTarget: parsed.deliveryTarget,
      deliveryAnchor: wantedAnchor,
      deliveryMode: "user",
      repeat: DEFAULT_MISSED_OUTBOUND_REPEAT,
    });
    return { created: true, reminderId, rebuilt: Boolean(existing) };
  });
}

export function persistInboundScanTarget(stateDir: string, event: {
  chat_id?: string;
  thread_id?: string | null;
  message_id?: string;
  _sender_is_bot?: boolean;
}, agentId: string, storeFile = path.join(stateDir, "reminders.json")): ParsedScanTarget {
  if (event._sender_is_bot) throw new Error("scan reminder 只接受 human inbound");
  const chatId = String(event.chat_id || "");
  if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) {
    throw new Error("user-facing reminder 必须显式指定 delivery target，不得从标题推断收件人");
  }
  const threadId = event.thread_id ? String(event.thread_id) : "";
  const parsed = threadId
    ? parseScanDeliveryTarget(`thread:${chatId}:${threadId}`, event.message_id)
    : parseScanDeliveryTarget(`chat:${chatId}`, event.message_id || null);
  ensureDefaultMissedOutboundScanReminder({
    storeFile,
    agentId,
    deliveryTarget: parsed.deliveryTarget,
    deliveryAnchor: parsed.deliveryAnchor,
  });
  return parsed;
}
