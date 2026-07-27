// 本地集成测试：用伪造的 Codex / Claude Code / Pi session 验证 Dashboard 的头像、
// Token、Compact 与安全会话摘要。默认跳过：
// RUN_DASHBOARD_SESSION_TEST=1 bun test test/integration/dashboard/dashboard-session.test.mjs

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const enabled = process.env.RUN_DASHBOARD_SESSION_TEST === "1";

test.skipIf(!enabled)("dashboard projects Codex, Claude, and Pi sessions with offline assets", {
  timeout: 30_000,
}, async () => {
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-session-"));
const configDir = path.join(tmp, "config");
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
fs.chmodSync(configDir, 0o700);
const larkinHome = configDir;
const codexHome = path.join(tmp, "codex");
const claudeHome = path.join(tmp, "claude");
const agents = [
  { id: "cli_codexagent", runtime: "codex", model: "gpt-test", session: "codex-session" },
  { id: "cli_claudeagent", runtime: "claude", model: "claude-test", session: "claude-session" },
  { id: "cli_piagent", runtime: "pi", model: "mock/pi-test", session: "pi-session" },
];

const writeJson = (file, data, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2), mode ? { mode } : undefined); };
const writeJsonl = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n"); };

writeJson(path.join(configDir, "config.json"), {
  version: 3,
  serverId: "00000000-0000-0000-0000-000000000001",
  activeAgent: agents[0].id,
  agents: Object.fromEntries(agents.map((agent) => [agent.id, { runtime: agent.runtime, model: agent.model }])),
}, 0o600);

for (const agent of agents) {
  const state = path.join(configDir, "state", "agents", agent.id);
  writeJson(path.join(state, "agent-state.json"), { sessions: { [agent.runtime]: agent.session } });
  writeJson(path.join(state, "bot-identity.json"), { open_id: `ou_${agent.id}`, name: agent.id, avatar_url: `https://s1-imfile.feishucdn.com/static-resource/v1/${agent.id}.png` });
  writeJson(path.join(state, "status.json"), {
    connectedAt: "2026-07-14T00:00:00.000Z",
    activityLog: [{ state: "online", detail: "Process idle", detailKind: "idle", at: "2026-07-14T00:01:00.000Z" }],
    deliverLog: [], recentErrors: [], session: { id: agent.session, runtime: agent.runtime, startedAt: "2026-07-14T00:00:00.000Z", turns: 1 },
    // 故意让实时状态重复累计；Dashboard 应以完整 runtime session 的 1 次原生记录为准。
    compaction: { sessionId: agent.session, active: false, count: 9, lastFinishedAt: "2026-07-14T00:02:00.000Z" },
  });
  writeJsonl(path.join(state, "conversation.ndjson"), [
    { direction: "in", from: "测试用户", target: "#test", wake: true, text: `请测试 ${agent.runtime}`, at: "2026-07-14T00:03:00.000Z" },
    { direction: "out", from: agent.id, target: "#test", wake: false, text: "测试完成", at: "2026-07-14T00:04:00.000Z" },
  ]);
}

writeJsonl(path.join(codexHome, "sessions", "2026", "07", "14", "rollout-codex-session.jsonl"), [
  { type: "session_meta", timestamp: "2026-07-14T00:00:00.000Z" },
  { type: "event_msg", timestamp: "2026-07-14T00:01:00.000Z", payload: { type: "task_started" } },
  { type: "event_msg", timestamp: "2026-07-14T00:02:00.000Z", payload: { type: "context_compacted" } },
  { type: "event_msg", timestamp: "2026-07-14T00:03:00.000Z", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 1200, input_tokens: 1000, cached_input_tokens: 800, output_tokens: 200 }, last_token_usage: { total_tokens: 500 }, model_context_window: 2000 } } },
]);

writeJsonl(path.join(claudeHome, "projects", "test", "claude-session.jsonl"), [
  { type: "user", uuid: "u1", timestamp: "2026-07-14T00:01:00.000Z" },
  { type: "assistant", uuid: "a1", timestamp: "2026-07-14T00:02:00.000Z", message: { id: "m1", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 } } },
  { type: "assistant", uuid: "a2", timestamp: "2026-07-14T00:02:01.000Z", message: { id: "m1", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 } } },
  { type: "system", subtype: "compact_boundary", timestamp: "2026-07-14T00:03:00.000Z" },
]);

