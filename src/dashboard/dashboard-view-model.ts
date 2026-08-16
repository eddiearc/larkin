// dashboard 状态投影层：只读本地状态文件（config.json + 各 agent 的 status.json / workspace /
// reminders.json 等），不打飞书 API，产出 /api/status 与 /api/workspace 的 view model。
// HTTP server 与页面模板分别在 dashboard.ts / dashboard-template.ts。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { readJson, readProcessState } from "../platform/process-state.js";
import { isRuntimeReadinessCurrent } from "../app/agent-readiness.js";
import { isAllowedDashboardAvatarUrl } from "./dashboard-avatar.js";
import { collectWorkspaceEntry as collectTypedWorkspaceEntry } from "./dashboard-workspace.js";
import { buildFingerprint, packageVersion } from "../platform/build-info.js";
import * as larkinConfig from "../platform/config.js";

export interface JsonRecord {
  [key: string]: unknown;
  type?: string;
  subtype?: string;
  id?: string;
  uuid?: string;
  timestamp?: string | number;
  at?: string;
  state?: string;
  detail?: string;
  tool?: string;
  from?: string;
  target?: string;
  text?: string;
  title?: string;
  status?: string;
  fireAt?: string;
  repeat?: unknown;
  role?: string;
  wake?: boolean;
  isSidechain?: boolean;
  active?: boolean;
  count?: number;
  startedAt?: string;
  lastFinishedAt?: string;
  connectedAt?: string;
  name?: string;
  provider?: string;
  model?: string;
  modelId?: string;
  open_id?: string;
  avatar_url?: string;
  payload?: JsonRecord;
  info?: JsonRecord;
  message?: JsonRecord;
  usage?: JsonRecord;
  session?: JsonRecord;
  compaction?: JsonRecord;
  sessions?: Record<string, string>;
  sessionId?: string;
  lastTurnAt?: string;
  turns?: number;
  lastCompactAt?: string | number | null;
  compactCount?: number;
  total_token_usage?: JsonRecord;
  last_token_usage?: JsonRecord;
  model_context_window?: unknown;
  total_tokens?: unknown;
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  totalTokens?: unknown;
  input?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  output?: unknown;
  items?: JsonRecord[];
  reminders?: JsonRecord[];
  activityLog?: JsonRecord[];
  deliverLog?: JsonRecord[];
  recentErrors?: JsonRecord[];
  lastActivity?: JsonRecord;
}
export interface DashboardAgent {
  agentId: string;
  name: string;
  runtime: string;
  model: string;
  stateDir: string;
  workspaceDir: string;
  feishuProfile: string;
  effort?: string;
  noMentionChats?: string[];
}
export interface DashboardConfig {
  larkinHome: string;
  agents: Record<string, DashboardAgent>;
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
export const PACKAGE_VERSION = packageVersion(ROOT);
export const DASHBOARD_BUILD_FINGERPRINT = buildFingerprint(ROOT);
export const DASHBOARD_BUILD_VERSION = `${PACKAGE_VERSION}+${DASHBOARD_BUILD_FINGERPRINT.slice("sha256:".length, "sha256:".length + 12)}`;

interface DaemonHealthProjection {
  state: "dead" | "unknown" | "mismatch" | "owned";
  reason: string | null;
  running: boolean;
  startedAt?: unknown;
  agents: string[];
}

interface AgentConnectionInput {
  agentId: string;
  connectedAt?: unknown;
  inboundVerifiedAt?: unknown;
}

function finiteTime(value: unknown): number | null {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function projectAgentHealth(agent: AgentConnectionInput, daemon: DaemonHealthProjection) {
  const connectedAt = finiteTime(agent.connectedAt);
  const daemonStartedAt = finiteTime(daemon.startedAt);
  const assigned = daemon.agents.includes(agent.agentId);
  if (daemon.state === "unknown" || daemon.state === "mismatch") {
    return {
      running: false,
      connectedInThisRun: false,
      inboundVerifiedInThisRun: false,
      inboundVerifiedInThisConnection: false,
      connection: { state: "unknown", reason: `daemon ${daemon.state}: ${daemon.reason || "process state unavailable"}` },
      inbound: { state: "unavailable", reason: "channel connection is not currently verifiable" },
      issue: false,
    };
  }
  if (daemon.state === "owned" && daemonStartedAt === null) {
    return {
      running: false,
      connectedInThisRun: false,
      inboundVerifiedInThisRun: false,
      inboundVerifiedInThisConnection: false,
      connection: { state: "unknown", reason: "owned daemon has no valid startedAt connection epoch" },
      inbound: { state: "unavailable", reason: "daemon connection epoch is unavailable" },
      issue: false,
    };
  }
  if (!daemon.running || !assigned || connectedAt === null || daemonStartedAt === null || connectedAt < daemonStartedAt - 1_000) {
    const reason = !daemon.running
      ? `daemon ${daemon.state}: ${daemon.reason || "not running"}`
      : !assigned
        ? "Agent is not assigned to the running daemon"
        : "no connection evidence from the current daemon run";
    return {
      running: false,
      connectedInThisRun: false,
      inboundVerifiedInThisRun: false,
      inboundVerifiedInThisConnection: false,
      connection: { state: "disconnected", reason },
      inbound: { state: "unavailable", reason: "channel is disconnected" },
      issue: true,
    };
  }
  const inboundAt = finiteTime(agent.inboundVerifiedAt);
  const verified = inboundAt !== null && inboundAt >= connectedAt;
  return {
    running: true,
    connectedInThisRun: true,
    inboundVerifiedInThisRun: verified,
    inboundVerifiedInThisConnection: verified,
    connection: { state: "connected", reason: "current daemon has current channel connection evidence" },
    inbound: verified
      ? { state: "verified", reason: "real inbound observed on the current connection" }
      : { state: "pending", reason: "no real inbound observed on the current connection yet" },
    issue: false,
  };
}

export function loadDashboardConfig(): { config: DashboardConfig; configDir: string } {
  return larkinConfig.loadConfig(process.env);
}

function ageSec(iso: unknown): number | null {
  const time = finiteTime(iso);
  return time === null ? null : Math.max(0, Math.round((Date.now() - time) / 1000));
}

// 指示灯「卡住」判定：待摘条目存在超过 3 分钟。正常一轮点上→执行→摘除应远快于此；
// 超过说明摘除路径可能挂了（曾发生：activity 帧丢失、larkApi 静默失败）。阈值宽松，避免误报慢 turn。
const EYE_STUCK_SEC = 180;
const SESSION_FILE_MAX_BYTES = 32 * 1024 * 1024;
const SESSION_FILE_CACHE_TTL_MS = 30_000;
const SESSION_USAGE_CACHE_TTL_MS = 30_000;
const SESSION_NDJSON_MAX_LINE_BYTES = 8 * 1024 * 1024;
const SESSION_FILE_CACHE = new Map<string, { file: string; expiresAt: number }>();
const SESSION_USAGE_CACHE = new Map<string, { value: JsonRecord; expiresAt: number }>();

function readNdjson(file: string, maxBytes = SESSION_FILE_MAX_BYTES): { rows: JsonRecord[]; stat: fs.Stats | null; partial: boolean } {
  try {
    const stat = fs.statSync(file);
    const readBytes = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(readBytes);
    try { fs.readSync(fd, buffer, 0, readBytes, stat.size - readBytes); } finally { fs.closeSync(fd); }
    let text = buffer.toString("utf8");
    if (readBytes < stat.size) text = text.slice(text.indexOf("\n") + 1);
    return {
      rows: text.split("\n").filter(Boolean).flatMap((line): JsonRecord[] => { try { return [JSON.parse(line) as JsonRecord]; } catch { return []; } }),
      stat,
      partial: readBytes < stat.size,
    };
  } catch { return { rows: [], stat: null, partial: false }; }
}

function firstNdjsonRecord(file: string): JsonRecord | null {
  try {
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    try { bytes = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
    const first = buffer.subarray(0, bytes).toString("utf8").split("\n", 1)[0];
    return first ? JSON.parse(first) as JsonRecord : null;
  } catch { return null; }
}

function findFileRecursive(root: string, predicate: (name: string, file: string) => boolean, budget = 20_000): string | null {
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < budget) {
    const dir = stack.pop()!;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen >= budget) break;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && predicate(entry.name, full)) return full;
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) stack.push(full);
    }
  }
  return null;
}

