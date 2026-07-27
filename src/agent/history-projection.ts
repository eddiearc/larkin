export interface FeishuMention {
  key?: unknown;
  id?: unknown;
  name?: unknown;
}

export interface FeishuHistoryMessage {
  message_id?: unknown;
  message_position?: unknown;
  msg_type?: unknown;
  content?: unknown;
  create_time?: unknown;
  thread_id?: unknown;
  deleted?: unknown;
  mentions?: FeishuMention[];
  sender?: { id?: unknown; sender_type?: unknown; id_type?: unknown };
}

export interface HistoryBotIdentity {
  open_id?: unknown;
  name?: unknown;
}

export function parseFeishuText(message: FeishuHistoryMessage): string | null {
  if ((message.msg_type || "") !== "text") return null;
  try {
    const content = typeof message.content === "string" ? JSON.parse(message.content) as unknown : message.content;
    if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
      return (content as { text: string }).text;
    }
  } catch { /* preserve raw-content fallback */ }
  return null;
}

export function renderFeishuMentions(
  text: string,
  mentions: FeishuMention[] = [],
  botIdentity: HistoryBotIdentity | null = null,
): string {
  let rendered = text;
  for (const mention of mentions) {
    if (!mention?.key) continue;
    const self = Boolean(botIdentity && (
      (mention.id && mention.id === botIdentity.open_id) ||
      (botIdentity.name && mention.name === botIdentity.name)
    ));
    rendered = rendered.split(String(mention.key)).join(
      `@${String(mention.name || mention.id || "member")}${self ? "(=你)" : ""}`,
    );
  }
  return rendered;
}

export function toIsoTimestamp(value: unknown, now: () => Date = () => new Date()): string {
  if (value == null || value === "") return now().toISOString();
  if (/^\d+$/.test(String(value))) return new Date(Number(value)).toISOString();
  const source = String(value).replace(" ", "T");
  const withSeconds = /T\d{2}:\d{2}$/.test(source) ? `${source}:00` : source;
  const parsed = new Date(withSeconds);
  return Number.isNaN(parsed.getTime()) ? now().toISOString() : parsed.toISOString();
}

export function sortVisibleHistory(messages: FeishuHistoryMessage[]): FeishuHistoryMessage[] {
  return messages
    .filter((message) => !message.deleted)
    .sort((left, right) =>
      (Number(left.message_position) || 0) - (Number(right.message_position) || 0));
}

export function projectFeishuHistoryEnvelope({
  message,
  channelType,
  channelName,
  names = {},
  selectedAppId,
  botIdentity = null,
  senderDescription = null,
  now,
}: {
  message: FeishuHistoryMessage;
  channelType: string;
  channelName: string;
  names?: Record<string, string>;
  selectedAppId: string;
  botIdentity?: HistoryBotIdentity | null;
  senderDescription?: string | null;
  now?: () => Date;
}): Record<string, unknown> {
  const senderId = String(message.sender?.id || "");
  const isBot = Boolean(message.sender &&
    (message.sender.sender_type === "app" || message.sender.id_type === "app_id"));
  const parsedText = parseFeishuText(message);
  const rendered = parsedText === null
    ? null
    : renderFeishuMentions(parsedText, message.mentions || [], botIdentity);
  const content = rendered !== null
    ? rendered
    : (typeof message.content === "string" ? message.content : JSON.stringify(message.content || ""));
  const selfSender = Boolean(isBot && senderId && senderId === selectedAppId);
  const selfName = String(botIdentity?.name || senderId);
  return {
    message_id: message.message_id,
    seq: Number(message.message_position) || 0,
    sender_id: senderId || null,
    sender_name: selfSender ? `${selfName}(你自己)` : (names[senderId] || senderId || "user"),
    ...(senderDescription ? { sender_description: senderDescription } : {}),
    sender_type: isBot ? "agent" : "human",
    channel_type: channelType,
    channel_name: channelName,
    content: content || `[${String(message.msg_type || "unknown")}]`,
    timestamp: toIsoTimestamp(message.create_time, now),
    thread_id: message.thread_id || null,
  };
}
