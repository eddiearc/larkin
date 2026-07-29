import type http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { configApplyState, loadConfig, loadRuntimeModels, markConfigApplied, mutateConfig, resolveMentionPolicy, runtimeConfigSignature, safeConfigView, type ConfigMutation } from "../platform/config.js";
import { requestAgentUpsert } from "../app/local-control.js";
import { discoverClaudeModelCatalog, type DiscoverClaudeCatalogOptions } from "../runtime/claude-model-catalog.js";
import { discoverCodexModelCatalog, type DiscoverCodexCatalogOptions } from "../runtime/codex-model-catalog.js";
import { discoverPiModelCatalog, type DiscoverPiCatalogOptions } from "../runtime/pi-model-catalog.js";
import { managedOfficialLarkCli } from "../app/agent-lark-cli-workspace.js";

type Env = Record<string, string | undefined>;
type LarkJsonCall = { command: string; args: string[]; env: Env; maxBuffer: number; timeout: number };
type ChatDirectoryInput = { agentId: string; chatIds: string[]; configDir: string; profile: string };
type ClaudeModelDirectoryInput = { agentId: string; cwd: string; env: Env };
type CodexModelDirectoryInput = { agentId: string; cwd: string; env: Env };
type PiModelDirectoryInput = { agentDir?: string; agentId: string; cwd: string };

