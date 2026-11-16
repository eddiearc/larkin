import type http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { configApplyState, loadConfig, loadRuntimeModels, markConfigApplied, mutateConfig, resolveMentionPolicy, runtimeConfigSignature, safeConfigView, type AgentSandbox, type ConfigMutation } from "../platform/config.js";
import { requestAgentUpsert } from "../app/local-control.js";
import { discoverClaudeModelCatalog, type DiscoverClaudeCatalogOptions } from "../runtime/claude-model-catalog.js";
import { discoverCodexModelCatalog, type DiscoverCodexCatalogOptions } from "../runtime/codex-model-catalog.js";
import { discoverPiModelCatalog, type DiscoverPiCatalogOptions } from "../runtime/pi-model-catalog.js";
import { managedOfficialLarkCli } from "../app/agent-lark-cli-workspace.js";
import { RUNTIME_OPTIONS, isUserRuntime } from "../runtime/user-runtime.js";
import { probeNativeRuntimeReadiness, RuntimePrerequisiteError } from "../runtime/runtime-readiness.js";

type Env = Record<string, string | undefined>;
type LarkJsonCall = { command: string; args: string[]; env: Env; maxBuffer: number; timeout: number };
type ChatDirectoryInput = { agentId: string; chatIds: string[]; configDir: string; profile: string };
type ClaudeModelDirectoryInput = { agentId: string; cwd: string; env: Env };
type CodexModelDirectoryInput = { agentId: string; cwd: string; env: Env };
type PiModelDirectoryInput = {
  agentId: string;
  cwd: string;
  command?: string;
  commandArgs?: readonly string[];
};

export type ChatDirectoryResolver = { resolve(input: ChatDirectoryInput): Promise<Record<string, string>> };
export type ClaudeModelDirectoryResolver = { resolve(input: ClaudeModelDirectoryInput): Promise<Array<Record<string, unknown> & { id: string; label: string }>> };
export type CodexModelDirectoryResolver = { resolve(input: CodexModelDirectoryInput): Promise<Array<Record<string, unknown> & { id: string; label: string }>> };
export type PiModelDirectoryResolver = {
  resolve(input: PiModelDirectoryInput): Promise<Array<Record<string, unknown> & { id: string; label: string }>>;
  invalidate?(agentId?: string): void;
};

type KnownChat = { chatId: string; displayName: string | null; kind: "group" | "direct" };

function pruneCache<T>(cache: Map<string, T>, expired: (value: T) => boolean, maxEntries: number): void {
  for (const [key, value] of cache) if (expired(value)) cache.delete(key);
  while (cache.size >= maxEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function knownChatAliases(map: Record<string, unknown>, configuredChatIds: Iterable<string>): Record<string, KnownChat> {
  const aliases = new Map<string, string[]>();
  for (const [alias, value] of Object.entries(map)) {
    if (typeof value !== "string" || !/^oc_[A-Za-z0-9_-]+$/.test(value)) continue;
    const current = aliases.get(value) || [];
    current.push(alias);
    aliases.set(value, current);
  }
  for (const chatId of configuredChatIds) if (!aliases.has(chatId)) aliases.set(chatId, []);
  return Object.fromEntries([...aliases.entries()].map(([chatId, values]) => {
    const groupAliases = values.filter((value) => value.startsWith("#") && !value.includes(":"));
    const readable = groupAliases
      .map((value) => value.slice(1).trim())
      .filter((value) => value.length > 0 && !/^[a-f0-9]{11}$/i.test(value))
      .sort((left, right) => left.length - right.length || left.localeCompare(right, "zh-CN"))[0] || null;
    const directOnly = values.some((value) => value.startsWith("dm:")) && groupAliases.length === 0;
    return [chatId, { chatId, displayName: readable, kind: directOnly ? "direct" : "group" }];
  }));
}

function cleanChatName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, "")
    .replace(/[\t\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || null;
}

function readSavedChatNames(file: string): Record<string, string> {
  try {
    if (fs.statSync(file).size > 256 * 1024) return {};
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([chatId, name]) => {
      const cleaned = cleanChatName(name);
      return cleaned ? [[chatId, cleaned]] : [];
    }));
  } catch { return {}; }
}

