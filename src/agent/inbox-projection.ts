export interface InboxEnvelope {
  envelope_version?: unknown;
  message_id?: unknown;
  seq?: unknown;
  target?: unknown;
  target_seq?: unknown;
  kind?: unknown;
  chat_id?: unknown;
  thread_id?: unknown;
  channel_type?: unknown;
  channel_name?: unknown;
  parent_channel_type?: unknown;
  parent_channel_name?: unknown;
  [key: string]: unknown;
}

export const RUNTIME_REMINDER_TARGET = "runtime:reminder" as const;
export const RUNTIME_REDELIVERY_TARGET = "runtime:redelivery" as const;

const CHAT_TARGET_PREFIX = "chat:";
const THREAD_TARGET_PREFIX = "thread:";
const DOCUMENT_COMMENT_TARGET_PREFIX = "document-comment:";
const REMINDER_MESSAGE_PREFIX = "rem_";
const REDELIVERY_MESSAGE_PREFIX = "redeliver_";

function hasNonemptySuffix(value: string, prefix: string): boolean {
  return value.startsWith(prefix) && value.length > prefix.length;
}

function internalTargetOfInboxEnvelope(envelope: InboxEnvelope): string | null {
  const messageId = typeof envelope.message_id === "string" ? envelope.message_id : "";
  const reminderKind = envelope.kind === "reminder";
  const redeliveryKind = envelope.kind === "redelivery";
  const reminderMarker = messageId.startsWith(REMINDER_MESSAGE_PREFIX);
  const redeliveryMarker = messageId.startsWith(REDELIVERY_MESSAGE_PREFIX);
  const reminderId = hasNonemptySuffix(messageId, REMINDER_MESSAGE_PREFIX);
  const redeliveryId = hasNonemptySuffix(messageId, REDELIVERY_MESSAGE_PREFIX);
  const hasInternalMarker = reminderKind || redeliveryKind || reminderMarker || redeliveryMarker;
  if (!hasInternalMarker) return null;
  if (reminderKind && reminderId && !redeliveryKind && !redeliveryMarker) return RUNTIME_REMINDER_TARGET;
  if (redeliveryKind && redeliveryId && !reminderKind && !reminderMarker) return RUNTIME_REDELIVERY_TARGET;
  throw new Error(`Inbox internal source requires matching kind and message_id prefix; received kind=${JSON.stringify(envelope.kind ?? null)} message_id=${JSON.stringify(envelope.message_id ?? null)}`);
}

function isChatTarget(target: string): boolean {
  return hasNonemptySuffix(target, CHAT_TARGET_PREFIX);
}

function isThreadTarget(target: string): boolean {
  return hasNonemptySuffix(target, THREAD_TARGET_PREFIX);
}

function isDocumentCommentTarget(target: string): boolean {
  return hasNonemptySuffix(target, DOCUMENT_COMMENT_TARGET_PREFIX);
}

export function isCanonicalInboxTarget(target: string): boolean {
  return isChatTarget(target)
    || isThreadTarget(target)
    || target === RUNTIME_REMINDER_TARGET
    || target === RUNTIME_REDELIVERY_TARGET
    || isDocumentCommentTarget(target);
}

/** Targets that can safely receive a user-facing reminder. Runtime wake targets are not delivery destinations. */
export function isUserDeliveryTarget(target: string): boolean {
  return isChatTarget(target) || isThreadTarget(target) || isDocumentCommentTarget(target);
}

function invalidTarget(target: string): Error {
  return new Error(`Invalid canonical Inbox target ${JSON.stringify(target)}; expected chat:<nonempty>, thread:<nonempty>, runtime:reminder, runtime:redelivery, or document-comment:<nonempty>`);
}

function optionalLocator(envelope: InboxEnvelope, key: "chat_id" | "thread_id"): string {
  const value = envelope[key];
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error(`Inbox ${key} must be a string when present; received ${JSON.stringify(value)}`);
  return value;
}

export function targetKeyOfInboxEnvelope(envelope: InboxEnvelope | null | undefined): string {
  if (!envelope) throw new Error("Inbox envelope is required to derive a canonical target");
  const internalTarget = internalTargetOfInboxEnvelope(envelope);
  const chatId = optionalLocator(envelope, "chat_id");
  const threadId = optionalLocator(envelope, "thread_id");
  if (threadId && !chatId) {
    throw new Error(`Inbox thread locator requires nonempty chat_id and thread_id; received chat_id=${JSON.stringify(chatId)} thread_id=${JSON.stringify(threadId)}`);
  }
  const locatorTarget = chatId ? (threadId ? `thread:${chatId}:${threadId}` : `chat:${chatId}`) : null;
  const hasExplicitTarget = Object.prototype.hasOwnProperty.call(envelope, "target");
  if (hasExplicitTarget) {
    if (typeof envelope.target !== "string" || envelope.target.length === 0) throw invalidTarget(String(envelope.target));
    const target = envelope.target;
    if (!isCanonicalInboxTarget(target)) throw invalidTarget(target);
    if (isChatTarget(target) || isThreadTarget(target)) {
      if (internalTarget || envelope.kind === "document_comment") throw new Error(`Inbox chat/thread target conflicts with source kind/message_id`);
      if (locatorTarget && locatorTarget !== target) {
        throw new Error(`Inbox chat/thread target conflicts with locator target ${JSON.stringify(locatorTarget)}`);
      }
      return target;
    }
    if (target === RUNTIME_REMINDER_TARGET || target === RUNTIME_REDELIVERY_TARGET) {
      if (locatorTarget) throw new Error(`Inbox runtime target cannot carry chat_id/thread_id locators`);
      if (internalTarget !== target) throw new Error(`Inbox target ${target} requires exact matching kind and message_id prefix`);
      return target;
    }
    if (isDocumentCommentTarget(target)) {
      if (envelope.kind !== "document_comment" || internalTarget) throw new Error(`Inbox document-comment target requires kind=document_comment and no internal source`);
      if (locatorTarget) throw new Error(`Inbox document-comment target cannot carry chat_id/thread_id locators`);
      return target;
    }
    throw invalidTarget(target);
  }
  if (envelope.kind === "document_comment") {
    throw new Error("Inbox document_comment requires an explicit document-comment:<nonempty> target");
  }
  if (locatorTarget) {
    if (internalTarget) throw new Error(`Inbox internal source cannot be derived as a chat/thread target`);
    return locatorTarget;
  }
  if (internalTarget) throw new Error(`Inbox internal source requires an explicit ${internalTarget} target`);
  throw new Error(`Inbox envelope has no canonical target locator (message_id=${JSON.stringify(envelope.message_id ?? null)}, kind=${JSON.stringify(envelope.kind ?? null)})`);
}