export type ChatDirectoryResolver = { resolve(input: ChatDirectoryInput): Promise<Record<string, string>> };
export type ClaudeModelDirectoryResolver = { resolve(input: ClaudeModelDirectoryInput): Promise<Array<Record<string, unknown> & { id: string; label: string }>> };
export type CodexModelDirectoryResolver = { resolve(input: CodexModelDirectoryInput): Promise<Array<Record<string, unknown> & { id: string; label: string }>> };
export type PiModelDirectoryResolver = { resolve(input: PiModelDirectoryInput): Promise<Array<Record<string, unknown> & { id: string; label: string }>> };

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
  return {
    async resolve(input) {
      const key = [input.agentId, input.cwd, input.agentDir ?? ""].join("\u0000");
      pruneCache(cache, (entry) => now() >= entry.expiresAt, 64);
      pruneCache(failures, (entry) => now() >= entry.expiresAt, 64);
      const cached = cache.get(key);
      if (cached && now() < cached.expiresAt) return cached.value;
      if (failures.has(key)) throw new Error("Pi model catalog unavailable");
      let pending = inFlight.get(key);
      if (!pending) {
        pending = (async () => {
          try {
            const catalog = await discover({ cwd: input.cwd, ...(input.agentDir ? { agentDir: input.agentDir } : {}) });
            const models = [
              { id: "default", label: `default: ${catalog.effectiveModel}` },
              ...catalog.models.map(({ id, label, contextWindow, supportedReasoningEfforts, defaultReasoningEffort }) => ({
                id, label, ...(contextWindow ? { contextWindow } : {}), supportedReasoningEfforts, ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
              })),
            ];
            failures.delete(key);
            cache.set(key, { expiresAt: now() + ttlMs, value: models });
            return models;
          } catch (error) {
            failures.set(key, { expiresAt: now() + negativeTtlMs });
            throw error;
          }
        })();
        inFlight.set(key, pending);
        void pending.finally(() => inFlight.delete(key)).catch(() => undefined);
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
            { id: "default", label: `default: ${catalog.effectiveModel}` },
            ...catalog.models.map(({ id, label, supportedReasoningEfforts, defaultReasoningEffort }) => ({
              id, label, supportedReasoningEfforts, ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
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

async function sanitizedView(env: Env, chatDirectoryResolver: ChatDirectoryResolver, onlyAgentId?: string, chatId?: string): Promise<Record<string, unknown>> {
  const { config } = loadConfig(env);
  const view = safeConfigView(config, onlyAgentId, chatId, configApplyState(env, config)) as { agents: Array<Record<string, unknown>>; [key: string]: unknown };
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
    let directory: Record<string, string> = {};
    try {
      directory = await chatDirectoryResolver.resolve({
        agentId,
        chatIds: configuredChatIds,
        configDir: agent.larkConfigDir,
        profile: agent.feishuProfile,
      });
    } catch { /* explicit configuration remains visible without a resolved name */ }
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

function assertWriteRequest(req: http.IncomingMessage, csrfCapability: string): void {
  const host = String(req.headers.host || "");
  if (!/^(?:localhost|127\.0\.0\.1):\d+$/.test(host)) throw new Error("invalid host");
  const expectedOrigin = `http://${host}`;
  const origin = String(req.headers.origin || "");
  const referer = String(req.headers.referer || "");
  if (origin ? origin !== expectedOrigin : !referer.startsWith(`${expectedOrigin}/`)) throw new Error("same-origin required");
  if (req.headers["x-larkin-csrf"] !== csrfCapability) throw new Error("csrf rejected");
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw new Error("application/json required");
}

function assertPrivateReadRequest(req: http.IncomingMessage, csrfCapability: string): void {
  const host = String(req.headers.host || "");
  if (!/^(?:localhost|127\.0\.0\.1):\d+$/.test(host)) throw new Error("invalid host");
  if (req.headers["x-larkin-csrf"] !== csrfCapability) throw new Error("capability rejected");
}

async function boundedJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) throw new Error("request too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024) throw new Error("request too large");
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks);
  if (body.byteLength > 16 * 1024) throw new Error("request too large");
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
  };
  if (!allowed[operation] || Object.keys(value).some((key) => !allowed[operation].includes(key))) throw new Error("unsupported operation");
  if (operation === "set-global-mention") return { kind: operation, value: String(value.value) as "require" | "free" };
  const agentId = String(value.agentId || "");
  if (operation === "set-agent-mention") return { kind: operation, agentId, value: String(value.value) as "inherit" | "require" | "free" };
  if (operation === "set-chat-mention") return { kind: operation, agentId, chatId: String(value.chatId || ""), value: String(value.value) as "inherit" | "require" | "free" };
  if (operation === "set-agent-runtime") return { kind: operation, agentId, runtime: String(value.runtime || ""), ...(value.model ? { model: String(value.model) } : {}) };
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
}: {
  csrfCapability: string;
  env?: Env;
  requestUpsert?: typeof requestAgentUpsert;
  chatDirectoryResolver?: ChatDirectoryResolver;
  claudeModelDirectoryResolver?: ClaudeModelDirectoryResolver;
  codexModelDirectoryResolver?: CodexModelDirectoryResolver;
  piModelDirectoryResolver?: PiModelDirectoryResolver;
}) {
  const resolveModelDirectory = async (runtime: string, agentId: string) => {
    const { config } = loadConfig(env);
    const agent = config.agents[agentId];
    if (!agent) throw new Error("unknown agent");
    if (runtime === "pi") return await piModelDirectoryResolver.resolve({
      agentId, cwd: agent.workspaceDir, ...(env.PI_CODING_AGENT_DIR ? { agentDir: env.PI_CODING_AGENT_DIR } : {}),
    });
    if (runtime === "codex") return await codexModelDirectoryResolver.resolve({ agentId, cwd: agent.workspaceDir, env });
    if (runtime === "claude") return await claudeModelDirectoryResolver.resolve({ agentId, cwd: agent.workspaceDir, env });
    const authored = loadRuntimeModels()[runtime];
    if (!authored) throw new Error("unknown runtime");
    return authored;
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
          json(res, 200, { ...await sanitizedView(env, chatDirectoryResolver, requestUrl.searchParams.get("agent") || undefined, requestUrl.searchParams.get("chat") || undefined), runtimeModels: loadRuntimeModels() });
        } catch (error) {
          json(res, error instanceof Error && /host|capability/.test(error.message) ? 403 : 500, { error: "configuration unavailable" });
        }
        return true;
      }
      if (requestUrl.pathname === "/api/models/pi" && req.method === "GET") {
        try {
          assertPrivateReadRequest(req, csrfCapability);
          const agentId = requestUrl.searchParams.get("agent") || "";
          const { config } = loadConfig(env);
          const agent = config.agents[agentId];
          if (!agent) throw new Error("unknown agent");
          const models = await piModelDirectoryResolver.resolve({
            agentId,
            cwd: agent.workspaceDir,
            ...(env.PI_CODING_AGENT_DIR ? { agentDir: env.PI_CODING_AGENT_DIR } : {}),
          });
          json(res, 200, { models });
        } catch (error) {
          json(res, error instanceof Error && /host|capability/.test(error.message) ? 403 : 500, { error: "Pi model directory unavailable" });
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
          json(res, error instanceof Error && /host|capability/.test(error.message) ? 403 : 500, { error: "Codex model directory unavailable" });
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
          json(res, error instanceof Error && /host|capability/.test(error.message) ? 403 : 500, { error: "Claude model directory unavailable" });
        }
        return true;
      }
      if (requestUrl.pathname === "/api/config" && req.method === "PATCH") {
        try {
          assertWriteRequest(req, csrfCapability);
          const mutation = dashboardMutation(await boundedJson(req));
          await assertDirectoryMutation(mutation);
          const result = mutateConfig(env, mutation, { kind: "user" });
          json(res, 200, { ok: true, revision: result.revision, persisted: true, applyState: result.applyState, changedScope: result.changedScope });
        } catch { json(res, 400, { error: "configuration update rejected" }); }
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
            json(res, 409, { error: result.error || "configuration saved but apply failed",
              ...(result.readiness ? { readiness: result.readiness } : {}) });
            return true;
          }
          markConfigApplied(env, agentId, expectedSignature);
          json(res, 200, { ok: true, agentId, applyState: "applied" });
        } catch { json(res, 409, { error: "configuration saved but apply failed" }); }
        return true;
      }
      return false;
    },
  };
}