const piSessionDir = path.join(configDir, "state", "agents", agents[2].id, "runtime", "pi-sessions");
const piSessionFile = path.join(piSessionDir, "current-session-without-id-in-name.jsonl");
writeJsonl(path.join(piSessionDir, "aaa_pi-session_wrong.jsonl"), [
  { type: "session", id: "not-pi-session", timestamp: "2026-07-14T00:00:00.000Z", cwd: "/tmp" },
  { type: "message", id: "wrong", timestamp: "2026-07-14T00:02:00.000Z", message: { role: "assistant", usage: { totalTokens: 9999 } } },
]);
writeJsonl(piSessionFile, [
  { type: "session", id: "pi-session", timestamp: "2026-07-14T00:00:00.000Z", cwd: "/tmp" },
  { type: "message", id: "p1", timestamp: "2026-07-14T00:01:00.000Z", message: { role: "user", content: "test" } },
  { type: "message", id: "p2", timestamp: "2026-07-14T00:02:00.000Z", message: { role: "assistant", usage: { input: 50, output: 25, cacheRead: 10, cacheWrite: 5, totalTokens: 90 } } },
]);
const piPaddingLine = `${JSON.stringify({ type: "noise", padding: "x".repeat(4096) })}\n`;
const piPaddingBlock = piPaddingLine.repeat(512);
while (fs.statSync(piSessionFile).size <= 33 * 1024 * 1024) fs.appendFileSync(piSessionFile, piPaddingBlock);
fs.appendFileSync(piSessionFile, [
  { type: "message", id: "p2b", timestamp: "2026-07-14T00:02:30.000Z", message: { role: "assistant", usage: { input: 4, output: 3, cacheRead: 2, cacheWrite: 1 } } },
  { type: "compaction", id: "p3", timestamp: "2026-07-14T00:03:00.000Z", tokensBefore: 80, summary: "summary" },
].map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n");

const probe = net.createServer();
await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));