function saveChatNames(file: string, names: Record<string, string>): void {
  try {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(names)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch { /* names are a convenience; the next refresh retries */ }
}

function chatList(value: unknown): Array<{ chatId: string; name: string }> {
  const rows = (value as { data?: { chats?: unknown[] } } | null)?.data?.chats;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((item) => {
    const row = item as { chat_id?: unknown; name?: unknown };
    const name = cleanChatName(row.name);
    return typeof row.chat_id === "string" && name ? [{ chatId: row.chat_id, name }] : [];
  });
}

function chatName(value: unknown): string | null {
  const data = (value as { data?: { name?: unknown; chat?: { name?: unknown } } } | null)?.data;
  return cleanChatName(data?.name ?? data?.chat?.name);
}

function assertLarkSuccess(value: unknown): void {
  if ((value as { ok?: unknown } | null)?.ok === false) throw new Error("directory unavailable");
}

async function runLarkJson(call: LarkJsonCall): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    execFile(call.command, call.args, { env: call.env, maxBuffer: call.maxBuffer, timeout: call.timeout }, (error, stdout) => {
      if (error) return reject(new Error("directory unavailable"));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("directory unavailable")); }
    });
  });
}

export function createChatDirectoryResolver(options: {
  maxStaleMs?: number;
  managedCli?: typeof managedOfficialLarkCli;
  now?: () => number;
  runLarkJson?: (call: LarkJsonCall) => Promise<unknown>;
  ttlMs?: number;
} = {}): ChatDirectoryResolver {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const maxStaleMs = options.maxStaleMs ?? 60_000;
  const execute = options.runLarkJson ?? runLarkJson;
  const resolveManagedCli = options.managedCli ?? managedOfficialLarkCli;
  const cache = new Map<string, { expiresAt: number; staleUntil: number; value: Record<string, string> }>();
  const inFlight = new Map<string, Promise<Record<string, string>>>();
  return {
    async resolve(input) {
      const chatIds = [...new Set(input.chatIds)].sort();
      if (chatIds.length === 0) return {};
      const key = [input.agentId, input.profile, input.configDir, ...chatIds].join("\u0000");
      pruneCache(cache, (entry) => now() > entry.staleUntil, 128);
      const cached = cache.get(key);
      if (cached && now() < cached.expiresAt) return cached.value;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = (async () => {
          const managed = resolveManagedCli({ agentId: input.agentId, feishuAppId: input.agentId,
            stateDir: path.dirname(input.configDir), larkConfigDir: input.configDir }, process.env);
          const common = {
            command: managed.command.command,
            env: managed.env,
            maxBuffer: 1024 * 1024,
            timeout: 15_000,
          };
          const names: Record<string, string> = {};
          const requested = new Set(chatIds);
          let listSucceeded = false;
          try {
            const listed = await execute({ ...common, args: [...managed.command.argsPrefix, "im", "+chat-list", "--as", "bot", "--page-size", "100", "--json"] });
            assertLarkSuccess(listed);
            listSucceeded = true;
            for (const chat of chatList(listed)) if (requested.has(chat.chatId)) names[chat.chatId] = chat.name;
          } catch { /* fall back to isolated per-chat reads */ }
          let detailSucceeded = false;
          for (const chatId of chatIds) {
            if (names[chatId]) continue;
            try {
              const detail = await execute({ ...common, args: [...managed.command.argsPrefix, "im", "chats", "get", "--chat-id", chatId, "--as", "bot", "--json"] });
              assertLarkSuccess(detail);
              detailSucceeded = true;
              const name = chatName(detail);
              if (name) names[chatId] = name;
            } catch { /* one deleted or inaccessible group must not erase other resolved names */ }
          }
          if (!listSucceeded && !detailSucceeded) throw new Error("directory unavailable");
          const expiresAt = now() + ttlMs;
          cache.set(key, { expiresAt, staleUntil: expiresAt + maxStaleMs, value: names });
          return names;
        })();
        inFlight.set(key, pending);
        void pending.finally(() => inFlight.delete(key)).catch(() => undefined);
      }
      try { return await pending; } catch {
        if (cached && now() <= cached.staleUntil) return cached.value;
        throw new Error("directory unavailable");
      }
    },
  };
}

