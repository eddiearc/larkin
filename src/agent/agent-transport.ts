// 生产版进程内 agent-api transport：把 agent 的 larkin CLI 后端重定向到飞书（lark-cli）。
// 由 Agent CLI 经 env LARKIN_AGENT_TRANSPORT_MODULE 直接装载生成的
// agent-transport.cjs → globalThis.__LARKIN_AGENT_TRANSPORT。
// 契约：{ request: async (input) => ({ok,status,data,error}) }，input={routeKey,method,path,body}。
//
// 当前 dispatcher：
//   messageSend / history / channel / member → TypeScript business context 调用 lark-cli
//   serverInfo / events → canonical Agent state 的本地投影
//   reminders → TypeScript reminder routes 持久化，host 侧调度触发
//   tasks/knowledge/migrations → 明确「不支持」（砍功能）
//
// target→chat_id 映射：
//   target→chat_id 只认 selected Agent canonical stateDir 里的映射（入站时写入）；
//   解析不到不兜底默认群——宁可发送失败也不发错地方。
//   LARKIN_FEISHU_DRYRUN=1 时 lark-cli 加 --dry-run（不真发，测试用）。

import type { FeishuHistoryMessage } from "./history-projection.js";
import type { InboxEnvelope } from "./inbox-projection.js";
import { createTransportBusinessContext } from "./transport-business-context.js";

type JsonObject = Record<string, unknown>;

export interface AgentTransportInput {
  routeKey?: unknown;
  method?: unknown;
  path?: unknown;
  body?: JsonObject | null;
}