function sessionFileFor(runtime: string, sessionId: string, agent: DashboardAgent): string | null {
  if (!runtime || !sessionId) return null;
  const key = `${runtime}:${sessionId}:${agent.agentId}`;
  const cached = SESSION_FILE_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now() && fs.existsSync(cached.file)
    && (runtime !== "pi" || firstNdjsonRecord(cached.file)?.id === sessionId)) return cached.file;
  SESSION_FILE_CACHE.delete(key);
  const home = os.homedir();
  const roots: string[] = runtime === "codex"
    ? [path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "sessions")]
    : runtime === "claude"
      ? [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "projects")]
      : runtime === "pi"
        ? [path.join(agent.stateDir, "runtime", "pi-sessions")]
        : [];
  const file = roots.map((root) => findFileRecursive(root, (name, candidate) => name.endsWith(".jsonl")
    && (runtime === "pi" ? firstNdjsonRecord(candidate)?.id === sessionId : name.includes(sessionId)))).find(Boolean) || null;
  if (file) {
    SESSION_FILE_CACHE.set(key, { file, expiresAt: Date.now() + SESSION_FILE_CACHE_TTL_MS });
    if (SESSION_FILE_CACHE.size > 100) {
      const oldestKey = SESSION_FILE_CACHE.keys().next().value;
      if (oldestKey) SESSION_FILE_CACHE.delete(oldestKey);
    }
  }
  return file;
}

