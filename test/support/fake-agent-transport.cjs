// 测试用的进程内 agent-api transport（hermetic，不打真飞书、不拨 serverUrl）。
// 由 agent-cli.cjs 经 env LARKIN_AGENT_TRANSPORT_MODULE 装载，赋给 globalThis.__LARKIN_AGENT_TRANSPORT。
// 契约：{ request: async (input) => ({ok,status,data,error}) }，input = {routeKey,method,path,body}。
//
// 作用：把 runner 的 larkin CLI 后端全部收进本进程，
//   ① 记录每次调用到 LARKIN_FAKE_SINK（NDJSON），供 harness 断言「回复正文真的到达 handler」；
//   ② 返回契约最小合法响应，让 runner 正常走完（能真发出 messages.send）。
// 证明：CLI 不再拨 serverUrl（拦截成立）+ 完整回复面闭环。

const fs = require("node:fs");

const SINK = process.env.LARKIN_FAKE_SINK || "/tmp/larkin-fake-sink.ndjson";
const AGENT_ID = process.env.LARKIN_FAKE_AGENT_ID || "00000000-0000-0000-0000-0000000000aa";
const SERVER_ID = process.env.LARKIN_SERVER_ID || "527d4cd1-cdca-4ea2-8ec4-78095e0a3684";

function record(entry) {
  try {
    fs.appendFileSync(SINK, JSON.stringify(entry) + "\n");
  } catch {
    /* ignore */
  }
}

function dataFor(input) {
  const p = String(input.path || "");
  const method = String(input.method || "GET").toUpperCase();

  // server.info —— 有必填字段
  if (p.includes("/server")) {
    return {
      runtimeContext: { agentId: AGENT_ID, serverId: SERVER_ID },
      channels: [],
      agents: [],
      humans: [],
    };
  }
  // events / inbox 拉取 —— 从共享 inbox 文件返回待处理消息（harness 投递时写入），返回后清空（模拟已读）。
  if (p.includes("/events") || p.includes("/inbox")) {
    const INBOX = process.env.LARKIN_FAKE_INBOX;
    if (INBOX) {
      try {
        const raw = fs.readFileSync(INBOX, "utf8").trim();
        if (raw) {
          const envelopes = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
          fs.writeFileSync(INBOX, ""); // 清空 = 标记已读
          const last = envelopes[envelopes.length - 1];
          return {
            events: envelopes,
            last_seen_msgId: last?.message_id ?? null,
            last_seen_seq: last?.seq ?? null,
            reply_target: last?.channel_name ?? null,
            pending_notice_ids: [],
            wake_reason: null,
            has_more: false,
          };
        }
      } catch { /* ignore */ }
    }
    return {
      events: [],
      last_seen_msgId: null,
      last_seen_seq: null,
      reply_target: null,
      pending_notice_ids: [],
      wake_reason: null,
      has_more: false,
    };
  }
  // history 读取
  if (p.includes("/history")) {
    return { messages: [] };
  }
  // messages.send —— 判别联合 state:"sent"
  if (p.includes("/send")) {
    return { ok: true, state: "sent", messageId: "fake_" + Date.now(), messageSeq: 1 };
  }
  // channels members
  if (p.includes("/members")) {
    return { channel: { ref: "dm:@harness-user", type: "dm" }, agents: [], humans: [] };
  }
  if (p.includes("/channel")) return { channels: [] };
  // resolve
  if (p.includes("/resolve")) return { message: {} };
  // 其它写操作兜底
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    return { ok: true };
  }
  // 兜底
  return {};
}

const transport = {
  request: async (input) => {
    record({ routeKey: input.routeKey, method: input.method, path: input.path, body: input.body ?? null });
    return { ok: true, status: 200, data: dataFor(input) };
  },
};

module.exports = { transport };