export function createPiModelDirectoryResolver(options: {
  discoverPiModelCatalog?: (options: DiscoverPiCatalogOptions) => ReturnType<typeof discoverPiModelCatalog>;
  negativeTtlMs?: number;
  now?: () => number;
  ttlMs?: number;
} = {}): PiModelDirectoryResolver {
  const discover = options.discoverPiModelCatalog ?? discoverPiModelCatalog;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  // Dashboard polls status every 3s. A short negative cache avoids repeating expensive local
  // catalog/auth discovery on every poll while still recovering promptly after login/config fixes.
  const negativeTtlMs = options.negativeTtlMs ?? 30_000;
  const cache = new Map<string, { expiresAt: number; value: Array<Record<string, unknown> & { id: string; label: string }> }>();
  const failures = new Map<string, { expiresAt: number }>();
  const inFlight = new Map<string, Promise<Array<Record<string, unknown> & { id: string; label: string }>>>();
  const generations = new Map<string, number>();
  // 单调序号：targeted 后再 global 时，in-flight 的 started 不能与新 generation 相等。
  let seq = 0;
  let baseline = 0;
  const generationOf = (agentId: string) => Math.max(baseline, generations.get(agentId) ?? 0);
  const dropPrefixed = <T>(store: Map<string, T>, agentId?: string): void => {
    if (!agentId) { store.clear(); return; }
    const prefix = `${agentId}\u0000`;
    for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
  };
  return {
    invalidate(agentId?: string) {
      dropPrefixed(cache, agentId);
      dropPrefixed(failures, agentId);
      dropPrefixed(inFlight, agentId);
      seq += 1;
      if (!agentId) {
        baseline = seq;
        generations.clear();
      } else {
        generations.set(agentId, seq);
      }
    },
    async resolve(input) {
      const key = [input.agentId, input.cwd, input.command ?? "", ...(input.commandArgs ?? [])].join("\u0000");
      const started = generationOf(input.agentId);
      pruneCache(cache, (entry) => now() >= entry.expiresAt, 64);
      pruneCache(failures, (entry) => now() >= entry.expiresAt, 64);
      const cached = cache.get(key);
      if (cached && now() < cached.expiresAt) return cached.value;
      if (failures.has(key)) throw new Error("Pi model catalog unavailable");
      let pending = inFlight.get(key);
      if (!pending) {
        pending = (async () => {
          try {
            const catalog = await discover({
              cwd: input.cwd,
              ...(input.command ? { command: input.command } : {}),
              ...(input.commandArgs ? { commandArgs: input.commandArgs } : {}),
            });
            const models = [
              { id: "default", label: `default: ${catalog.effectiveModel}` },
              ...catalog.models.map(({ id, label, contextWindow, supportedReasoningEfforts, defaultReasoningEffort }) => ({
                id, label, ...(contextWindow ? { contextWindow } : {}), supportedReasoningEfforts, ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
              })),
            ];
            if (generationOf(input.agentId) === started) {
              failures.delete(key);
              cache.set(key, { expiresAt: now() + ttlMs, value: models });
            }
            return models;
          } catch (error) {
            if (generationOf(input.agentId) === started) failures.set(key, { expiresAt: now() + negativeTtlMs });
            throw error;
          }
        })();
        inFlight.set(key, pending);
        void pending.finally(() => {
          if (inFlight.get(key) === pending) inFlight.delete(key);
        }).catch(() => undefined);
      }
      return await pending;
    },
  };
}