function number(value: unknown): number { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function compactMoments(values: unknown[]): number[] {
  return values.map((value) => new Date(String(value)).getTime()).filter(Number.isFinite).sort((a, b) => a - b)
    .filter((value, index, all) => index === 0 || value - all[index - 1] > 5000);
}

function streamNdjson(file: string, visit: (row: JsonRecord) => void): { exact: boolean } {
  const fd = fs.openSync(file, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.alloc(64 * 1024);
  let pending = "";
  let discardingOversizedLine = false;
  let exact = true;
  const consume = (input: string): void => {
    let text = input;
    while (text.length) {
      if (discardingOversizedLine) {
        const newline = text.indexOf("\n");
        if (newline < 0) return;
        discardingOversizedLine = false;
        text = text.slice(newline + 1);
        continue;
      }
      const newline = text.indexOf("\n");
      if (newline < 0) {
        pending += text;
        if (Buffer.byteLength(pending) > SESSION_NDJSON_MAX_LINE_BYTES) {
          pending = "";
          discardingOversizedLine = true;
          exact = false;
        }
        return;
      }
      const line = pending + text.slice(0, newline);
      pending = "";
      text = text.slice(newline + 1);
      if (!line) continue;
      try { visit(JSON.parse(line) as JsonRecord); } catch { exact = false; }
    }
  };
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      consume(decoder.write(buffer.subarray(0, bytes)));
    }
    consume(decoder.end());
    if (pending) {
      try { visit(JSON.parse(pending) as JsonRecord); } catch { exact = false; }
    }
    if (discardingOversizedLine) exact = false;
    return { exact };
  } finally { fs.closeSync(fd); }
}

function cacheSessionUsage(key: string, value: JsonRecord): JsonRecord {
  SESSION_USAGE_CACHE.set(key, { value, expiresAt: Date.now() + SESSION_USAGE_CACHE_TTL_MS });
  if (SESSION_USAGE_CACHE.size > 100) {
    const oldestKey = SESSION_USAGE_CACHE.keys().next().value;
    if (oldestKey) SESSION_USAGE_CACHE.delete(oldestKey);
  }
  return value;
}

export interface PiContextCatalogModel {
  id: string;
  contextWindow?: unknown;
}

