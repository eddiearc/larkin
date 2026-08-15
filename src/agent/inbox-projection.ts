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
export const DOCUMENT_COMMENT_TARGET_PATTERN = /^document-comment:(doc|docx|sheet|file):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+):(in-thread|top-level)$/;

const CHAT_ID_PATTERN = /^oc_[A-Za-z0-9_-]+$/;
const THREAD_ID_PATTERN = /^omt_[A-Za-z0-9_-]+$/;
const CHAT_TARGET_PATTERN = /^chat:(oc_[A-Za-z0-9_-]+)$/;
const THREAD_TARGET_PATTERN = /^thread:(oc_[A-Za-z0-9_-]+):(omt_[A-Za-z0-9_-]+)$/;

function internalTargetOfInboxEnvelope(envelope: InboxEnvelope): string | null {
  const messageId = typeof envelope.message_id === "string" ? envelope.message_id : "";
  const kindTarget = envelope.kind === "reminder" ? RUNTIME_REMINDER_TARGET
    : envelope.kind === "redelivery" ? RUNTIME_REDELIVERY_TARGET : null;
  const messageTarget = /^rem_[A-Za-z0-9_-]+$/.test(messageId) ? RUNTIME_REMINDER_TARGET
    : /^redeliver_[A-Za-z0-9_-]+$/.test(messageId) ? RUNTIME_REDELIVERY_TARGET : null;
  if (kindTarget && messageTarget && kindTarget !== messageTarget) {
    throw new Error(`Inbox internal source mismatch: kind=${JSON.stringify(envelope.kind)} message_id=${JSON.stringify(messageId)}`);
  }
  return kindTarget ?? messageTarget;
}

export function isCanonicalInboxTarget(target: string): boolean {
  return CHAT_TARGET_PATTERN.test(target)
    || THREAD_TARGET_PATTERN.test(target)
    || target === RUNTIME_REMINDER_TARGET
    || target === RUNTIME_REDELIVERY_TARGET
    || DOCUMENT_COMMENT_TARGET_PATTERN.test(target);
}

function invalidTarget(target: string): Error {
  return new Error(`Invalid canonical Inbox target ${JSON.stringify(target)}; expected chat:<oc_...>, thread:<oc_...>:<omt_...>, runtime:reminder, runtime:redelivery, or a valid document-comment locator`);
}

export function targetKeyOfInboxEnvelope(envelope: InboxEnvelope | null | undefined): string {
  if (!envelope) throw new Error("Inbox envelope is required to derive a canonical target");
  const internalTarget = internalTargetOfInboxEnvelope(envelope);
  if (typeof envelope.target === "string" && envelope.target.length > 0) {
    if (!isCanonicalInboxTarget(envelope.target)) throw invalidTarget(envelope.target);
    if ((envelope.target === RUNTIME_REMINDER_TARGET || envelope.target === RUNTIME_REDELIVERY_TARGET) && !internalTarget) {
      throw new Error(`Inbox target ${envelope.target} requires matching reminder/redelivery kind or message_id convention`);
    }
    if (internalTarget && envelope.target !== internalTarget) {
      throw new Error(`Inbox ${String(envelope.kind || envelope.message_id || "internal")} target must be ${internalTarget}, received ${JSON.stringify(envelope.target)}`);
    }
    if (envelope.kind === "document_comment" && !DOCUMENT_COMMENT_TARGET_PATTERN.test(envelope.target)) {
      throw new Error(`Inbox document_comment requires a valid document-comment locator, received ${JSON.stringify(envelope.target)}`);
    }
    return envelope.target;
  }
  if (envelope.target !== undefined && envelope.target !== null && envelope.target !== "") {
    throw invalidTarget(String(envelope.target));
  }
  const chatId = typeof envelope.chat_id === "string" ? envelope.chat_id : "";
  const threadId = typeof envelope.thread_id === "string" ? envelope.thread_id : "";
  if (threadId && (!THREAD_ID_PATTERN.test(threadId) || !CHAT_ID_PATTERN.test(chatId))) {
    throw new Error(`Inbox thread locator requires full oc_ chat_id and omt_ thread_id; received chat_id=${JSON.stringify(chatId)} thread_id=${JSON.stringify(threadId)}`);
  }
  if (chatId) {
    if (!CHAT_ID_PATTERN.test(chatId)) throw new Error(`Inbox chat locator requires a full oc_ chat_id; received ${JSON.stringify(chatId)}`);
    return threadId ? `thread:${chatId}:${threadId}` : `chat:${chatId}`;
  }
  if (envelope.kind === "document_comment") {
    throw new Error("Inbox document_comment requires an explicit valid document-comment locator");
  }
  if (internalTarget) return internalTarget;
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