export function createCodexModelDirectoryResolver(options: {
  discoverCodexModelCatalog?: (options: DiscoverCodexCatalogOptions) => ReturnType<typeof discoverCodexModelCatalog>;
  now?: () => number;
  ttlMs?: number;
} = {}): CodexModelDirectoryResolver {
  const discover = options.discoverCodexModelCatalog ?? discoverCodexModelCatalog;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const cache = new Map<string, { expiresAt: number; value: Array<Record<string, unknown> & { id: string; label: string }> }>();
  const inFlight = new Map<string, Promise<Array<Record<string, unknown> & { id: string; label: string }>>>();
  return {
    async resolve(input) {
      const key = [input.agentId, input.cwd, input.env.CODEX_HOME ?? ""].join("\u0000");
      pruneCache(cache, (entry) => now() >= entry.expiresAt, 64);
      const cached = cache.get(key);
      if (cached && now() < cached.expiresAt) return cached.value;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = (async () => {
          const catalog = await discover({ cwd: input.cwd, env: input.env });
          const models = [
            { id: "default", label: `default: ${catalog.effectiveModel}`,
              supportsFast: catalog.models.find((model) => model.id === catalog.effectiveModel)?.supportsFast ?? false },
            ...catalog.models.map(({ id, label, supportedReasoningEfforts, defaultReasoningEffort, supportsFast }) => ({
              id, label, supportedReasoningEfforts, ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}), supportsFast,
            })),
          ];
          cache.set(key, { expiresAt: now() + ttlMs, value: models });
          return models;
        })();
        inFlight.set(key, pending);
        void pending.finally(() => inFlight.delete(key)).catch(() => undefined);
      }
      return await pending;
    },
  };
}

export function createClaudeModelDirectoryResolver(options: {
  discoverClaudeModelCatalog?: (options: DiscoverClaudeCatalogOptions) => ReturnType<typeof discoverClaudeModelCatalog>;
  now?: () => number;
  ttlMs?: number;
} = {}): ClaudeModelDirectoryResolver {
  const discover = options.discoverClaudeModelCatalog ?? discoverClaudeModelCatalog;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const cache = new Map<string, { expiresAt: number; value: Array<Record<string, unknown> & { id: string; label: string }> }>();
  const inFlight = new Map<string, Promise<Array<Record<string, unknown> & { id: string; label: string }>>>();
  return {
    async resolve(input) {
      const key = [input.agentId, input.cwd, input.env.CLAUDE_CONFIG_DIR ?? ""].join("\u0000");
      pruneCache(cache, (entry) => now() >= entry.expiresAt, 64);
      const cached = cache.get(key);
      if (cached && now() < cached.expiresAt) return cached.value;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = (async () => {
          const catalog = await discover({ cwd: input.cwd, env: input.env });
          const models = [
            { id: "default", label: `default: ${catalog.effectiveModel}` },
            ...catalog.models.map(({ id, label, supportedReasoningEfforts }) => ({ id, label, supportedReasoningEfforts })),
          ];
          cache.set(key, { expiresAt: now() + ttlMs, value: models });
          return models;
        })();
        inFlight.set(key, pending);
        void pending.finally(() => inFlight.delete(key)).catch(() => undefined);
      }
      return await pending;
    },
  };
}