export function parsePiSessionUsage(file: string, catalog: readonly PiContextCatalogModel[]): JsonRecord {
  const tokenTotal = (usage: JsonRecord | undefined): number => number(usage?.totalTokens)
    || (number(usage?.input) + number(usage?.cacheRead) + number(usage?.cacheWrite) + number(usage?.output));
  const contextWindows = new Map(catalog.flatMap((model): Array<[string, number]> => {
    const contextWindow = Number(model.contextWindow);
    return model.id && Number.isFinite(contextWindow) && contextWindow > 0 ? [[model.id, contextWindow]] : [];
  }));
  let cumulativeTokens = 0;
  let latestTokens = 0;
  let latestTimestamp: string | number | undefined;
  let turns = 0;
  let compactCount = 0;
  let lastCompactAt: string | number | null = null;
  let assistantUsageRows = 0;
  let currentModel: string | null = null;
  const streamed = streamNdjson(file, (row) => {
    if (row.type === "model_change" && typeof row.provider === "string" && typeof row.modelId === "string") {
      currentModel = `${row.provider}/${row.modelId}`;
    }
    if (row.type === "message" && row.message?.role === "user") turns += 1;
    if (row.type === "message" && row.message?.role === "assistant") {
      if (typeof row.message.provider === "string" && typeof row.message.model === "string") {
        currentModel = `${row.message.provider}/${row.message.model}`;
      }
      if (row.message.usage) {
        latestTokens = tokenTotal(row.message.usage);
        cumulativeTokens += latestTokens;
        latestTimestamp = row.timestamp;
        assistantUsageRows += 1;
      }
    }
    if (row.type === "compaction") {
      compactCount += 1;
      lastCompactAt = row.timestamp || null;
    }
  });
  if (!streamed.exact) return {
    available: false, source: "pi", fileFound: true, partial: true,
    reason: "session 记录存在无法解析或超大行，无法精确累计 usage",
  };
  if (!assistantUsageRows) return { available: false, source: "pi", fileFound: true, partial: false, reason: "当前 session 尚无可用 usage" };
  const contextWindow = currentModel ? contextWindows.get(currentModel) ?? null : null;
  return {
    available: true, source: "pi", fileFound: true, partial: false,
    cumulativeTokens, latestTokens, contextWindow,
    contextPercent: contextWindow ? Math.min(100, latestTokens / contextWindow * 100) : null,
    turns, compactCount, lastCompactAt,
    updatedAt: latestTimestamp ? new Date(latestTimestamp).toISOString() : null,
  };
}

function collectRuntimeUsage(runtime: string, sessionId: string, agent: DashboardAgent, piCatalog: readonly PiContextCatalogModel[] = []): JsonRecord {
  const file = sessionFileFor(runtime, sessionId, agent);
  if (!file) return { available: false, source: runtime, reason: "未找到本机 session 记录" };
  let stat;
  try { stat = fs.statSync(file); } catch { return { available: false, source: runtime, reason: "本机 session 记录暂不可读" }; }
  const piCatalogKey = runtime === "pi" ? piCatalog.map((model) => `${model.id}:${String(model.contextWindow ?? "")}`).sort().join(",") : "";
  const cacheKey = `${runtime}:${sessionId}:${file}:${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}:${piCatalogKey}`;
  const cached = SESSION_USAGE_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) SESSION_USAGE_CACHE.delete(cacheKey);
  const { rows, partial } = runtime === "pi" ? { rows: [] as JsonRecord[], partial: false } : readNdjson(file);
  const base = { available: true, source: runtime, fileFound: true, partial, startedAt: stat.birthtime.toISOString() };
  let result;
  if (runtime === "codex") {
    const tokenRows = rows.filter((row) => row.type === "event_msg" && row.payload?.type === "token_count" && row.payload.info);
    const latest = tokenRows[tokenRows.length - 1];
    const total = latest?.payload?.info?.total_token_usage || {};
    const last = latest?.payload?.info?.last_token_usage || {};
    const contextWindow = number(latest?.payload?.info?.model_context_window) || null;
    const latestTokens = number(last.total_tokens);
    const compactAt = compactMoments(rows.filter((row) => row.type === "event_msg" && row.payload?.type === "context_compacted").map((row) => row.timestamp));
    result = {
      ...base,
      cumulativeTokens: number(total.total_tokens), inputTokens: number(total.input_tokens), cachedTokens: number(total.cached_input_tokens),
      outputTokens: number(total.output_tokens), reasoningTokens: number(total.reasoning_output_tokens), latestTokens, contextWindow,
      contextPercent: contextWindow ? Math.min(100, latestTokens / contextWindow * 100) : null,
      turns: rows.filter((row) => row.type === "event_msg" && row.payload?.type === "task_started").length,
      compactCount: compactAt.length, lastCompactAt: compactAt.length ? new Date(compactAt.at(-1)!).toISOString() : null,
      updatedAt: latest?.timestamp || stat.mtime.toISOString(),
    };
  } else if (runtime === "claude") {
    const byMessage = new Map();
    for (const row of rows) if (row.type === "assistant" && row.message?.usage) byMessage.set(row.message.id || row.uuid, row);
    const messages = [...byMessage.values()];
    const usageOf = (row: JsonRecord | undefined): JsonRecord => row?.message?.usage || {};
    const tokenTotal = (usage: JsonRecord): number => number(usage.input_tokens) + number(usage.cache_creation_input_tokens) + number(usage.cache_read_input_tokens) + number(usage.output_tokens);
    const latest = messages.at(-1);
    const totals = messages.reduce((sum, row) => sum + tokenTotal(usageOf(row)), 0);
    const compactAt = compactMoments(rows.filter((row) => row.type === "system" && row.subtype === "compact_boundary").map((row) => row.timestamp));
    result = {
      ...base, cumulativeTokens: totals, latestTokens: tokenTotal(usageOf(latest)), contextWindow: null, contextPercent: null,
      turns: new Set(rows.filter((row) => row.type === "user" && !row.isSidechain).map((row) => row.uuid)).size,
      compactCount: compactAt.length, lastCompactAt: compactAt.length ? new Date(compactAt.at(-1)!).toISOString() : null,
      updatedAt: latest?.timestamp || stat.mtime.toISOString(),
    };
  } else if (runtime === "pi") {
    const parsed = parsePiSessionUsage(file, piCatalog);
    if (!parsed.available) return cacheSessionUsage(cacheKey, { ...base, ...parsed });
    result = { ...base, ...parsed, updatedAt: parsed.updatedAt || stat.mtime.toISOString() };
  } else result = { available: false, source: runtime, reason: "该 runtime 暂无用量适配器" };
  return cacheSessionUsage(cacheKey, result);
}

