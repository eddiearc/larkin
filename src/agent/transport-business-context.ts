import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAgentStateStore } from "./agent-state-store.js";
import { createChannelTransport } from "../feishu/channel-transport.js";
import * as larkinConfig from "../platform/config.js";
import {
  parseFeishuText,
  projectFeishuHistoryEnvelope,
  sortVisibleHistory,
  type FeishuHistoryMessage,
  type HistoryBotIdentity,
} from "./history-projection.js";
import { projectInboxEvents } from "./inbox-projection.js";
import { signatureDescription } from "../feishu/message-policy.js";
import { createOutboundTransport, type ReplyContext, type StagedAttachment } from "../feishu/outbound-transport.js";
import { createReminderRoutes } from "./reminder-routes.js";
import { auditReminderDelivery } from "./reminder-delivery-audit.js";
import { isImageMime, looksLikeMarkdown, resolveMappedChatId, safeConversationExcerpt } from "./transport-shell.js";
import { managedOfficialLarkCli } from "../app/agent-lark-cli-workspace.js";

type Env = Record<string, string | undefined>;
type JsonObject = Record<string, unknown>;
interface CommandResult { code: number | null; stdout: string; stderr: string }
interface LarkError extends JsonObject {
  code?: number; message?: string; type?: string; subtype?: string; log_id?: string; missing_scopes?: string[];
}
interface MemberRecord extends JsonObject { member_id?: string; app_id?: string; name?: string }
interface ApplicationRecord extends JsonObject { app_name?: string; description?: string; avatar_url?: string }
interface LarkData extends JsonObject {
  users?: MemberRecord[]; bots?: MemberRecord[]; messages?: FeishuHistoryMessage[]; items?: FeishuHistoryMessage[];
  has_more?: boolean; app?: ApplicationRecord; name?: string; chat_mode?: string; chat_type?: string;
  chat_id?: string; chatId?: string;
}
interface LarkResult extends JsonObject { ok?: boolean; data?: LarkData; error?: LarkError }
interface BotIdentity extends HistoryBotIdentity { open_id?: string; name?: string }
interface SignatureCache { mtime: number; data: Record<string, { description?: string }> }
interface ChatMeta extends JsonObject { name: string; chat_mode: string; chat_type: string }
interface FeishuReplyContext extends ReplyContext { thread_id?: string; chat_id?: string }
interface AppInfo { name: string | null; description: string | null; avatarUrl: string | null }

export function formatFeishuError(error: LarkError | null | undefined, grantLink: string | null = null): string | null {
  if (!error) return null;
  const parts: string[] = [];
  if (error.message) parts.push(error.message);
  if (error.missing_scopes?.length) parts.push(`missing_scopes: ${error.missing_scopes.join(", ")}`);
  const tag = [error.type, error.subtype].filter(Boolean).join("/");
  const meta = [tag, error.code != null ? `code ${error.code}` : "", error.log_id ? `log_id ${error.log_id}` : ""].filter(Boolean).join(" | ");
  if (meta) parts.push(`(${meta})`);
  let output = `飞书接口报错：${parts.join("　")}`;
  const isScope = error.code !== 230027
    && (error.subtype === "app_scope_not_applied" || error.code === 99991672 || Boolean(error.missing_scopes?.length));
  if (error.code === 230027) {
    output += "\n\n[系统提示] 请检查 bot/app 是否已加入目标 chat/thread（membership），并确认该目标允许当前 app 执行操作（target authorization）；这不是 OAuth scope apply 错误。";
  }
  if (isScope) {
    output += grantLink
      ? `\n\n授权链接（请 app owner 本人打开确认，约50分钟内有效，确认后即生效）：\n${grantLink}`
      : "\n\n[系统提示] 当前没有可用的授权链接。请勿自行拼造或猜测任何 scope-apply / 开发者后台链接（那类链接对本应用无效）。只需如实说明缺少上述 scope、需有开发者后台权限者去补充；有可用链接时系统会在此处给出。";
  }
  return output;
}