async function sanitizedView(env: Env, chatDirectoryResolver: ChatDirectoryResolver, onlyAgentId?: string, chatId?: string, withChats = true): Promise<Record<string, unknown>> {
  const { config } = loadConfig(env);
  const view = safeConfigView(config, onlyAgentId, chatId, configApplyState(env, config)) as { agents: Array<Record<string, unknown>>; [key: string]: unknown };
  // Group names come from Feishu, one lookup per Agent; callers that only need the global values skip them.
  if (!withChats) return view;
  for (const item of view.agents) {
    const agentId = String(item.agentId);
    const agent = config.agents[agentId];
    let map: Record<string, unknown> = {};
    try {
      const file = path.join(agent.stateDir, "feishu-map.json");
      if (fs.statSync(file).size <= 256 * 1024) {
        const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) map = value as Record<string, unknown>;
      }
    } catch { /* no known chat map yet */ }
    const configuredChatIds = Object.keys(agent?.chatMentionPolicies || {});
    const aliases = knownChatAliases(map, configuredChatIds);
    // Names resolved before are saved per Agent and answer at once; Feishu refreshes them in the background
    // and is awaited only for a group that has never been resolved.
    const namesFile = path.join(agent.stateDir, "chat-names.json");
    const saved = readSavedChatNames(namesFile);
    let directory: Record<string, string> = saved;
    if (configuredChatIds.length) {
      const refresh = chatDirectoryResolver.resolve({
        agentId,
        chatIds: configuredChatIds,
        configDir: agent.larkConfigDir,
        profile: agent.feishuProfile,
      }).then((names) => {
        const merged = Object.fromEntries(configuredChatIds.flatMap((id) => {
          const name = names[id] ?? saved[id];
          return name ? [[id, name]] : [];
        }));
        saveChatNames(namesFile, merged);
        return merged;
      });
      if (configuredChatIds.every((id) => saved[id])) void refresh.catch(() => undefined);
      else {
        try { directory = await refresh; } catch { /* explicit configuration remains visible without a resolved name */ }
      }
    }
    item.knownChats = configuredChatIds.sort((left, right) => left.localeCompare(right, "en")).map((configuredChatId) => ({
      ...(aliases[configuredChatId] ?? { chatId: configuredChatId, displayName: null, kind: "group" as const }),
      displayName: directory[configuredChatId] ?? aliases[configuredChatId]?.displayName ?? null,
    })).map((knownChat) => ({
      ...knownChat,
      override: agent.chatMentionPolicies?.[knownChat.chatId] ?? "inherit",
      ...resolveMentionPolicy(config, agentId, knownChat.chatId),
    }));
  }
  return view;
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

export function assertWriteRequest(req: http.IncomingMessage, csrfCapability: string): void {
  const host = String(req.headers.host || "");
  if (!/^(?:localhost|127\.0\.0\.1):\d+$/.test(host)) throw new Error("invalid host");
  const expectedOrigin = `http://${host}`;
  const origin = String(req.headers.origin || "");
  const referer = String(req.headers.referer || "");
  if (origin ? origin !== expectedOrigin : !referer.startsWith(`${expectedOrigin}/`)) throw new Error("same-origin required");
  if (req.headers["x-larkin-csrf"] !== csrfCapability) throw new Error("csrf rejected");
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw new Error("application/json required");
}

/**
 * Map a failed dashboard request to a status and a message the page shows as is.
 * The raw reason goes to the local log. A wrong capability means the page was opened before this dashboard
 * (re)started; an unknown operation or field means the page is from another build; both are fixed by a reload.
 */
