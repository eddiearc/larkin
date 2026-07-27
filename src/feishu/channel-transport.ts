export interface ChannelTransportInput {
  path: string;
  pathNoQuery: string;
  method: string;
  body: Record<string, unknown>;
}

interface ChannelContext { chat_id: string; channel_type: string; channel_name?: string }
interface JsonRecord { [key: string]: unknown }
interface ChatMetadata extends JsonRecord { name?: string; chat_mode?: string; chat_type?: string }
interface ReplyContextRecord extends JsonRecord { thread_id?: string }
interface ChannelLabel { label: string; chatId: string; meta: ChatMetadata | null; ctx: ReplyContextRecord | null; topicShort: string }
interface SelectedAgent { feishuAppId?: string; createdAt?: string }
interface LarkMember extends JsonRecord { name?: string; app_id?: string; member_id?: string }
interface LarkResult extends JsonRecord {
  ok?: boolean;
  data?: JsonRecord & { chat_id?: string; chatId?: string; bots?: LarkMember[]; users?: LarkMember[] };
  error?: JsonRecord & { code?: number };
}
interface FeishuAppInfo { name?: string | null; description?: string | null; avatarUrl?: string | null }
interface TransportResponse { ok: boolean; status: number; data?: unknown; error?: string }

interface ChannelTransportOptions {
  dryRun: boolean;
  selectedAgent: SelectedAgent;
  agentId: string;
  agentName: string;
  agentRuntime: string;
  agentModel: string;
  agentEffort: string | null;
  serverId: string;
  unknownCreatedAt: string;
  query(path: string, name: string): string | null;
  resolveChatId(target: unknown): string;
  resolveMemberTo(chatId: string, value: unknown): { type: string; ids: string[] } | null;
  channelContext(ref: unknown): ChannelContext;
  channelLabel(ref: string): ChannelLabel;
  chatMeta(chatId: string): ChatMetadata | null;
  invalidateChatMeta(chatId: string): void;
  rememberChannel(target: string, chatId: string, meta: Record<string, unknown>): void;
  mappedChannels(): Record<string, string>;
  larkJsonOut(args: string[]): LarkResult | null;
  feishuError(result: LarkResult): string | null;
  botDisplayName(): string | null;
  feishuAppInfo(): FeishuAppInfo | null;
  log(...args: unknown[]): void;
}