export function createTransportBusinessContext(env: Env = process.env) {
  const { config } = larkinConfig.loadConfig(env);
  const selectedAgent = larkinConfig.selectAgent(config, env);
  const stateStore = createAgentStateStore(config.larkinHome, selectedAgent.agentId);
  if (path.resolve(stateStore.paths.root) !== path.resolve(selectedAgent.stateDir)) {
    throw new Error(`Agent ${selectedAgent.agentId} state store 路径不一致`);
  }
  if (!config.serverId) throw new Error("config.serverId 未配置");

  const paths = stateStore.paths;
  const attachmentDir = path.join(paths.root, "attachments");
  const attachmentIndexFile = path.join(paths.root, "attachments.json");
  const transportLogFile = path.join(paths.root, "transport.log");
  const dryRun = env.LARKIN_FEISHU_DRYRUN === "1";
  const agentId = selectedAgent.agentId;
  const agentName = selectedAgent.name;
  const agentRuntime = selectedAgent.runtime;
  const agentModel = selectedAgent.model;
  const agentEffort = selectedAgent.effort ?? null;
  const serverId = config.serverId;
  const unknownCreatedAt = "1970-01-01T00:00:00.000Z";

  const log = (...parts: unknown[]): void => {
    const line = `[feishu-transport] ${parts.join(" ")}\n`;
    process.stderr.write(line);
    try { fs.appendFileSync(transportLogFile, `${new Date().toISOString()} ${line}`); } catch { /* best effort */ }
  };
  const logRequest = (method: string, requestPath: string, body: JsonObject): void => {
    try {
      fs.appendFileSync(transportLogFile, `${new Date().toISOString()} REQ ${method} ${requestPath} body=${JSON.stringify(body).slice(0, 300)}\n`);
    } catch { /* best effort */ }
  };

  let signatureCache: SignatureCache | null = null;
  const senderSignature = (senderId: string): string | null => {
    if (!senderId) return null;
    try {
      const mtime = fs.statSync(paths.senderProfiles).mtimeMs;
      if (!signatureCache || signatureCache.mtime !== mtime) {
        signatureCache = { mtime, data: JSON.parse(fs.readFileSync(paths.senderProfiles, "utf8")) as SignatureCache["data"] };
      }
      return signatureCache.data[senderId]?.description || null;
    } catch { return null; }
  };

  let identityCache: BotIdentity | null | undefined;
  const botIdentity = (): BotIdentity | null => {
    if (identityCache !== undefined) return identityCache;
    try { identityCache = JSON.parse(fs.readFileSync(paths.botIdentity, "utf8")) as BotIdentity; }
    catch { identityCache = null; }
    return identityCache;
  };

  const appendConversation = (item: JsonObject): void => {
    try {
      fs.appendFileSync(paths.conversation, `${JSON.stringify({ ...item, text: safeConversationExcerpt(item.text) })}\n`);
    } catch (error) { log(`conversation 写失败: ${(error as Error).message}`); }
  };

  const loadMap = (): Record<string, string> => {
    try { return JSON.parse(fs.readFileSync(paths.map, "utf8")) as Record<string, string>; }
    catch { return {}; }
  };
  const resolveChatId = (target: unknown): string => resolveMappedChatId(loadMap(), target);

  const recordReminderDelivery = ({ target, succeeded, messageId, reason }: {
    target: string; succeeded: boolean; messageId?: string; reason?: string;
  }): void => {
    const current = stateStore.resolveCurrentReminder();
    try {
      auditReminderDelivery({ stateStore, agentId, target, succeeded, ...(messageId ? { messageId } : {}),
        ...(reason ? { reason } : {}), resolveChatId });
    } catch (error) {
      log(`reminder outbound audit 写失败 id=#${current?.reminderId.slice(0, 8) || "unknown"}: ${(error as Error).message}`);
    }
  };

  const larkArgs = (...rest: string[]): string[] => rest;
  const larkCli = (args: string[], cwd?: string): CommandResult => {
    const managed = managedOfficialLarkCli(selectedAgent, process.env);
    const options: SpawnSyncOptionsWithStringEncoding = {
      encoding: "utf8",
      env: managed.env,
      ...(cwd ? { cwd } : {}),
    };
    const result = spawnSync(managed.command.command, [...managed.command.argsPrefix, ...larkArgs(...args)], options);
    return { code: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
  };
  const larkJsonOut = (args: string[]): LarkResult | null => {
    let result: CommandResult;
    try { result = larkCli(args); }
    catch { return null; }
    const clean = (value: string): string => value.split("\n").filter((line) => !/^\[page|fetching/.test(line.trim())).join("\n");
    for (const value of [result.stdout, result.stderr]) {
      try {
        const parsed: unknown = JSON.parse(clean(value));
        if (parsed && typeof parsed === "object") return parsed as LarkResult;
      } catch { /* try next stream */ }
    }
    return null;
  };

  const memberData = (chatId: string): LarkData | null => {
    const result = larkJsonOut(["im", "+chat-members-list", "--chat-id", chatId, "--json"]);
    return result?.ok && result.data ? result.data : null;
  };
  const userIds = new Map<string, Set<string> | null>();
  const chatUserIdSet = (chatId: string): Set<string> | null => {
    if (userIds.has(chatId)) return userIds.get(chatId) ?? null;
    const result = larkJsonOut(["im", "+chat-members-list", "--chat-id", chatId, "--member-id-type", "user_id", "--json"]);
    const set = result?.ok && result.data
      ? new Set((result.data.users || []).flatMap((user) => user.member_id ? [user.member_id] : []))
      : null;
    userIds.set(chatId, set);
    return set;
  };
  const memberNames = (chatId: string): Record<string, string> => {
    const names: Record<string, string> = {};
    const data = memberData(chatId);
    if (!data) return names;
    for (const user of data.users || []) if (user.member_id) names[user.member_id] = user.name || user.member_id;
    for (const bot of data.bots || []) {
      const name = bot.name || bot.member_id || "bot";
      if (bot.member_id) names[bot.member_id] = name;
      if (bot.app_id) names[bot.app_id] = name;
    }
    return names;
  };
  const pairCache = new Map<string, Array<[string, string]>>();
  const memberNameIdPairs = (chatId: string): Array<[string, string]> => {
    const cached = pairCache.get(chatId);
    if (cached) return cached;
    const byName: Record<string, string> = {};
    for (const [id, name] of Object.entries(memberNames(chatId))) {
      if (!name || name === id) continue;
      if (!byName[name] || (id.startsWith("ou_") && !byName[name].startsWith("ou_"))) byName[name] = id;
    }
    const pairs = Object.entries(byName).sort((left, right) => right[0].length - left[0].length);
    pairCache.set(chatId, pairs);
    return pairs;
  };
  const renderMentions = (content: unknown, chatId?: string): { content: string; mentioned: boolean } => {
    let mentioned = false;
    let output = String(content).replace(/@(ou_[A-Za-z0-9]+|on_[A-Za-z0-9]+)/g, (_whole, id: string) => {
      mentioned = true;
      return `<at id="${id}"></at>`;
    });
    if (chatId && output.includes("@")) {
      const pairs = memberNameIdPairs(chatId);
      let rendered = "";
      for (let index = 0; index < output.length;) {
        if (output[index] === "@") {
          const rest = output.slice(index + 1);
          const hit = pairs.find(([name]) => rest.startsWith(name) && !/^[\p{L}\p{N}_]/u.test(rest.slice(name.length)));
          if (hit) {
            mentioned = true;
            rendered += `<at id="${hit[1]}"></at>`;
            index += hit[0].length + 1;
            continue;
          }
        }
        rendered += output[index];
        index += 1;
      }
      output = rendered;
    }
    const ids = chatId ? chatUserIdSet(chatId) : null;
    if (ids?.size) {
      output = output.replace(/@([A-Za-z0-9]{2,})/g, (whole, token: string) => {
        if (!ids.has(token)) return whole;
        mentioned = true;
        return `<at id="${token}"></at>`;
      });
    }
    return { content: output, mentioned };
  };

  const larkSend = (chatId: string, content: string, idempotencyKey: unknown): CommandResult => {
    const rendered = renderMentions(content, chatId);
    const args = ["im", "+messages-send", "--chat-id", chatId, rendered.mentioned || looksLikeMarkdown(rendered.content) ? "--markdown" : "--text", rendered.content, "--json"];
    if (idempotencyKey) args.push("--idempotency-key", String(idempotencyKey));
    if (dryRun) args.push("--dry-run");
    return larkCli(args);
  };
  const larkReply = (messageId: string, content: string, idempotencyKey: unknown, chatId: string): CommandResult => {
    const rendered = renderMentions(content, chatId);
    const args = ["im", "+messages-reply", "--message-id", messageId, "--reply-in-thread", rendered.mentioned || looksLikeMarkdown(rendered.content) ? "--markdown" : "--text", rendered.content, "--json"];
    if (idempotencyKey) args.push("--idempotency-key", String(idempotencyKey));
    if (dryRun) args.push("--dry-run");
    return larkCli(args);
  };
  const larkSendMedia = (chatId: string, reply: ReplyContext | null, attachment: StagedAttachment, idempotencyKey: string): CommandResult => {
    const flag = isImageMime(attachment.mimeType) ? "--image" : "--file";
    const replyTo = reply?.in_topic && reply.reply_to ? reply.reply_to : null;
    const args = replyTo
      ? ["im", "+messages-reply", "--message-id", replyTo, "--reply-in-thread", flag, attachment.file, "--json"]
      : ["im", "+messages-send", "--chat-id", chatId, flag, attachment.file, "--json"];
    if (idempotencyKey) args.push("--idempotency-key", idempotencyKey);
    if (dryRun) args.push("--dry-run");
    return larkCli(args, attachmentDir);
  };
  const replyContextFor = (target: string): FeishuReplyContext | null => {
    try { return (JSON.parse(fs.readFileSync(paths.replyctx, "utf8")) as Record<string, FeishuReplyContext>)[target] || null; }
    catch { return null; }
  };

  const outbound = createOutboundTransport({
    attachmentDir, attachmentIndexFile, resolveChatId, replyContextFor,
    sendText: larkSend, replyText: larkReply, sendMedia: larkSendMedia,
    appendConversation, onDeliveryOutcome: recordReminderDelivery,
    botDisplayName: () => botIdentity()?.name, agentName, dryRun, log,
  });

  const liveGrantLink = (): string | null => {
    try {
      const file = env.LARKIN_GRANT_URL_FILE || "/tmp/larkin-grant-url.txt";
      if (!fs.existsSync(file)) return null;
      const alive = spawnSync("pgrep", ["-f", "grant-scopes.mjs"], { encoding: "utf8" });
      if (!alive.stdout.trim()) return null;
      const url = fs.readFileSync(file, "utf8").trim();
      return /^https?:\/\//.test(url) ? url : null;
    } catch { return null; }
  };
  const feishuError = (result: LarkResult | null): string | null => {
    return formatFeishuError(result?.error, liveGrantLink());
  };
  const query = (requestPath: string, name: string): string | null => {
    try { return new URL(`http://x${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`).searchParams.get(name); }
    catch { return null; }
  };
  const channelContext = (target: unknown): { chat_id: string; channel_type: string; channel_name: string } => {
    const value = String(target || "");
    const base = value.split(":").slice(0, 2).join(":");
    return {
      chat_id: resolveChatId(value),
      channel_type: value.startsWith("dm:") ? "dm" : "channel",
      channel_name: base.replace(/^#/, "").replace(/^dm:@/, ""),
    };
  };

  const chatMetaCache: Record<string, ChatMeta | null> = {};
  const chatMeta = (chatId: string): ChatMeta | null => {
    if (!chatId) return null;
    if (Object.hasOwn(chatMetaCache, chatId)) return chatMetaCache[chatId];
    const result = larkJsonOut(["im", "chats", "get", "--chat-id", chatId, "--json"]);
    const meta = result?.ok && result.data
      ? { name: result.data.name || "", chat_mode: result.data.chat_mode || "", chat_type: result.data.chat_type || "" }
      : null;
    chatMetaCache[chatId] = meta;
    return meta;
  };
  const topicShort = (target: unknown): string => {
    const body = String(target || "").replace(/^#/, "").replace(/^dm:@/, "");
    const index = body.indexOf(":");
    return index >= 0 ? body.slice(index + 1, index + 9) : "";
  };
  const topicDescriptor = (thread: string): string | null => {
    const result = larkJsonOut(["im", "+threads-messages-list", "--thread", thread, "--order", "asc", "--page-size", "1", "--json"]);
    const first = result?.ok && result.data ? (result.data.messages || result.data.items || [])[0] : undefined;
    if (!first) return null;
    let content = typeof first.content === "string" ? first.content : JSON.stringify(first.content || "");
    try {
      const parsed = JSON.parse(content) as { text?: unknown; content?: unknown };
      content = typeof parsed.text === "string" ? parsed.text : (typeof parsed.content === "string" ? parsed.content : content);
    } catch { /* plain text */ }
    const normalized = content.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
    return normalized ? normalized.slice(0, 48) : null;
  };
  const channelLabel = (target: string): { label: string; chatId: string; meta: ChatMeta | null; ctx: FeishuReplyContext | null; topicShort: string } => {
    const chatId = resolveChatId(target);
    const meta = chatMeta(chatId);
    let label = meta?.name || target.replace(/^#/, "").replace(/^dm:@/, "");
    const short = topicShort(target);
    const context = replyContextFor(target);
    if (short) {
      const thread = context && (context.thread_id || context.reply_to);
      const descriptor = thread ? topicDescriptor(thread) : null;
      if (descriptor) label += ` › ${descriptor}`;
    }
    return { label, chatId, meta, ctx: context, topicShort: short };
  };

  let appInfoCache: AppInfo | null | undefined;
  const feishuAppInfo = (): AppInfo | null => {
    if (appInfoCache !== undefined) return appInfoCache;
    appInfoCache = null;
    const result = larkJsonOut(["api", "GET", `/open-apis/application/v6/applications/${selectedAgent.feishuAppId}`, "--params", '{"lang":"zh_cn"}']);
    const app = result?.ok && result.data?.app;
    if (app) appInfoCache = { name: app.app_name || null, description: app.description || null, avatarUrl: app.avatar_url || null };
    return appInfoCache;
  };
  let botNameCache: string | null | undefined;
  const botDisplayName = (): string | null => {
    if (botNameCache !== undefined) return botNameCache;
    botNameCache = null;
    const identity = botIdentity();
    if (identity?.name) return (botNameCache = identity.name);
    const knownChat = Object.values(loadMap()).find((value) => value.startsWith("oc_"));
    if (knownChat) {
      const bots = memberData(knownChat)?.bots || [];
      const mine = bots.find((bot) => bot.app_id === selectedAgent.feishuAppId || (identity?.open_id && bot.member_id === identity.open_id)) || (bots.length === 1 ? bots[0] : null);
      if (mine?.name) botNameCache = mine.name;
    }
    return botNameCache;
  };
  const resolveMember = (chatId: string, raw: unknown): { ids: string[]; type: string } | null => {
    const handle = String(raw || "").replace(/^@/, "").trim();
    if (!handle) return null;
    if (/^ou_[A-Za-z0-9]+$/.test(handle)) return { ids: [handle], type: "open_id" };
    if (/^on_[A-Za-z0-9]+$/.test(handle)) return { ids: [handle], type: "union_id" };
    if (/^(cli_|app_)[A-Za-z0-9]+$/.test(handle)) return { ids: [handle], type: "app_id" };
    const data = memberData(chatId);
    const user = data?.users?.find((candidate) => candidate.name === handle && candidate.member_id);
    if (user?.member_id) return { ids: [user.member_id], type: "open_id" };
    const bot = data?.bots?.find((candidate) => candidate.name === handle);
    if (bot?.app_id) return { ids: [bot.app_id], type: "app_id" };
    if (bot?.member_id) return { ids: [bot.member_id], type: "open_id" };
    return /^[A-Za-z0-9._-]{2,}$/.test(handle) ? { ids: [handle], type: "user_id" } : null;
  };
  const projectMessage = (message: FeishuHistoryMessage, channelType: string, channelName: string, names: Record<string, string>): Record<string, unknown> => {
    const senderId = String(message.sender?.id || "");
    const isBot = Boolean(message.sender && (message.sender.sender_type === "app" || message.sender.id_type === "app_id"));
    const self = Boolean(isBot && senderId && senderId === selectedAgent.feishuAppId);
    return projectFeishuHistoryEnvelope({
      message, channelType, channelName, names,
      selectedAppId: selectedAgent.feishuAppId,
      botIdentity: parseFeishuText(message) !== null || self ? botIdentity() : null,
      senderDescription: self ? null : signatureDescription(senderSignature(senderId)),
    });
  };

  const channelTransport = createChannelTransport({
    dryRun, selectedAgent, agentId, agentName, agentRuntime, agentModel, agentEffort, serverId, unknownCreatedAt,
    query, resolveChatId, resolveMemberTo: resolveMember, channelContext, channelLabel, chatMeta,
    invalidateChatMeta: (chatId) => { delete chatMetaCache[chatId]; },
    rememberChannel: (target, chatId, meta) => {
      try {
        const map = loadMap();
        map[target] = chatId;
        stateStore.writeJson("map", map);
        chatMetaCache[chatId] = {
          name: typeof meta.name === "string" ? meta.name : "",
          chat_mode: typeof meta.chat_mode === "string" ? meta.chat_mode : "",
          chat_type: typeof meta.chat_type === "string" ? meta.chat_type : "",
        };
      } catch { /* preserve best-effort map update */ }
    },
    mappedChannels: loadMap, larkJsonOut, feishuError, botDisplayName, feishuAppInfo, log,
  });
  const reminderRoutes = createReminderRoutes({
    stateFile: paths.reminders, agentId, query, log,
    currentInboxSource: () => stateStore.resolveCurrentInboxSource(),
    resolveMessageTarget: (messageId) => stateStore.resolveInboxMessageTarget(messageId),
  });

  try {
    fs.appendFileSync(transportLogFile, `${new Date().toISOString()} INIT profile=${selectedAgent.feishuProfile} larkCfgDir=${selectedAgent.larkConfigDir} inbox=${paths.inbox}\n`);
  } catch { /* best effort */ }

  return {
    stateStore, dryRun, agentId, agentName, serverId, transportLogFile,
    outbound, channelTransport, reminderRoutes,
    loadMap, larkJsonOut, feishuError, query, channelContext, chatMeta, topicShort,
    memberNames, projectMessage, projectInboxEvents, sortVisibleHistory, logRequest, log,
  };
}
