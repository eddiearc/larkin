import * as ReminderStore from "./reminder-store.js";

export interface ReminderAuditState {
  paths: { reminders: string };
  resolveCurrentReminder(): { reminderId: string; deliveryTarget: string; deliveryAnchor: string } | null;
  resolveCurrentReminders?(): Array<{ reminderId: string; deliveryTarget: string; deliveryAnchor: string }>;
  clearCurrentReminder(reminderId: string, occurrenceId?: string): void;
}

export interface ReminderDeliveryAuditInput {
  stateStore: ReminderAuditState;
  agentId: string;
  target: string;
  succeeded: boolean;
  messageId?: string;
  reason?: string;
  reminderId?: string;
  /** Exact Runtime wake occurrence; recurring firings share reminderId. */
  deliveryAnchor?: string;
  /** Final turn-boundary reconciliation must not append repeated failures. */
  finalize?: boolean;
  resolveChatId?: (target: string) => string;
  dryRun?: boolean;
}

/** Record only committed, non-dry-run outbound attempts for the consumed reminder. */
export function auditReminderDelivery(input: ReminderDeliveryAuditInput): void {
  if (input.dryRun) return;
  const current = (input.stateStore.resolveCurrentReminders?.() ?? [input.stateStore.resolveCurrentReminder()]).filter(
    (candidate): candidate is { reminderId: string; deliveryTarget: string; deliveryAnchor: string } => Boolean(candidate),
  ).find((candidate) => {
    if (input.reminderId && candidate.reminderId !== input.reminderId) return false;
    if (input.deliveryAnchor && candidate.deliveryAnchor !== input.deliveryAnchor) return false;
    const currentChatId = candidate.deliveryTarget.match(/^chat:(oc_[A-Za-z0-9_-]+)$/)?.[1];
    const outboundChatId = currentChatId && input.resolveChatId ? input.resolveChatId(input.target) : null;
    return candidate.deliveryTarget === input.target || outboundChatId === currentChatId;
  });
  if (!current) return;
  ReminderStore.mutate(input.stateStore.paths.reminders, (store) => {
    const reminder = store.reminders.find((candidate) => candidate.reminderId === current.reminderId);
    const occurrenceEvents = input.deliveryAnchor
      ? reminder?.events?.filter((event) => event.metadata?.occurrenceId === input.deliveryAnchor)
      : undefined;
    const hasOccurrenceMetadata = reminder?.events?.some((event) => typeof event.metadata?.occurrenceId === "string");
    const last = input.deliveryAnchor
      ? (occurrenceEvents?.at(-1) ?? (hasOccurrenceMetadata ? undefined : reminder?.events?.at(-1)))
      : reminder?.events?.at(-1);
    if (!reminder || !last || !["delivery_pending", "delivery_failed"].includes(last.eventType)) return;
    if (input.finalize && !input.succeeded && last.eventType === "delivery_failed") return;
    if (!input.succeeded && last.eventType === "delivery_failed") return;
    ReminderStore.appendEvent(reminder, input.succeeded ? "delivery_succeeded" : "delivery_failed", "agent", input.agentId,
      reminder.status === "scheduled" ? reminder.fireAt : null, Date.now(), {
        deliveryTarget: input.target,
        occurrenceId: current.deliveryAnchor,
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      });
  });
  if (input.succeeded) input.stateStore.clearCurrentReminder(current.reminderId, current.deliveryAnchor);
}
