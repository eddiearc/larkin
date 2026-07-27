export interface InboxEnvelope {
  message_id?: unknown;
  seq?: unknown;
  channel_type?: unknown;
  channel_name?: unknown;
  parent_channel_type?: unknown;
  parent_channel_name?: unknown;
  [key: string]: unknown;
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

export interface InboxLocators {
  chat_id: string;
  thread_id?: string | null;
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
    sender_id: locators.sender_id !== undefined ? locators.sender_id : (typeof canonical.sender_id === "string" ? canonical.sender_id : null),
    content: locators.content !== undefined ? locators.content : (typeof canonical.content === "string" ? canonical.content : ""),
  };
}

/** Preserve the target/thread format consumed by the existing Agent CLI. */
export function targetOfInboxEnvelope(envelope: InboxEnvelope | null | undefined): string | null {
  if (!envelope) return null;
  if (envelope.channel_type === "thread" && envelope.parent_channel_name) {
    const base = envelope.parent_channel_type === "dm"
      ? `dm:@${String(envelope.parent_channel_name)}`
      : `#${String(envelope.parent_channel_name)}`;
    return `${base}:${String(envelope.channel_name || "").slice(0, 8)}`;
  }
  return envelope.channel_type === "dm"
    ? `dm:@${String(envelope.channel_name)}`
    : `#${String(envelope.channel_name)}`;
}

/** Project persisted inbox envelopes into the exact agentApi events response data shape. */
export function projectInboxEvents(envelopes: InboxEnvelope[]): AgentEventsProjection {
  const last = envelopes[envelopes.length - 1];
  return {
    events: envelopes,
    last_seen_msgId: last ? (last.message_id || null) : null,
    last_seen_seq: last ? (last.seq ?? null) : null,
    reply_target: targetOfInboxEnvelope(last),
    pending_notice_ids: [],
    wake_reason: null,
    has_more: false,
  };
}