export function dashboardError(error: unknown, fallback: string): { status: number; body: { error: string } } {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[dashboard] ${fallback}: ${message}`);
  const reply = (status: number, text: string) => ({ status, body: { error: text } });
  if (/^(?:csrf|capability) rejected$/.test(message)) return reply(403, "这个页面已过期，刷新页面后再操作。");
  if (/^(?:invalid host|same-origin required)$/.test(message)) return reply(403, "请在本机用 http://localhost 打开 dashboard。");
  if (message === "request too large") return reply(413, "内容太大，无法保存。");
  if (message === "unknown agent") return reply(404, "这个 Agent 已不存在，刷新页面看看。");
  if (/not in current (?:runtime|model) directory$/.test(message)) return reply(400, "所选的模型或推理强度已不在可用列表里，重新选择后再保存。");
  if (/^(?:unsupported operation|invalid |JSON object required|application\/json required)/.test(message) || error instanceof SyntaxError) {
    return reply(400, "页面和正在运行的 larkin 版本不一致。刷新页面后再操作。");
  }
  // Messages written for people (Chinese) are shown as is; anything else keeps the fallback plus its reason.
  if (/[\u4e00-\u9fff]/.test(message)) return reply(400, message);
  return reply(500, `${fallback}：${message.slice(0, 200)}`);
}

function sendError(res: http.ServerResponse, error: unknown, fallback: string, extra: Record<string, unknown> = {}): void {
  const { status, body } = dashboardError(error, fallback);
  json(res, status, { ...body, ...extra });
}

function assertPrivateReadRequest(req: http.IncomingMessage, csrfCapability: string): void {
  const host = String(req.headers.host || "");
  if (!/^(?:localhost|127\.0\.0\.1):\d+$/.test(host)) throw new Error("invalid host");
  if (req.headers["x-larkin-csrf"] !== csrfCapability) throw new Error("capability rejected");
}

export async function boundedJson(req: http.IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error("request too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("request too large");
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks);
  if (body.byteLength > limit) throw new Error("request too large");
  const value = JSON.parse(body.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
}

function dashboardMutation(value: Record<string, unknown>): ConfigMutation {
  const operation = String(value.operation || "");
  const allowed: Record<string, string[]> = {
    "set-global-mention": ["operation", "value"], "set-agent-mention": ["operation", "agentId", "value"],
    "set-chat-mention": ["operation", "agentId", "chatId", "value"], "set-agent-runtime": ["operation", "agentId", "runtime", "model"],
    "set-agent-model": ["operation", "agentId", "model"], "set-agent-effort": ["operation", "agentId", "effort"],
    "set-global-inbox-audit": ["operation", "enabled", "intervalMs"], "set-agent-inbox-audit": ["operation", "agentId", "enabled", "intervalMs"],
    "set-global-reply-mode": ["operation", "value"], "set-agent-sandbox": ["operation", "agentId", "value"],
    "set-agent-fast-mode": ["operation", "agentId", "value"], "set-agent-reply-mode": ["operation", "agentId", "value"],
  };
  if (!allowed[operation] || Object.keys(value).some((key) => !allowed[operation].includes(key))) throw new Error("unsupported operation");
  if (operation === "set-global-mention") return { kind: operation, value: String(value.value) as "require" | "free" };
  if (operation === "set-global-reply-mode") return { kind: operation, value: String(value.value) as "card" | "cli" };
  if (operation === "set-global-inbox-audit") {
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("invalid inbox-audit enabled");
    if (value.intervalMs !== undefined && (typeof value.intervalMs !== "number" || !Number.isSafeInteger(value.intervalMs))) throw new Error("invalid inbox-audit interval");
    return { kind: operation, ...(value.enabled !== undefined ? { enabled: value.enabled } : {}), ...(value.intervalMs !== undefined ? { intervalMs: value.intervalMs } : {}) };
  }
  const agentId = String(value.agentId || "");
  if (operation === "set-agent-inbox-audit") {
    if (value.enabled !== undefined && value.enabled !== "inherit" && typeof value.enabled !== "boolean") throw new Error("invalid inbox-audit enabled");
    if (value.intervalMs !== undefined && value.intervalMs !== "inherit" && (typeof value.intervalMs !== "number" || !Number.isSafeInteger(value.intervalMs))) throw new Error("invalid inbox-audit interval");
    return { kind: operation, agentId, ...(value.enabled !== undefined ? { enabled: value.enabled as boolean | "inherit" } : {}), ...(value.intervalMs !== undefined ? { intervalMs: value.intervalMs as number | "inherit" } : {}) };
  }
  if (operation === "set-agent-mention") return { kind: operation, agentId, value: String(value.value) as "inherit" | "require" | "free" };
  if (operation === "set-chat-mention") return { kind: operation, agentId, chatId: String(value.chatId || ""), value: String(value.value) as "inherit" | "require" | "free" };
  if (operation === "set-agent-runtime") return { kind: operation, agentId, runtime: String(value.runtime || ""), ...(value.model ? { model: String(value.model) } : {}) };
  if (operation === "set-agent-fast-mode") {
    if (typeof value.value !== "boolean") throw new Error("invalid fast mode");
    return { kind: operation, agentId, value: value.value };
  }
  if (operation === "set-agent-reply-mode") return { kind: operation, agentId, value: String(value.value) as "card" | "cli" };
  if (operation === "set-agent-sandbox") return { kind: operation, agentId, value: String(value.value) as AgentSandbox };
  if (operation === "set-agent-model") return { kind: operation, agentId, model: String(value.model || "") };
  return { kind: "set-agent-effort", agentId, effort: value.effort === null || value.effort === "default" ? null : String(value.effort || "") };
}

export function createDashboardConfigController({
  csrfCapability,
  env = process.env,
  requestUpsert = requestAgentUpsert,
  chatDirectoryResolver = createChatDirectoryResolver(),
  claudeModelDirectoryResolver = createClaudeModelDirectoryResolver(),
  codexModelDirectoryResolver = createCodexModelDirectoryResolver(),
  piModelDirectoryResolver = createPiModelDirectoryResolver(),
  probeRuntimeReadiness = probeNativeRuntimeReadiness,
}: {
  csrfCapability: string;
  env?: Env;
  requestUpsert?: typeof requestAgentUpsert;
  chatDirectoryResolver?: ChatDirectoryResolver;
  claudeModelDirectoryResolver?: ClaudeModelDirectoryResolver;
  codexModelDirectoryResolver?: CodexModelDirectoryResolver;
  piModelDirectoryResolver?: PiModelDirectoryResolver;
  probeRuntimeReadiness?: typeof probeNativeRuntimeReadiness;
}) {
  const resolvePiModelDirectory = async (agentId: string) => {
    const { config } = loadConfig(env);
    const agent = config.agents[agentId];
    if (!agent) throw new Error("unknown agent");
    // 外部 `pi --mode rpc` 使用用户自己的 Pi home；catalog 探测不改写子进程 agent 目录。
    return await piModelDirectoryResolver.resolve({
      agentId,
      cwd: agent.workspaceDir,
      command: env.LARKIN_PI_COMMAND || process.env.LARKIN_PI_COMMAND || "pi",
      commandArgs: [],
    });
  };
  const resolveModelDirectory = async (runtime: string, agentId: string) => {
    const { config } = loadConfig(env);
    const agent = config.agents[agentId];
    if (!agent) throw new Error("unknown agent");
    if (runtime === "pi") return await resolvePiModelDirectory(agentId);
    if (runtime === "codex") return await codexModelDirectoryResolver.resolve({ agentId, cwd: agent.workspaceDir, env });
    if (runtime === "claude") return await claudeModelDirectoryResolver.resolve({ agentId, cwd: agent.workspaceDir, env });
    const authored = loadRuntimeModels()[runtime];
    if (!authored) throw new Error("unknown runtime");
    return authored;
  };
  const assertRuntimeSwitchReady = async (mutation: ConfigMutation): Promise<void> => {
    if (mutation.kind !== "set-agent-runtime") return;
    if (!isUserRuntime(mutation.runtime)) throw new Error(`未知 runtime：${mutation.runtime}`);
    const { config } = loadConfig(env);
    const agent = config.agents[mutation.agentId];
    if (!agent) throw new Error("unknown agent");
    const readiness = await probeRuntimeReadiness({
      runtime: mutation.runtime,
      cwd: agent.workspaceDir,
      env,
      agentId: mutation.agentId,
    });
    if (readiness.state === "missing") throw new RuntimePrerequisiteError(readiness);
  };
  const assertDirectoryMutation = async (mutation: ConfigMutation): Promise<void> => {
    if (mutation.kind !== "set-agent-runtime" && mutation.kind !== "set-agent-model" && mutation.kind !== "set-agent-effort") return;
    const { config } = loadConfig(env);
    const agent = config.agents[mutation.agentId];
    if (!agent) throw new Error("unknown agent");
    const runtime = mutation.kind === "set-agent-runtime" ? mutation.runtime : agent.runtime;
    const model = mutation.kind === "set-agent-runtime" ? mutation.model || "default"
      : mutation.kind === "set-agent-model" ? mutation.model : agent.model;
    if (mutation.kind === "set-agent-effort" && mutation.effort === null) return;
    const directory = await resolveModelDirectory(runtime, mutation.agentId);
    const selected = directory.find((candidate) => candidate.id === model);
    if (!selected) throw new Error("model is not in current runtime directory");
    if (mutation.kind === "set-agent-effort") {
      const efforts = Array.isArray(selected.supportedReasoningEfforts) ? selected.supportedReasoningEfforts : [];
      if (!efforts.includes(mutation.effort)) throw new Error("effort is not in current model directory");
    }
  };
  return {
    async handle(req: http.IncomingMessage, res: http.ServerResponse, requestUrl: URL): Promise<boolean> {
      if (requestUrl.pathname === "/api/config" && req.method === "GET") {
        try {
          assertPrivateReadRequest(req, csrfCapability);
          json(res, 200, {
            ...await sanitizedView(env, chatDirectoryResolver, requestUrl.searchParams.get("agent") || undefined, requestUrl.searchParams.get("chat") || undefined, requestUrl.searchParams.get("chats") !== "0"),
            runtimeModels: loadRuntimeModels(),
            runtimeOptions: [...RUNTIME_OPTIONS],
          });
        } catch (error) {
          sendError(res, error, "读取配置失败");
        }
        return true;
      }
      if (requestUrl.pathname === "/api/models/pi" && req.method === "GET") {
        try {
          assertPrivateReadRequest(req, csrfCapability);
          const agentId = requestUrl.searchParams.get("agent") || "";
          const models = await resolvePiModelDirectory(agentId);
          json(res, 200, { models });
        } catch (error) {
          sendError(res, error, "读取 Pi 模型列表失败");
        }
        return true;
      }
      if (requestUrl.pathname === "/api/models/codex" && req.method === "GET") {
        try {
          assertPrivateReadRequest(req, csrfCapability);
          const agentId = requestUrl.searchParams.get("agent") || "";
          const { config } = loadConfig(env);
          const agent = config.agents[agentId];
          if (!agent) throw new Error("unknown agent");
          const models = await codexModelDirectoryResolver.resolve({ agentId, cwd: agent.workspaceDir, env });
          json(res, 200, { models });
        } catch (error) {
          sendError(res, error, "读取 Codex 模型列表失败");
        }
        return true;
      }
      if (requestUrl.pathname === "/api/models/claude" && req.method === "GET") {
        try {
          assertPrivateReadRequest(req, csrfCapability);
          const agentId = requestUrl.searchParams.get("agent") || "";
          const { config } = loadConfig(env);
          const agent = config.agents[agentId];
          if (!agent) throw new Error("unknown agent");
          const models = await claudeModelDirectoryResolver.resolve({ agentId, cwd: agent.workspaceDir, env });
          json(res, 200, { models });
        } catch (error) {
          sendError(res, error, "读取 Claude 模型列表失败");
        }
        return true;
      }
      if (requestUrl.pathname === "/api/config" && req.method === "PATCH") {
        try {
          assertWriteRequest(req, csrfCapability);
          const mutation = dashboardMutation(await boundedJson(req));
          await assertRuntimeSwitchReady(mutation);
          await assertDirectoryMutation(mutation);
          const result = mutateConfig(env, mutation, { kind: "user" });
          json(res, 200, { ok: true, revision: result.revision, persisted: true, applyState: result.applyState, changedScope: result.changedScope });
        } catch (error) {
          if (error instanceof RuntimePrerequisiteError) json(res, 400, { error: error.message, readiness: error.readiness });
          else sendError(res, error, "保存失败");
        }
        return true;
      }
      if (requestUrl.pathname === "/api/config/apply" && req.method === "POST") {
        try {
          assertWriteRequest(req, csrfCapability);
          const body = await boundedJson(req);
          if (Object.keys(body).sort().join(",") !== "agentId" || !/^cli_[A-Za-z0-9]+$/.test(String(body.agentId || ""))) throw new Error("invalid apply request");
          const { config } = loadConfig(env);
          const agentId = String(body.agentId);
          if (!config.agents[agentId]) throw new Error("unknown agent");
          const expectedSignature = runtimeConfigSignature(config, agentId);
          const result = await requestUpsert({ larkinHome: config.larkinHome, agentId });
          if (!result.ok) {
            json(res, 409, { error: result.error || "配置已保存，但应用失败",
              ...(result.readiness ? { readiness: result.readiness } : {}) });
            return true;
          }
          markConfigApplied(env, agentId, expectedSignature);
          json(res, 200, { ok: true, agentId, applyState: "applied" });
        } catch (error) {
          const { status, body } = dashboardError(error, "配置已保存，但应用失败");
          // An unreachable runtime is a failed apply of a saved config, not a server error.
          json(res, status === 500 ? 409 : status, body);
        }
        return true;
      }
      return false;
    },
  };
}
