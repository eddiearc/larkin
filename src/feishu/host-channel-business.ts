import { decideWake, normalizeChannelMessage, type ChannelMessage, type FeishuInboundEvent } from "./message-policy.js";
import type { HostAgent, HostStateProjection } from "./host-business-state.js";
import { normalizeCardAction, type CommentEvent, type CommentTarget, type FetchedComment } from "@larksuite/channel";

interface ChannelAgent extends HostAgent {
  botOpenId?: string | null;
  botName?: string | null;
  noMentionChats?: string[];
}
interface BotIdentityRecord { open_id?: string; name?: string | null; avatar_url?: string | null; [key: string]: unknown }
interface BotStateStore {
  readJson<T>(key: "botIdentity", fallback: T): T;
  writeJson(key: "botIdentity", value: unknown): void;
}
interface Dispatcher { register(map: Record<string, (raw: unknown) => Promise<unknown> | unknown>): void }
interface ConnectedChannel {
  botIdentity?: { openId?: string; name?: string | null } | null;
  rawClient?: { request(input: { url: string; method: string }): Promise<unknown> } | null;
  comments?: {
    resolveTarget(fileToken: string, fileType: string): Promise<CommentTarget | null>;
    fetch(target: CommentTarget, commentId: string): Promise<FetchedComment | null>;
  };
}
interface CardActionEvent {
  messageId: string;
  chatId: string;
  operator: { openId: string; name?: string };
  action: { value: unknown; tag: string; name?: string; option?: string; formValue?: Record<string, unknown> };
  raw?: unknown;
}

export interface ChannelBusinessOptions {
  state: HostStateProjection;
  stateStore(agent: ChannelAgent): BotStateStore;
  onMessage(agent: ChannelAgent, event: FeishuInboundEvent, options: { wake: boolean }): void | Promise<void>;
  onComment?(agent: ChannelAgent, event: CommentEvent, channel: ConnectedChannel): void | Promise<void>;
  onReconnected?(agent: ChannelAgent, channel: ConnectedChannel): void | Promise<void>;
  onCardAction?(agent: ChannelAgent, event: CardActionEvent): Promise<Record<string, unknown>> | Record<string, unknown>;
  log?: (...parts: unknown[]) => void;
  now?: () => Date;
  mentionPolicy?(agentId: string, chatId: string): "require" | "free";
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class HostChannelBusiness {
  private readonly log: (...parts: unknown[]) => void;
  private readonly now: () => Date;

  constructor(private readonly options: ChannelBusinessOptions) {
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => new Date());
  }

  handlers(agent: ChannelAgent, channel?: ConnectedChannel): {
    message(message: ChannelMessage): void;
    comment(event: CommentEvent): Promise<void>;
    cardAction(event: CardActionEvent): Promise<Record<string, unknown>>;
    reconnecting(): void;
    reconnected(): void;
    error(): void;
  } {
    return {
      message: (message) => {
        try {
          const event = normalizeChannelMessage(message);
          this.options.state.updateStatus(agent, { inboundVerifiedAt: this.now().toISOString() });
          const senderIsBot = message.senderIsBot === true;
          const decision = decideWake({
            senderIsBot,
            mentionedBot: message.mentionedBot === true,
            mentionAll: message.mentionAll === true,
            isGroup: (message.chatType || "group") !== "p2p",
            mentionPolicy: senderIsBot ? "require" : this.options.mentionPolicy?.(agent.agentId, String(message.chatId || ""))
              || (Array.isArray(agent.noMentionChats) && agent.noMentionChats.includes(String(message.chatId || "")) ? "free" : "require"),
          });
          if (!decision.wake) {
            this.log(`${senderIsBot ? "bot 消息未点名@我" : "群消息未@bot"} → 只入箱不唤醒 agent=${agent.name} chat=${message.chatId}`);
          }
          void this.options.onMessage(agent, event, { wake: decision.wake });
        } catch (error) { this.log(`channel message 处理失败 agent=${agent.name}: ${messageOf(error)}`); }
      },
      comment: async (event) => {
        try {
          this.options.state.updateStatus(agent, {
            inboundVerifiedAt: this.now().toISOString(),
            documentCommentEventAt: this.now().toISOString(),
          });
          if (!channel || !this.options.onComment) return;
          await this.options.onComment(agent, event, channel);
        } catch (error) {
          this.log(`document comment 处理失败 agent=${agent.name}: ${messageOf(error)}`);
          this.options.state.recordStatusError(agent, `document comment: ${messageOf(error)}`);
        }
      },
      cardAction: async (event) => {
        if (!this.options.onCardAction) return { toast: { type: "error", content: "交互能力未启用，请重新运行 larkin setup 并重启 Larkin。" } };
        return this.options.onCardAction(agent, event);
      },
      reconnecting: () => {
        this.log(`ws 重连中… agent=${agent.name}`);
        this.options.state.updateStatus(agent, { reconnectingAt: this.now().toISOString() });
      },
      reconnected: () => {
        this.log(`ws 已恢复 agent=${agent.name}`);
        const connectedAt = this.now().toISOString();
        this.options.state.updateStatus(agent, { reconnectingAt: null, reconnectedAt: connectedAt, connectedAt });
        if (channel && this.options.onReconnected) {
          void Promise.resolve(this.options.onReconnected(agent, channel)).catch((error) => {
            this.log(`document comment 恢复重放失败 agent=${agent.name}: ${messageOf(error)}`);
          });
        }
      },
      error: () => {
        this.log(`ws 错误 agent=${agent.name}`);
        this.options.state.recordStatusError(agent, "channel ws 连接错误");
      },
    };
  }