export function createChannelTransport(options: ChannelTransportOptions) {
  const handle = ({ path: requestPath, pathNoQuery, method, body }: ChannelTransportInput): TransportResponse | undefined => {
    if (/\/channels$/.test(pathNoQuery) && method === "POST") {
      const name = String(body.name || "").replace(/^#/, "").trim();
      if (!name) return { ok: false, status: 400, error: "建群需要 name" };
      const allowPublic = process.env.LARKIN_ALLOW_PUBLIC_CHAT === "1";
      const privateChat = !(allowPublic && body.visibility === "public");
      const args = ["im", "+chat-create", "--name", name, "--chat-mode", "group", "--type", privateChat ? "private" : "public", "--json"];
      if (body.description) args.push("--description", String(body.description).slice(0, 100));
      if (options.dryRun) args.push("--dry-run");
      const result = options.larkJsonOut(args);
      if (!result || result.ok === false) return { ok: false, status: 400, error: (result && options.feishuError(result)) || "建群失败" };
      const chatId = (result.data && (result.data.chat_id || result.data.chatId)) || "";
      if (chatId) options.rememberChannel(`#${name}`, chatId, { name, chat_mode: "group", chat_type: "group" });
      return { ok: true, status: 200, data: { id: `#${name}`, name, type: privateChat ? "private" : "public", joined: true, chatId: chatId || null } };
    }

    if (/\/channels\/[^/]+\/members$/.test(pathNoQuery) && (method === "POST" || method === "DELETE")) {
      const match = pathNoQuery.match(/\/channels\/([^/]+)\/members$/);
      const target = decodeURIComponent(match![1]);
      const chatId = options.resolveChatId(target);
      if (!chatId) return { ok: false, status: 404, error: `未知频道 ${target}` };
      const raw = body.user || body.agent || "";
      const resolved = options.resolveMemberTo(chatId, raw);
      if (!resolved) return { ok: false, status: 400, error: `无法识别成员 "${raw}"：请用 user_id(人) 或 app_id(cli_ 开头，bot)；也支持 open_id(ou_)/union_id(on_)。可先跑 larkin channel members 查看各成员 id。` };
      const verb = method === "DELETE" ? "delete" : "create";
      const args = ["im", "chat.members", verb, "--chat-id", chatId, "--member-id-type", resolved.type, "--data", JSON.stringify({ id_list: resolved.ids }), "--json"];
      if (verb === "delete") args.push("--yes");
      if (options.dryRun) args.push("--dry-run");
      const result = options.larkJsonOut(args);
      if (result?.ok === false) return { ok: false, status: 400, error: options.feishuError(result) || "成员操作失败" };
      return { ok: true, status: 200, data: { member: { name: String(raw).replace(/^@/, "") || resolved.ids[0] } } };
    }

    if (/\/channels\/[^/]+\/join$/.test(pathNoQuery) && method === "POST") {
      return { ok: false, status: 400, error: "飞书 bot 无法主动加入群聊；请让群主/管理员在群设置里邀请本 bot 进群。" };
    }

    if (/\/channels\/[^/]+\/leave$/.test(pathNoQuery) && method === "POST") {
      const match = pathNoQuery.match(/\/channels\/([^/]+)\/leave$/);
      const target = decodeURIComponent(match![1]);
      const chatId = options.resolveChatId(target);
      const selfApp = options.selectedAgent.feishuAppId;
      if (!chatId || !selfApp) return { ok: false, status: 400, error: "无法确定 chat_id 或本 bot app_id，退群失败" };
      const args = ["im", "chat.members", "delete", "--chat-id", chatId, "--member-id-type", "app_id", "--data", JSON.stringify({ id_list: [selfApp] }), "--yes", "--json"];
      if (options.dryRun) args.push("--dry-run");
      const result = options.larkJsonOut(args);
      if (result?.ok === false) return { ok: false, status: 400, error: options.feishuError(result) || "退群失败" };
      return { ok: true, status: 200, data: { ok: true } };
    }

    if (/\/channels\/[^/]+$/.test(pathNoQuery) && method === "PATCH") {
      const match = pathNoQuery.match(/\/channels\/([^/]+)$/);
      const target = decodeURIComponent(match![1]);
      const chatId = options.resolveChatId(target);
      if (!chatId) return { ok: false, status: 404, error: `未知频道 ${target}` };
      const newName = body.name !== undefined ? String(body.name).replace(/^#/, "").slice(0, 60) : undefined;
      const args = ["im", "+chat-update", "--chat-id", chatId, "--json"];
      if (newName !== undefined) args.push("--name", newName);
      if (body.description !== undefined) args.push("--description", String(body.description).slice(0, 100));
      if (newName === undefined && body.description === undefined) return { ok: false, status: 400, error: "飞书群仅支持改名称/描述；public/private 无法通过更新变更。" };
      if (options.dryRun) args.push("--dry-run");
      const result = options.larkJsonOut(args);
      if (!result || result.ok === false) return { ok: false, status: 400, error: (result && options.feishuError(result)) || "改群失败" };
      options.invalidateChatMeta(chatId);
      const meta = options.chatMeta(chatId);
      const name = newName !== undefined ? newName : ((meta && meta.name) || target.replace(/^#/, ""));
      return { ok: true, status: 200, data: { name, type: body.visibility === "private" ? "private" : "public" } };
    }

    if (/\/attachments\/[^/]+$/.test(pathNoQuery) && method === "GET") {
      return { ok: false, status: 501, error: "附件下载/预览暂未接入 larkin（当前仅支持上传并发送附件）。" };
    }

    if (requestPath.includes("/channel-members") || /\/channels\/[^/]+\/members/.test(requestPath)) {
      const match = requestPath.match(/\/channels\/([^/]+)\/members/);
      const ref = match ? decodeURIComponent(match[1]) : (options.query(requestPath, "channel") || "");
      const { chat_id: chatId, channel_type: channelType } = options.channelContext(ref);
      let agents: Array<{ name: string; status: "active"; id: string | null }> = [];
      let humans: Array<{ name: string; description: null; id: string | null }> = [];
      if (chatId) {
        const result = options.larkJsonOut(["im", "+chat-members-list", "--chat-id", chatId, "--member-id-type", "user_id", "--json"]);
        if (result?.ok && result.data) {
          agents = (result.data.bots || []).map((bot) => ({ name: bot.name || bot.app_id || "bot", status: "active", id: bot.app_id || bot.member_id || null }));
          humans = (result.data.users || []).map((user) => ({ name: user.name || user.member_id || "user", description: null, id: user.member_id || null }));
        } else if (result?.ok === false) {
          const error = options.feishuError(result);
          if (error) {
            options.log(`members 报错→原样抛给 agent: ${error.slice(0, 120)}`);
            return { ok: false, status: result.error?.code === 99991672 ? 403 : 400, error };
          }
          options.log(`members 降级(空): ${JSON.stringify(result.error || {}).slice(0, 120)}`);
        }
      }
      return { ok: true, status: 200, data: { channel: { ref, type: channelType }, agents, humans } };
    }

    if (requestPath.includes("/channel")) {
      const match = requestPath.match(/\/channels\/([^/?]+)/);
      const ref = match ? decodeURIComponent(match[1]) : (options.query(requestPath, "channel") || options.query(requestPath, "ref") || "");
      if (ref) {
        const { label, chatId, meta, ctx, topicShort } = options.channelLabel(ref);
        const isThread = Boolean(topicShort);
        const channel = {
          id: ref, name: label, joined: true, chatId: chatId || null,
          chatMode: (meta && meta.chat_mode) || null, chatType: (meta && meta.chat_type) || null,
          type: isThread ? "thread" : (String(ref).startsWith("dm:") ? "dm" : "channel"),
          threadId: isThread ? ((ctx && ctx.thread_id) || null) : null,
        };
        return { ok: true, status: 200, data: { channel, channels: [channel] } };
      }
      const map = options.mappedChannels();
      const channels = Object.keys(map).slice(0, 20).map((target) => {
        const meta = options.chatMeta(map[target]);
        return { id: target, name: (meta && meta.name) || String(target).replace(/^#/, "").replace(/^dm:@/, ""), joined: true };
      });
      return { ok: true, status: 200, data: { channels } };
    }

    if (requestPath.includes("/profile")) {
      const app = options.feishuAppInfo();
      const botName = options.botDisplayName() || (app && app.name);
      const name = botName || options.agentName;
      return { ok: true, status: 200, data: {
        kind: "agent", id: options.agentId, isSelf: true, name, displayName: name,
        description: (app && app.description) || null, avatarUrl: (app && app.avatarUrl) || null,
        status: "active", serverRole: null, runtime: options.agentRuntime, model: options.agentModel,
        reasoningEffort: options.agentEffort, executionMode: "byoc", computerId: null,
        computerName: options.agentName, computerHostname: options.agentName, daemonVersion: null,
        creator: null, createdAgents: [], createdAt: options.selectedAgent.createdAt ?? options.unknownCreatedAt, deletedAt: null,
      } };
    }
    return undefined;
  };
  return { handle };
}