function readConversation(file: string, limit = 60): JsonRecord[] {
  return readNdjson(file, 512 * 1024).rows.slice(-limit).reverse();
}

export function collectWorkspaceEntry(agentId: string | null, requestedPath: string): unknown {
  const { config } = larkinConfig.loadConfig(process.env);
  return collectTypedWorkspaceEntry(config, agentId || "", requestedPath);
}

export function resolveDashboardAvatarSource(agentId: string): string | null {
  const { config } = larkinConfig.loadConfig(process.env);
  const agent = config.agents?.[agentId];
  if (!agent) return null;
  const identity = readJson(path.join(agent.stateDir, "bot-identity.json"), null) as JsonRecord | null;
  return isAllowedDashboardAvatarUrl(identity?.avatar_url) ? identity.avatar_url : null;
}

function meaningfulTimelineText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function projectStatusTimeline(status: JsonRecord) {
  const activityLog: JsonRecord[] = Array.isArray(status.activityLog) ? status.activityLog : [];
  // deliverLog intentionally contains both runtime delivery lifecycle records and the richer
  // inbound-message projection. Only the latter has a sender/target and belongs in the UI.
  const deliverLog: JsonRecord[] = (Array.isArray(status.deliverLog) ? status.deliverLog : [])
    .filter((entry) => meaningfulTimelineText(entry.from) || meaningfulTimelineText(entry.target));
  const recentErrors: JsonRecord[] = Array.isArray(status.recentErrors) ? status.recentErrors : [];
  const durableActivity = activityLog.length ? activityLog[activityLog.length - 1] : null;
  const lastActivity = status.lastActivity && typeof status.lastActivity === "object" && !Array.isArray(status.lastActivity)
    ? status.lastActivity
    : durableActivity;
  const lastDeliver = deliverLog.length ? deliverLog[deliverLog.length - 1] : null;
  const feed = [
    ...deliverLog.map((d) => ({ at: d.at, kind: "deliver", from: d.from, target: d.target })),
    ...activityLog.map((s) => ({ at: s.at, kind: "activity", state: s.state, detail: s.detail, tool: s.tool || null })),
    ...recentErrors.map((e) => ({ at: e.at, kind: "error", text: e.text })),
  ].sort((x, y) => new Date(String(y.at)).getTime() - new Date(String(x.at)).getTime()).slice(0, 30);
  return { activityLog, deliverLog, recentErrors, lastActivity, lastDeliver, feed };
}

export type PiStatusModelResolver = {
  resolve(input: { agentDir?: string; agentId: string; cwd: string }): Promise<PiContextCatalogModel[]>;
};