  registerReadReceipts(agent: ChannelAgent, dispatcher: Dispatcher): void {
    try {
      dispatcher.register({
        "im.message.message_read_v1": async (raw) => {
          try {
            const event = raw as { reader?: { reader_id?: { open_id?: string }; read_time?: unknown }; message_id_list?: unknown[] };
            const reader = event?.reader?.reader_id?.open_id || null;
            const readAt = event?.reader?.read_time || null;
            const ids = event?.message_id_list || [];
            this.options.state.recordReadReceipts(agent, reader, readAt, ids);
            this.log(`已读回执 agent=${agent.name} reader=${reader || "?"} msgs=${ids.length}`);
          } catch (error) { this.log(`已读回执处理失败 agent=${agent.name}: ${messageOf(error)}`); }
        },
      });
    } catch (error) { this.log(`已读回执注册失败（不影响消息收发） agent=${agent.name}: ${messageOf(error)}`); }
  }

  /**
   * Replace the SDK's action-value TTL dedup handler after channel.connect().
   * Durable callback event_id ownership lives in InteractionStateMachine, so
   * retries receive the same response while later state-version clicks remain legal.
   */
  registerCardActions(agent: ChannelAgent, dispatcher: Dispatcher): void {
    dispatcher.register({
      "card.action.trigger": async (raw) => {
        const event = normalizeCardAction(raw as Parameters<typeof normalizeCardAction>[0], { includeRaw: true });
        if (!event) return { toast: { type: "error", content: "无法解析卡片操作，请刷新后重试。" } };
        return this.handlers(agent).cardAction(event);
      },
    });
  }

  persistBotIdentity(agent: ChannelAgent, openId: string, name: string | null, via: string, avatarUrl: string | null = null): void {
    agent.botOpenId = openId;
    agent.botName = name || agent.botName || null;
    try {
      let previous: BotIdentityRecord = {};
      try { previous = this.options.stateStore(agent).readJson("botIdentity", {}) || {}; } catch { /* first run */ }
      this.options.stateStore(agent).writeJson("botIdentity", {
        open_id: openId,
        name: name || previous.name || null,
        avatar_url: avatarUrl || previous.avatar_url || null,
        updated_at: this.now().toISOString(),
      });
    } catch (error) { this.log(`bot-identity 写入失败 agent=${agent.name}: ${messageOf(error)}`); }
    this.log(`bot 身份就绪(${via}) agent=${agent.name} bot=${name || "?"}(${openId})`);
    this.options.state.updateStatus(agent, { connectedAt: this.now().toISOString(), connectedVia: via, reconnectingAt: null });
  }

  async connected(agent: ChannelAgent, channel: ConnectedChannel, onFatal?: (error: Error) => void): Promise<void> {
    const identity = channel.botIdentity || null;
    if (!identity?.openId) {
      this.log(`createLarkChannel 已连接但未取到 botIdentity agent=${agent.name}`);
      onFatal?.(new Error("bot identity unavailable"));
      return;
    }
    let avatarUrl: string | null = null;
    let botName = identity.name || null;
    try {
      const info = await channel.rawClient?.request({ url: "/open-apis/bot/v3/info", method: "GET" }) as {
        bot?: { open_id?: string; avatar_url?: string; app_name?: string };
      } | undefined;
      if (info?.bot?.open_id === identity.openId) {
        avatarUrl = info.bot.avatar_url || null;
        botName = info.bot.app_name || botName;
      }
    } catch (error) { this.log(`bot 头像刷新失败（不影响连接） agent=${agent.name}: ${messageOf(error)}`); }
    this.persistBotIdentity(agent, identity.openId, botName, "channel", avatarUrl);
  }
}