export interface AgentEventsProjection {
  events: InboxEnvelope[];
  last_seen_msgId: unknown | null;
  last_seen_seq: unknown | null;
  reply_target: string | null;
  pending_notice_ids: never[];
  wake_reason: null;
  has_more: false;
}

export interface InboxTargetSummary {
  target: string;
  pending_count: number;
  latest_received_seq: number;
  first_message_id: string | null;
  last_message_id: string | null;
}

export interface InboxLocators {
  chat_id: string;
  thread_id?: string | null;
  create_time?: string;
  update_time?: string;
  sender_id?: string | null;
  content?: string;
}

/** Enrich the durable local Inbox without changing the canonical Runtime envelope. */
export function projectInboxEnvelope(
  canonical: InboxEnvelope,
  locators: InboxLocators,
): InboxEnvelope & InboxLocators {
  return {
    ...canonical,
    chat_id: locators.chat_id,
    thread_id: locators.thread_id !== undefined ? locators.thread_id : (typeof canonical.thread_id === "string" ? canonical.thread_id : null),
    ...(locators.create_time !== undefined ? { create_time: locators.create_time }
      : (typeof canonical.create_time === "string" ? { create_time: canonical.create_time } : {})),
    ...(locators.update_time !== undefined ? { update_time: locators.update_time }
      : (typeof canonical.update_time === "string" ? { update_time: canonical.update_time } : {})),
    sender_id: locators.sender_id !== undefined ? locators.sender_id : (typeof canonical.sender_id === "string" ? canonical.sender_id : null),
    content: locators.content !== undefined ? locators.content : (typeof canonical.content === "string" ? canonical.content : ""),
  };
}

/** Return an allowlisted canonical target when the envelope is locatable. */
export function targetOfInboxEnvelope(envelope: InboxEnvelope | null | undefined): string | null {
  try { return targetKeyOfInboxEnvelope(envelope); }
  catch { return null; }
}

/** Project persisted inbox envelopes into the exact agentApi events response data shape. */
export function projectInboxEvents(envelopes: InboxEnvelope[]): AgentEventsProjection {
  const last = envelopes[envelopes.length - 1];
  return {
    events: envelopes,
    last_seen_msgId: last ? (last.message_id || null) : null,
    last_seen_seq: last ? (last.seq ?? null) : null,
    reply_target: last ? targetKeyOfInboxEnvelope(last) : null,
    pending_notice_ids: [],
    wake_reason: null,
    has_more: false,
  };
}

/** Bounded, content-light and deterministic projection for the read-only check command. */
export function projectInboxCheck(envelopes: InboxEnvelope[], onlyTarget?: string): {
  version: 2;
  targets: InboxTargetSummary[];
  pending_total: number;
  has_more: boolean;
} {
  if (onlyTarget && !isCanonicalInboxTarget(onlyTarget)) {
    throw new Error(`Invalid canonical Inbox check target ${JSON.stringify(onlyTarget)}`);
  }
  const byTarget = new Map<string, InboxEnvelope[]>();
  for (const envelope of envelopes) {
    const target = targetKeyOfInboxEnvelope(envelope);
    if (onlyTarget && onlyTarget !== target) continue;
    const rows = byTarget.get(target) ?? [];
    rows.push(envelope);
    byTarget.set(target, rows);
  }
  const allTargets = [...byTarget.entries()].map(([target, rows]) => ({
    target,
    pending_count: rows.length,
    latest_received_seq: rows.reduce((latest, row, index) => {
      const seq = Number(row.target_seq);
      return Number.isSafeInteger(seq) && seq > 0 ? Math.max(latest, seq) : Math.max(latest, index + 1);
    }, 0),
    first_message_id: typeof rows[0]?.message_id === "string" ? rows[0].message_id : null,
    last_message_id: typeof rows.at(-1)?.message_id === "string" ? rows.at(-1)!.message_id as string : null,
  })).sort((left, right) => left.target.localeCompare(right.target, "en"));
  return {
    version: 2,
    targets: allTargets.slice(0, 50),
    pending_total: allTargets.reduce((count, row) => count + row.pending_count, 0),
    has_more: allTargets.length > 50,
  };
}
