import crypto from "node:crypto";

export interface ChannelMessage {
  chatId?: string;
  chatMode?: string;
  chatType?: string;
  senderId?: string;
  messageId?: string;
  content?: string;
  createTime?: string | number;
  threadId?: string | null;
  mentionedBot?: boolean;
  mentionAll?: boolean;
  senderIsBot?: boolean;
}

export interface FeishuInboundEvent {
  chat_id: string;
  chat_type: string;
  sender_id: string;
  message_id: string;
  event_id: string;
  content: string;
  create_time?: string | number;
  thread_id: string | null;
  _mentioned_bot: boolean;
  _mention_all: boolean;
  _sender_is_bot: boolean;
}

export interface WakePolicyInput {
  senderIsBot: boolean;
  mentionedBot: boolean;
  mentionAll: boolean;
  isGroup: boolean;
  mentionPolicy?: "require" | "free";
  /** v3 compatibility input; new callers use mentionPolicy. */
  noMentionChat?: boolean;
}

export type WakeReason =
  | "bot-exact-mention"
  | "bot-not-exactly-mentioned"
  | "human-direct-message"
  | "human-mentioned"
  | "human-no-mention-chat"
  | "human-group-not-mentioned";

export interface WakeDecision {
  wake: boolean;
  reason: WakeReason;
}

export interface TargetInfo {
  target: string;
  channel_type: "dm" | "channel" | "thread";
  channel_name: string;
  parent_channel_type?: "dm" | "channel";
  parent_channel_name?: string;
}

export interface EnvelopeAgentIdentity {
  botOpenId?: string | null;
  botName?: string | null;
}

export interface MessageEnvelope {
  message_id: string;
  seq: number;
  sender_id: string | null;
  sender_name: string;
  sender_description?: string;
  sender_type: "human" | "agent";
  channel_type: "dm" | "channel" | "thread";
  channel_name: string;
  content: string;
  timestamp: string;
  thread_id: string | null;
  parent_channel_type?: "dm" | "channel";
  parent_channel_name?: string;
}

export function decideWake(input: WakePolicyInput): WakeDecision {
  if (input.senderIsBot) {
    const wake = input.mentionedBot && !input.mentionAll;
    return { wake, reason: wake ? "bot-exact-mention" : "bot-not-exactly-mentioned" };
  }
  if (!input.isGroup) return { wake: true, reason: "human-direct-message" };
  if (input.mentionedBot || input.mentionAll) return { wake: true, reason: "human-mentioned" };
  if (input.mentionPolicy === "free" || input.noMentionChat) return { wake: true, reason: "human-no-mention-chat" };
  return { wake: false, reason: "human-group-not-mentioned" };
}

export function normalizeChannelMessage(message: ChannelMessage): FeishuInboundEvent {
  const messageId = String(message.messageId || "");
  return {
    chat_id: String(message.chatId || ""),
    chat_type: message.chatMode === "topic" ? "group" : String(message.chatType || "group"),
    sender_id: String(message.senderId || ""),
    message_id: messageId,
    event_id: messageId,
    content: String(message.content || ""),
    create_time: message.createTime,
    thread_id: message.threadId || null,
    _mentioned_bot: Boolean(message.mentionedBot || message.mentionAll),
    _mention_all: Boolean(message.mentionAll),
    _sender_is_bot: message.senderIsBot === true,
  };
}

export function slug10(value: unknown): string {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "").slice(-10);
}

export function targetFor(event: Pick<FeishuInboundEvent, "chat_id" | "chat_type" | "thread_id">): TargetInfo {
  const slug = `c${slug10(event.chat_id)}`;
  const isDm = event.chat_type === "p2p";
  const base = isDm ? `dm:@${slug}` : `#${slug}`;
  if (event.thread_id) {
    const threadSlug = slug10(event.thread_id);
    return {
      target: `${base}:${threadSlug.slice(0, 8)}`,
      channel_type: "thread",
      channel_name: threadSlug,
      parent_channel_type: isDm ? "dm" : "channel",
      parent_channel_name: slug,
    };
  }
  return { target: base, channel_type: isDm ? "dm" : "channel", channel_name: slug };
}

export function targetAliases(
  event: Pick<FeishuInboundEvent, "chat_id" | "chat_type" | "thread_id">,
  target: TargetInfo = targetFor(event),
): string[] {
  const slug = `c${slug10(event.chat_id)}`;
  const base = event.chat_type === "p2p" ? `dm:@${slug}` : `#${slug}`;
  const aliases = [base];
  if (target.channel_type === "thread" && target.channel_name) {
    aliases.push(`${base}:${target.channel_name}`, `${base}:${target.channel_name.slice(0, 8)}`);
  }
  return [...new Set(aliases)];
}

export function xmlText(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function signatureDescription(signature: unknown): string | null {
  return signature ? `<feishu_signature>${xmlText(signature)}</feishu_signature>` : null;
}

export function createMessageEnvelope({
  agent,
  event,
  seq,
  names = {},
  signature = null,
}: {
  agent: EnvelopeAgentIdentity;
  event: FeishuInboundEvent;
  seq: number;
  names?: Record<string, string>;
  signature?: unknown;
}): MessageEnvelope {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error(`invalid message sequence: ${seq}`);
  const target = targetFor(event);
  const senderIsBot = Boolean(agent.botOpenId && event.sender_id === agent.botOpenId) || event._sender_is_bot;
  const senderDescription = signatureDescription(signature);
  const timestamp = event.create_time
    ? new Date(Number(event.create_time)).toISOString()
    : new Date().toISOString();
  let content = event.content || "";
  if (event._mentioned_bot && !event._mention_all) {
    content += `\n[提及说明: 本消息 @ 的${agent.botName ? `“${agent.botName}”` : "机器人"}就是你自己，请按被点名处理]`;
  }
  return {
    message_id: event.message_id || `m_${crypto.randomBytes(6).toString("hex")}`,
    seq,
    sender_id: event.sender_id || null,
    sender_name: names[event.sender_id] || event.sender_id || "user",
    ...(senderDescription ? { sender_description: senderDescription } : {}),
    sender_type: senderIsBot ? "agent" : "human",
    channel_type: target.channel_type,
    channel_name: target.channel_name,
    content,
    timestamp,
    thread_id: event.thread_id || null,
    ...(target.parent_channel_type ? { parent_channel_type: target.parent_channel_type } : {}),
    ...(target.parent_channel_name ? { parent_channel_name: target.parent_channel_name } : {}),
  };
}
