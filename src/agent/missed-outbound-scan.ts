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
