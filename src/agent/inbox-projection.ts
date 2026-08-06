export interface InboxEnvelope {
  envelope_version?: unknown;
  message_id?: unknown;
  seq?: unknown;
  target?: unknown;
  target_seq?: unknown;
  chat_id?: unknown;
  thread_id?: unknown;
  channel_type?: unknown;
  channel_name?: unknown;
  parent_channel_type?: unknown;
  parent_channel_name?: unknown;
  [key: string]: unknown;
}

export function targetKeyOfInboxEnvelope(envelope: InboxEnvelope | null | undefined): string {
  if (!envelope) return "runtime:unknown";
  if (envelope.kind === "document_comment" && typeof envelope.target === "string" && envelope.target) {
    return envelope.target;
  }
  if (typeof envelope.chat_id === "string" && envelope.chat_id) {
    return typeof envelope.thread_id === "string" && envelope.thread_id
      ? `thread:${envelope.chat_id}:${envelope.thread_id}`
      : `chat:${envelope.chat_id}`;
  }
  return targetOfInboxEnvelope(envelope) || "runtime:system";
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

/** Preserve the target/thread format consumed by the existing Agent CLI. */
export function targetOfInboxEnvelope(envelope: InboxEnvelope | null | undefined): string | null {
  if (!envelope) return null;
  if (envelope.kind === "document_comment") {
    return typeof envelope.target === "string" && envelope.target ? envelope.target : null;
  }
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

/** Bounded, content-light and deterministic projection for the read-only check command. */
export function projectInboxCheck(envelopes: InboxEnvelope[], onlyTarget?: string): {
  version: 2;
  targets: InboxTargetSummary[];
  pending_total: number;
  has_more: boolean;
} {
  const byTarget = new Map<string, InboxEnvelope[]>();
  for (const envelope of envelopes) {
    const target = typeof envelope.target === "string" && envelope.target ? envelope.target : targetKeyOfInboxEnvelope(envelope);
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