const child = spawn(process.execPath, [path.join(root, "dist/app/dashboard.mjs"), "--port", String(port)], {
  cwd: root,
  env: { ...process.env, LARKIN_CONFIG_DIR: configDir, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

try {
  const deadline = Date.now() + 5000;
  while (!output.includes(`http://localhost:${port}`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!output.includes(`http://localhost:${port}`)) throw new Error("dashboard 未启动：" + output);
  const status = await fetch(`http://localhost:${port}/api/status`).then((response) => response.json());
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (status.packageVersion !== expectedVersion || !status.version.startsWith(`${expectedVersion}+`)) throw new Error(`Dashboard build 版本错误：${status.version}，package=${status.packageVersion}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(status.buildFingerprint || "")) throw new Error("Dashboard build fingerprint 缺失");
  if (status.agents.length !== 3) throw new Error(`预期 3 个 agent，实际 ${status.agents.length}`);
  const byRuntime = Object.fromEntries(status.agents.map((agent) => [agent.runtime, agent]));
  for (const runtime of ["codex", "claude", "pi"]) {
    const agent = byRuntime[runtime];
    if (!agent?.bot || agent.bot.hasAvatar !== true || "avatarUrl" in agent.bot) throw new Error(`${runtime} 应仅投影本地头像能力，不应投影远程头像 URL`);
    if (!agent.session?.usage?.available) throw new Error(`${runtime} usage 不可用`);
    if (agent.session.compaction.count !== 1) throw new Error(`${runtime} compact 计数错误`);
    if (agent.session.compaction.countSource !== "runtime") throw new Error(`${runtime} compact 未采用 runtime 原生记录`);
    if (agent.conversation.length !== 2) throw new Error(`${runtime} 会话摘要错误`);
    if (agent.conversation[0].direction !== "out" || agent.conversation[1].direction !== "in" || agent.conversation[1].wake !== true) {
      throw new Error(`${runtime} conversation 生产字段或倒序投影错误`);
    }
  }
  if (byRuntime.codex.session.usage.cumulativeTokens !== 1200 || Math.round(byRuntime.codex.session.usage.contextPercent) !== 25) throw new Error("Codex Token 解析错误");
  if (byRuntime.claude.session.usage.cumulativeTokens !== 100) throw new Error("Claude 去重 Token 解析错误");
  if (byRuntime.pi.session.usage.cumulativeTokens !== 100 || byRuntime.pi.session.usage.latestTokens !== 10 || byRuntime.pi.session.usage.partial) {
    throw new Error("Pi >32MiB Token 必须精确累计，不能采用 tail partial 或错误 filename substring session");
  }
  if (byRuntime.pi.session.usage.contextWindow !== null || byRuntime.pi.session.usage.contextPercent !== null) {
    throw new Error("Pi 未知模型必须保持 null，由 UI 回退 turns");
  }

  const smallPiRows = (firstTokens) => [
    { type: "session", id: "pi-session", timestamp: "2026-07-14T00:00:00.000Z", cwd: "/tmp" },
    { type: "message", id: "small-a", timestamp: "2026-07-14T00:02:00.000Z", message: { role: "assistant", usage: { totalTokens: firstTokens } } },
    { type: "message", id: "small-b", timestamp: "2026-07-14T00:03:00.000Z", message: { role: "assistant", usage: { totalTokens: 10 } } },
  ];
  writeJsonl(piSessionFile, smallPiRows(40));
  const smallStat = fs.statSync(piSessionFile);
  let refreshed = await fetch(`http://localhost:${port}/api/status`).then((response) => response.json());
  if (refreshed.agents.find((agent) => agent.runtime === "pi").session.usage.cumulativeTokens !== 50) throw new Error("Pi usage cache 未观察到缩短后的 session 文件");

  const replacement = `${piSessionFile}.replacement`;
  writeJsonl(replacement, smallPiRows(30));
  if (fs.statSync(replacement).size !== smallStat.size) throw new Error("Pi same-size cache replacement fixture 无效");
  fs.renameSync(replacement, piSessionFile);
  fs.utimesSync(piSessionFile, smallStat.atime, smallStat.mtime);
  refreshed = await fetch(`http://localhost:${port}/api/status`).then((response) => response.json());
  if (refreshed.agents.find((agent) => agent.runtime === "pi").session.usage.cumulativeTokens !== 40) throw new Error("Pi usage cache 在同 size/mtime 原子替换后返回陈旧累计");

  fs.unlinkSync(piSessionFile);
  refreshed = await fetch(`http://localhost:${port}/api/status`).then((response) => response.json());
  const missingUsage = refreshed.agents.find((agent) => agent.runtime === "pi").session.usage;
  if (missingUsage.available || !/未找到/.test(missingUsage.reason || "")) throw new Error("Pi missing session 不应误匹配 filename substring competitor");

  const piStatusFile = path.join(configDir, "state", "agents", agents[2].id, "status.json");
  const zeroTurnStatus = JSON.parse(fs.readFileSync(piStatusFile, "utf8"));
  zeroTurnStatus.session.turns = 0;
  writeJson(piStatusFile, zeroTurnStatus);
  writeJsonl(piSessionFile, [{ type: "session", id: "pi-session", timestamp: "2026-07-14T00:00:00.000Z", cwd: "/tmp" }]);
  refreshed = await fetch(`http://localhost:${port}/api/status`).then((response) => response.json());
  const zeroTurnSession = refreshed.agents.find((agent) => agent.runtime === "pi").session;
  const zeroTurnUsage = zeroTurnSession.usage;
  if (zeroTurnSession.turns !== 0 || zeroTurnUsage.available || !zeroTurnUsage.fileFound || !/尚无可用 usage/.test(zeroTurnUsage.reason || "")) throw new Error("Pi header-only zero-turn session 应保持 unavailable");
  const pageResponse = await fetch(`http://localhost:${port}/`);
  const html = await pageResponse.text();
  if (pageResponse.headers.get("cache-control") !== "no-store") throw new Error("Dashboard 页面未禁用缓存");
  if (!html.includes("/dashboard-assets/dashboard.css") || !html.includes("/dashboard-assets/dashboard.js")) throw new Error("Dashboard 页面缺少离线 React 资产");
  if (html.includes("feishucdn.com") || html.includes("avatar_url")) throw new Error("Dashboard bootstrap 泄漏远程头像 URL");
  const [scriptResponse, styleResponse] = await Promise.all([
    fetch(`http://localhost:${port}/dashboard-assets/dashboard.js`),
    fetch(`http://localhost:${port}/dashboard-assets/dashboard.css`),
  ]);
  if (!scriptResponse.ok || !/javascript/.test(scriptResponse.headers.get("content-type") || "")) throw new Error("Dashboard React JavaScript 资产不可用");
  if (!styleResponse.ok || !/text\/css/.test(styleResponse.headers.get("content-type") || "")) throw new Error("Dashboard CSS 资产不可用");
  console.log("PASS dashboard session adapters: codex / claude / pi");
  console.log("PASS dashboard production conversation + offline React assets");
} finally {
  child.kill("SIGINT");
  const stopped = child.exitCode !== null || await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    throw new Error("Dashboard 收到 SIGINT 后未在 3 秒内退出");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
});
