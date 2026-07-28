import type { FreshnessAdapter, FreshnessTarget } from "../agent/freshness-gate.js";

export interface FeishuImMessage {
  message_id: string;
  create_time: string;
  update_time?: string;
  chat_id?: string;
  thread_id?: string;
  [key: string]: unknown;
}

export interface FeishuImCursor {
  schema: 1;
  revisionTime: string;
  messageIds: string[];
}

export interface FeishuImSnapshot {
  messages: FeishuImMessage[];
}

function integerMillis(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

export function messageRevisionTime(message: FeishuImMessage): bigint {
  const created = integerMillis(message.create_time);
  const updated = message.update_time === undefined || message.update_time === "" ? created : integerMillis(message.update_time);
  if (created === null || updated === null) throw new Error(`malformed Feishu IM revision for ${message.message_id || "unknown message"}`);
  return created > updated ? created : updated;
}

export function feishuImTarget(value: string): FreshnessTarget {
  const thread = /^thread:([^:]+):(.+)$/.exec(value);
  if (thread) return { provider: "feishu.im", resourceKind: "thread", resourceId: `${thread[1]}/${thread[2]}` };
  const chat = /^chat:(.+)$/.exec(value);
  if (chat) return { provider: "feishu.im", resourceKind: "chat", resourceId: chat[1] };
  throw new Error(`unsupported Feishu IM freshness target: ${value}`);
}

export function serializeFeishuImTarget(target: FreshnessTarget): string {
  return `${target.provider}/${target.resourceKind}/${target.resourceId}`;
}

function normalizedMessages(snapshot: FeishuImSnapshot): Array<FeishuImMessage & { revision: bigint }> {
  if (!snapshot || !Array.isArray(snapshot.messages)) throw new Error("malformed Feishu IM history payload: messages must be an array");
  return snapshot.messages.map((message) => {
    if (!message || typeof message !== "object" || typeof message.message_id !== "string" || !message.message_id) {
      throw new Error("malformed Feishu IM history payload: message_id is required");
    }
    return { ...message, revision: messageRevisionTime(message) };
  });
}

export const feishuImFreshnessAdapter: FreshnessAdapter<FeishuImCursor, FeishuImSnapshot, FeishuImMessage[]> = {
  cursor(snapshot) {
    const messages = normalizedMessages(snapshot);
    if (!messages.length) return null;
    const revision = messages.reduce((maximum, message) => message.revision > maximum ? message.revision : maximum, 0n);
    return {
      schema: 1,
      revisionTime: revision.toString(),
      messageIds: [...new Set(messages.filter((message) => message.revision === revision).map((message) => message.message_id))].sort(),
    };
  },
  compare(seen, current) {
    if (!current) return seen ? "gap" : "fresh";
    if (!seen) return "conflict";
    const seenTime = integerMillis(seen.revisionTime);
    const currentTime = integerMillis(current.revisionTime);
    if (seen.schema !== 1 || seenTime === null || currentTime === null) return "gap";
    if (currentTime < seenTime) return "gap";
    if (currentTime > seenTime) return "conflict";
    return current.messageIds.every((id) => seen.messageIds.includes(id)) ? "fresh" : "conflict";
  },
  unseen(seen, snapshot) {
    const messages = normalizedMessages(snapshot);
    if (!seen) return messages.map(({ revision: _revision, ...message }) => message);
    const seenTime = integerMillis(seen.revisionTime);
    if (seenTime === null) return messages.map(({ revision: _revision, ...message }) => message);
    return messages.filter((message) => message.revision > seenTime
      || (message.revision === seenTime && !seen.messageIds.includes(message.message_id)))
      .map(({ revision: _revision, ...message }) => message);
  },
};

export function mergeFeishuImCursor(left: FeishuImCursor | null, right: FeishuImCursor): FeishuImCursor {
  if (!left) return { ...right, messageIds: [...right.messageIds] };
  const leftTime = BigInt(left.revisionTime);
  const rightTime = BigInt(right.revisionTime);
  if (rightTime < leftTime) return left;
  if (rightTime > leftTime) return { ...right, messageIds: [...right.messageIds] };
  return { schema: 1, revisionTime: left.revisionTime, messageIds: [...new Set([...left.messageIds, ...right.messageIds])].sort() };
}