async function collectAgentStatus(a: DashboardAgent, configDir: string, daemonStartedAt: unknown, piModelResolver?: PiStatusModelResolver) {
  const dir = a.stateDir;
  const botIdentity = readJson(path.join(dir, "bot-identity.json"), null) as JsonRecord | null;
  const status = readJson(path.join(dir, "status.json"), {}) as JsonRecord;
  const pending: JsonRecord[] = (readJson(path.join(dir, "feishu-pending-react.json"), { items: [] }) as JsonRecord)?.items || [];
  const map = readJson(path.join(dir, "feishu-map.json"), {}) as JsonRecord;
  const reminders: JsonRecord[] = (readJson(path.join(dir, "reminders.json"), { reminders: [] }) as JsonRecord)?.reminders || [];
  const agentState = readJson(path.join(dir, "agent-state.json"), { sessions: {} }) as JsonRecord;
  const sessionId = agentState.sessions?.[a.runtime] || status.session?.id || null;
  let piCatalog: readonly PiContextCatalogModel[] = [];
  if (a.runtime === "pi" && piModelResolver) {
    try {
      piCatalog = await piModelResolver.resolve({
        agentId: a.agentId,
        cwd: a.workspaceDir,
        ...(process.env.PI_CODING_AGENT_DIR ? { agentDir: process.env.PI_CODING_AGENT_DIR } : {}),
      });
    } catch { /* unknown or unavailable catalog keeps the explicit turns fallback */ }
  }
  const usage = sessionId ? collectRuntimeUsage(a.runtime, sessionId, a, piCatalog) : { available: false, source: a.runtime, reason: "尚未建立 session" };
  const statusCompaction = status.compaction?.sessionId && status.compaction.sessionId !== sessionId ? {} : (status.compaction || {});
  const statusCompactAt = statusCompaction.lastFinishedAt || null;
  const usageCompactAt = usage.lastCompactAt || null;
  const lastCompactAt = [statusCompactAt, usageCompactAt].filter(Boolean).sort((x, y) => new Date(String(y)).getTime() - new Date(String(x)).getTime())[0] || null;
  // runtime 原生 session 是 Compact 的最终事实来源。status 的 compacting_context 是过程状态，
  // 同一次压缩可能上报多帧；历史版本曾把这些帧重复累计。原生文件可读时不能再取两者 max。
  const nativeCompactCount = usage.available && Number.isFinite(Number(usage.compactCount)) ? Number(usage.compactCount) : null;
  const compaction = {
    active: !!statusCompaction.active,
    count: nativeCompactCount ?? Number(statusCompaction.count || 0),
    countSource: nativeCompactCount !== null ? "runtime" : "status",
    startedAt: statusCompaction.startedAt || null,
    lastFinishedAt: lastCompactAt,
  };
  const conversation = readConversation(path.join(dir, "conversation.ndjson"));
  const knownChats = new Set(Object.values(map).filter((v) => typeof v === "string" && v.startsWith("oc_"))).size;
  const oldestPendingSec = pending.length ? Math.max(...pending.map((p) => ageSec(p.at) ?? 0)) : null;
  let eyeAgeSec = oldestPendingSec;
  if (pending.length && eyeAgeSec == null) {
    try { eyeAgeSec = Math.round((Date.now() - fs.statSync(path.join(dir, "feishu-pending-react.json")).mtimeMs) / 1000); } catch { /* 忽略 */ }
  }

  // 本 agent 专属时间线：三路历史合并按时间倒序，不是全局一条汇总——每个 agent 只看自己的故事。
  const { recentErrors, lastActivity, lastDeliver, feed } = projectStatusTimeline(status);
  const statusReadiness = status.runtimeReadiness as { state?: "missing" | "unauthenticated" | "incompatible" | "ready" | "unavailable"; observedAt?: string; [key: string]: unknown } | undefined;
  const sessionStartedAt = finiteTime(status.session?.startedAt);
  const daemonEpoch = finiteTime(daemonStartedAt);
  const sessionCurrent = sessionStartedAt !== null && daemonEpoch !== null && sessionStartedAt >= daemonEpoch;
  const runtimeReadiness = sessionCurrent && isRuntimeReadinessCurrent(statusReadiness, daemonStartedAt)
    || statusReadiness?.state !== "ready"
    ? statusReadiness || null
    : { ...statusReadiness, state: "unavailable", reason: "Runtime readiness evidence is stale for the current daemon epoch." };

  // 提醒：不只给数量，给完整列表——待触发按最近到期优先排前面，已触发/已取消按最近的排在后面。
  const pendingReminders = reminders.filter((r) => r.status === "scheduled" || r.status === "pending")
    .sort((x: JsonRecord, y: JsonRecord) => new Date(String(x.fireAt)).getTime() - new Date(String(y.fireAt)).getTime());
  const terminalReminderStates = new Set(["fired", "canceled", "cancelled", "failed"]);
  const doneReminders = reminders.filter((r) => terminalReminderStates.has(String(r.status)))
    .sort((x: JsonRecord, y: JsonRecord) => new Date(String(y.fireAt)).getTime() - new Date(String(x.fireAt)).getTime()).slice(0, 10);
  const remindersList = [...pendingReminders, ...doneReminders].map((r) => ({
    title: r.title, status: r.status, fireAt: r.fireAt, repeat: r.repeat || null,
  }));

  return {
    agentId: a.agentId,
    name: a.name,
    displayName: (botIdentity && botIdentity.name) || a.name,
    runtime: a.runtime,
    model: status.session?.runtime === a.runtime && status.session?.model ? String(status.session.model) : a.model,
    effort: status.session?.runtime === a.runtime && status.session?.reasoningEffort ? String(status.session.reasoningEffort) : a.effort || null,
    runtimeReadiness,
    credentialReady: fs.existsSync(path.join(configDir, "bots", `${a.feishuProfile}.json`)),
    bot: botIdentity ? {
      name: botIdentity.name,
      openId: botIdentity.open_id,
      hasAvatar: isAllowedDashboardAvatarUrl(botIdentity.avatar_url),
    } : null,
    connectedAt: status.connectedAt || null,
    connectedAgeSec: status.connectedAt ? ageSec(status.connectedAt) : null,
    inboundVerifiedAt: status.inboundVerifiedAt || null,
    inboundVerifiedAgeSec: status.inboundVerifiedAt ? ageSec(status.inboundVerifiedAt) : null,
    lastActivity: lastActivity ? { ...lastActivity, ageSec: ageSec(lastActivity.at) } : null,
    lastDeliver: lastDeliver ? { ...lastDeliver, ageSec: ageSec(lastDeliver.at) } : null,
    recentErrors: recentErrors.slice(-5).reverse(),
    eyeIndicator: { pendingCount: pending.length, oldestAgeSec: eyeAgeSec, stuck: pending.length > 0 && eyeAgeSec != null && eyeAgeSec > EYE_STUCK_SEC },
    knownChats,
    activeReminders: pendingReminders.length,
    remindersList,
    sessions: agentState.sessions || {},
    session: sessionId ? {
      id: sessionId,
      runtime: a.runtime,
      startedAt: usage.startedAt || (status.session?.id === sessionId ? status.session.startedAt : null) || null,
      ageSec: ageSec(usage.startedAt || (status.session?.id === sessionId ? status.session.startedAt : null)),
      lastTurnAt: status.session?.lastTurnAt || null,
      turns: Math.max(Number(status.session?.turns || 0), Number(usage.turns || 0)),
      usage,
      compaction,
    } : null,
    conversation,
    noMentionChats: Array.isArray(a.noMentionChats) ? a.noMentionChats.length : 0,
    feed,
  };
}