export interface AgentTransportResponse {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

interface MultipartForm { get(name: string): unknown }
interface ResolvableMessage extends FeishuHistoryMessage { chat_id?: unknown }

export function createAgentTransport(env: Record<string, string | undefined> = process.env) {
  const business = createTransportBusinessContext(env);
  const {
    stateStore,
    agentId,
    agentName,
    serverId,
    outbound,
    channelTransport,
    reminderRoutes,
    loadMap,
    larkJsonOut,
    feishuError,
    query,
    channelContext,
    chatMeta,
    topicShort,
    memberNames,
    projectMessage,
    projectInboxEvents,
    sortVisibleHistory,
    logRequest,
    log,
  } = business;

  async function handle(input: AgentTransportInput): Promise<AgentTransportResponse> {
    const p = String(input.path || "");
    const pathNoQ = p.split("?")[0];
    const method = String(input.method || "GET").toUpperCase();
    const body: JsonObject = input.body || {};
    logRequest(method, p, body);

    // —— 出站：agent 回复 → 飞书 ——
    if (p.includes("/send")) {
      return outbound.handleSend(body);
    }

    // —— server.info：本地派生 + 用真实飞书群名填 channels（agent 能答"在哪个群"）——
    //    channels 来自累积的 target→chat_id 映射；群名按 chatId 缓存（有界，缺 scope 退回 slug）。
    //    话题首条描述符较贵，放到 channel info 单查，不在这批量拉。
    if (p.includes("/server")) {
      const map = loadMap();
      const seen = new Set<string>();
      const channels: Array<{ id: string; name: string; joined: boolean }> = [];
      for (const t of Object.keys(map).slice(0, 20)) {
        const chatId = map[t];
        const topicShortValue = topicShort(t);
        const key = `${chatId}|${topicShortValue}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const meta = chatMeta(chatId);
        let name = meta?.name || String(t).replace(/^#/, "").replace(/^dm:@/, "");
        if (topicShortValue) name += " (话题)";
        channels.push({ id: t, name, joined: true });
      }
      return { ok: true, status: 200, data: {
        runtimeContext: { agentId, serverId },
        channels, agents: [{ name: agentName, status: "active" }], humans: [],
      } };
    }

    // —— legacy events/inbox characterization：从 host 写的 inbox 文件读入站正文（读后清空=已读）——
    //    必须严格对齐 agentApiEventsResponseSchema，否则 CLI 报 INVALID_JSON_RESPONSE，Claude 读不到消息。
    if (p.includes("/events") || p.includes("/inbox")) {
      let envelopes: InboxEnvelope[] = [];
      try {
        envelopes = stateStore.readNdjson<InboxEnvelope>("inbox");
        if (envelopes.length) stateStore.clearNdjson("inbox");
      } catch { /* preserve legacy: malformed/unreadable inbox returns empty and is not cleared */ }
      return { ok: true, status: 200, data: projectInboxEvents(envelopes) };
    }
    // —— legacy history characterization：接飞书群历史 im +chat-messages-list ——
    //    需 bot 有 im:message:readonly；缺 scope 则优雅降级为空（不让 Claude 崩）。
    if (p.includes("/history")) {
      const channel = query(p, "channel") || "";
      const limit = query(p, "limit") || "20";
      const { chat_id, channel_type, channel_name } = channelContext(channel);
      let messages: Array<Record<string, unknown>> = [];
      let has_more = false;
      if (chat_id) {
        const jr = larkJsonOut(["im", "+chat-messages-list", "--chat-id", chat_id, "--page-size", String(limit), "--json"]);
        if (jr && jr.ok && jr.data) {
          const names = memberNames(chat_id);
          const raw = sortVisibleHistory(jr.data.messages || []);
          messages = raw.map((m) => projectMessage(m, channel_type, channel_name, names));
          has_more = !!jr.data.has_more;
        } else if (jr && jr.ok === false) {
          const se = feishuError(jr);
          if (se) { log(`history 报错→原样抛给 agent: ${se.slice(0, 120)}`); return { ok: false, status: jr.error && jr.error.code === 99991672 ? 403 : 400, error: se }; }
          log(`history 降级(空): ${JSON.stringify(jr.error || {}).slice(0, 120)}`);
        }
      }
      return { ok: true, status: 200, data: { messages, has_more, has_older: has_more, has_newer: false, last_read_seq: null } };
    }
    // —— search（`larkin message search`）：飞书无 bot 可用的消息内容搜索(只有 chat-search 搜群名)→ 保持空 ——
    if (p.includes("/search")) { log("messageSearch 无飞书后端(返回空)"); return { ok: true, status: 200, data: { results: [], hasMore: false } }; }
    // —— integrations（`larkin integration list`）——
    if (p.includes("/integrations")) return { ok: true, status: 200, data: { services: [], activeLogins: [] } };
    const channelResult = channelTransport.handle({ path: p, pathNoQuery: pathNoQ, method, body });
    if (channelResult !== undefined) return channelResult;
    // —— resolve（`larkin message resolve`）：按 om_ 精确取一条 im +messages-mget ——
    if (p.includes("/resolve")) {
      const rm = p.match(/\/messages\/([^/]+)\/resolve/);
      const msgId = rm ? decodeURIComponent(rm[1]) : "";
      let message: Record<string, unknown> = {};
      if (msgId) {
        const jr = larkJsonOut(["im", "+messages-mget", "--message-ids", msgId, "--json"]);
        const arr: ResolvableMessage[] = jr && jr.ok && jr.data ? (jr.data.messages || jr.data.items || []) : [];
        if (arr[0]) {
          const m = arr[0];
          const { channel_type, channel_name } = channelContext(`#c${String(m.chat_id || "").replace(/[^a-zA-Z0-9]/g, "").slice(-10)}`);
          message = projectMessage(m, channel_type, channel_name, memberNames(String(m.chat_id || "")));
        } else if (jr && jr.ok === false) {
          const se = feishuError(jr);
          if (se) { log(`resolve 报错→原样抛给 agent: ${se.slice(0, 120)}`); return { ok: false, status: jr.error && jr.error.code === 99991672 ? 403 : 400, error: se }; }
          log(`resolve 降级(空): ${JSON.stringify(jr.error || {}).slice(0, 120)}`);
        }
      }
      return { ok: true, status: 200, data: { message } };
    }
    // —— reactions（`larkin message react`）：POST /messages/:msgId/reactions {emoji} → im reactions create ——
    //    飞书要 emoji_type 枚举(SMILE/THUMBSUP…)，agent 传 emoji 字符；做小映射，未命中回退 THUMBSUP。
    if (p.includes("/reactions") && method === "POST") {
      const rm = p.match(/\/messages\/([^/]+)\/reactions/);
      const msgId = rm ? decodeURIComponent(rm[1]) : "";
      const emo = String(body.emoji || "");
      const EMAP: Record<string, string> = { "👍": "THUMBSUP", "👌": "OK", "❤️": "HEART", "😄": "SMILE", "🎉": "PARTY", "👀": "EYES", "🙏": "PRAY", "🔥": "FIRE", "✅": "DONE" };
      const emojiType = EMAP[emo] || (/^[A-Z_]+$/.test(emo) ? emo : "THUMBSUP");
      if (msgId) {
        const jr = larkJsonOut(["im", "reactions", "create", "--message-id", msgId, "--emoji-type", emojiType, "--json"]);
        if (jr && jr.ok === false) log(`react 失败(忽略): ${JSON.stringify(jr.error || {}).slice(0, 120)}`);
      }
      return { ok: true, status: 200, data: { message_id: msgId } };
    }

    // —— reminders：定时任务（本地实现）——
    // CRUD 落 <stateDir>/reminders.json；host 侧监听该文件推快照给 daemon ReminderCache，
    // 到点由 host 处理 fire_attempt 并把提醒投递回本 agent。响应 shape 客户端 zod 严格校验。
    if (/\/reminders(\/|$)/.test(pathNoQ)) {
      return reminderRoutes.handle({ path: p, pathNoQuery: pathNoQ, method, body });
    }

    // —— 砍掉的功能：明确不支持 ——
    if (/\/(tasks|knowledge|migrations)/.test(p)) {
      return { ok: false, status: 404, error: "unsupported in larkin (feature removed)" };
    }

    // 其它写操作兜底
    if (method !== "GET") return { ok: true, status: 200, data: { ok: true } };
    return { ok: true, status: 200, data: {} };
  }

  return {
    request: (input: AgentTransportInput) => handle(input),
    // 上游 larkin CLI 上传附件时调 client.requestMultipart("POST", ".../upload", FormData)。
    // 缺这个方法就 CHECK_FAILED；这里把 upload 落盘暂存，发送在 /send 带 attachmentIds 时进行。
    requestMultipart: async (_method: unknown, pathname: unknown, form: MultipartForm | null | undefined): Promise<AgentTransportResponse> => {
      const pp = String(pathname || "");
      if (pp.includes("/upload")) return outbound.stageUpload(form);
      return { ok: false, status: 404, error: `unsupported multipart route: ${pp}` };
    },
  };
}

export const transport = createAgentTransport(process.env);