export async function collectStatus(options: { piModelResolver?: PiStatusModelResolver } = {}) {
  const { config, configDir } = larkinConfig.loadConfig(process.env);
  const agents: DashboardAgent[] = Object.values(config.agents || {});
  const daemonStatus = readProcessState(config.larkinHome).daemon;
  const daemon = {
    running: daemonStatus.state === "owned",
    state: daemonStatus.state,
    reason: daemonStatus.reason,
    alive: daemonStatus.alive,
    pid: daemonStatus?.pid || null,
    startedAt: daemonStatus?.startedAt || null,
    epochValid: daemonStatus.state === "owned" && finiteTime(daemonStatus?.startedAt) !== null,
    epochReason: daemonStatus.state === "owned" && finiteTime(daemonStatus?.startedAt) === null ? "owned daemon status lacks a valid startedAt epoch" : null,
    uptimeSec: daemonStatus?.startedAt ? ageSec(daemonStatus.startedAt) : null,
    agents: Array.isArray(daemonStatus?.agents) ? daemonStatus.agents.filter((id): id is string => typeof id === "string") : [],
  };
  const statuses = (await Promise.all(agents.map((a) => collectAgentStatus(a, configDir, daemon.startedAt, options.piModelResolver)))).map((agent) => {
    return { ...agent, ...projectAgentHealth(agent, daemon) };
  });
  return {
    version: DASHBOARD_BUILD_VERSION,
    packageVersion: PACKAGE_VERSION,
    buildFingerprint: DASHBOARD_BUILD_FINGERPRINT,
    generatedAt: new Date().toISOString(),
    daemon,
    agents: statuses,
  };
}
