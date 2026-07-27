import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP = "cli_dashboardDirectoryA1";
const CONTROLLER = pathToFileURL(path.join(ROOT, "dist/dashboard/dashboard-config-controller.mjs")).href;
const CONFIG = pathToFileURL(path.join(ROOT, "dist/platform/config.mjs")).href;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-directory-"));
  fs.chmodSync(root, 0o700);
  const env = { ...process.env, LARKIN_CONFIG_DIR: root };
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4,
    serverId: "server-dashboard-directory",
    mentionPolicy: "require",
    activeAgent: APP,
    agents: {
      [APP]: {
        runtime: "pi",
        model: "default",
        chatMentionPolicies: { oc_explicit: "free" },
        createdAt: "2026-07-24T00:00:00.000Z",
      },
    },
  })}\n`, { mode: 0o600 });
  const state = path.join(root, "state", "agents", APP);
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(state, "feishu-map.json"), JSON.stringify({
    "#仅在本地出现的群": "oc_local_only",
  }), { mode: 0o600 });
  return { root, env };
}

function captureResponse() {
  let status = 0;
  let body = "";
  return {
    res: {
      writeHead(value) { status = value; },
      end(value = "") { body += String(value); },
    },
    value() { return { status, body: body ? JSON.parse(body) : null }; },
  };
}

async function get(controller, pathname, headers = { host: "localhost:9996", "x-larkin-csrf": "test" }) {
  const response = captureResponse();
  const handled = await controller.handle({ method: "GET", headers }, response.res, new URL(pathname, "http://localhost"));
  return { handled, ...response.value() };
}

async function patch(controller, body) {
  const request = Readable.from([JSON.stringify(body)]);
  request.method = "PATCH";
  request.headers = {
    host: "localhost:9996",
    origin: "http://localhost:9996",
    "content-type": "application/json",
    "x-larkin-csrf": "test",
  };
  const response = captureResponse();
  const handled = await controller.handle(request, response.res, new URL("/api/config", "http://localhost"));
  return { handled, ...response.value() };
}

test("dashboard config lists only explicit chat policies, resolves a missing local alias, and drops the row after inherit", async () => {
  const { createDashboardConfigController } = await import(`${CONTROLLER}?explicit=${Date.now()}`);
  const { mutateConfig } = await import(CONFIG);
  const f = fixture();
  onTestFinished(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const resolutions = [];
  const chatDirectoryResolver = {
    async resolve(input) {
      resolutions.push(input);
      return { oc_explicit: "远端解析群名" };
    },
  };
  const controller = createDashboardConfigController({ csrfCapability: "test", env: f.env, chatDirectoryResolver });

  const before = await get(controller, `/api/config?agent=${APP}`);
  assert.equal(before.handled, true);
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.agents[0].knownChats.map(({ chatId, displayName }) => ({ chatId, displayName })), [
    { chatId: "oc_explicit", displayName: "远端解析群名" },
  ], "local conversation aliases are not configuration rows; the injected directory resolves the explicit row");
  assert.equal(resolutions.length, 1);
  assert.deepEqual(resolutions[0].chatIds, ["oc_explicit"]);

  mutateConfig(f.env, { kind: "set-chat-mention", agentId: APP, chatId: "oc_explicit", value: "inherit" }, { kind: "user" });
  const after = await get(controller, `/api/config?agent=${APP}`);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.agents[0].knownChats, [], "inherit removes the persisted override and therefore the Dashboard row");
});

test("chat directory resolver uses list then get fallback with five-minute TTL and concurrent request dedupe", async () => {
  const module = await import(`${CONTROLLER}?chat-cache=${Date.now()}`);
  assert.equal(typeof module.createChatDirectoryResolver, "function", "dashboard controller must export the injectable chat directory resolver factory");
  let now = 1_000;
  const calls = [];
  const resolver = module.createChatDirectoryResolver({
    now: () => now,
    ttlMs: 5 * 60_000,
    async runLarkJson(call) {
      calls.push(call);
      await Promise.resolve();
      if (call.args.includes("+chat-list")) return { ok: true, data: { chats: [{ chat_id: "oc_listed", name: "  列表\u0000群名  " }] } };
      return { ok: true, data: { chat_id: "oc_fallback", name: "  单群\n回退名  " } };
    },
  });
  const input = { agentId: APP, profile: APP, configDir: "/canonical/lark-cli", chatIds: ["oc_listed", "oc_fallback"] };

  const [first, concurrent] = await Promise.all([resolver.resolve(input), resolver.resolve(input)]);
  assert.deepEqual(first, { oc_listed: "列表群名", oc_fallback: "单群 回退名" });
  assert.deepEqual(concurrent, first);
  assert.equal(calls.length, 2, "one list and one missing-id get serve concurrent callers");
  assert.deepEqual(calls[0].args, ["--profile", APP, "im", "+chat-list", "--as", "bot", "--page-size", "100", "--json"]);
  assert.deepEqual(calls[1].args, ["--profile", APP, "im", "chats", "get", "--chat-id", "oc_fallback", "--as", "bot", "--json"]);
  for (const call of calls) {
    assert.equal(call.env.LARKSUITE_CLI_CONFIG_DIR, input.configDir, "resolver pins the canonical profile config directory");
    assert.equal(call.timeout, 15_000);
    assert.ok(call.maxBuffer >= 256 * 1024 && call.maxBuffer <= 4 * 1024 * 1024, "resolver bounds lark-cli output");
  }

  now += 5 * 60_000 - 1;
  assert.deepEqual(await resolver.resolve(input), first);
  assert.equal(calls.length, 2, "cache remains valid immediately before five minutes");
  now += 2;
  assert.deepEqual(await resolver.resolve(input), first);
  assert.equal(calls.length, 4, "expired directory data is refreshed through list + get fallback");

  await resolver.resolve({ ...input, agentId: "cli_dashboardDirectoryB2", profile: "cli_dashboardDirectoryB2" });
  assert.equal(calls.length, 6, "cache entries are isolated by Agent/profile even for identical chat ids");
});

test("chat directory clears rejected in-flight work, retries, and bounds stale fallback", async () => {
  const module = await import(`${CONTROLLER}?chat-failure=${Date.now()}`);
  assert.equal(typeof module.createChatDirectoryResolver, "function");
  let now = 10_000;
  let mode = "success";
  let calls = 0;
  const resolver = module.createChatDirectoryResolver({
    now: () => now,
    ttlMs: 5 * 60_000,
    maxStaleMs: 60_000,
    async runLarkJson(call) {
      calls += 1;
      if (mode === "failure") throw new Error("directory unavailable");
      if (call.args.includes("+chat-list")) return { ok: true, data: { chats: [{ chat_id: "oc_retry", name: "可重试群" }] } };
      return { ok: false };
    },
  });
  const input = { agentId: APP, profile: APP, configDir: "/canonical/lark-cli", chatIds: ["oc_retry"] };
  assert.deepEqual(await resolver.resolve(input), { oc_retry: "可重试群" });
  assert.equal(calls, 1);

  now += 5 * 60_000 + 1;
  mode = "failure";
  assert.deepEqual(await resolver.resolve(input), { oc_retry: "可重试群" }, "a refresh failure may use bounded stale data");
  const afterFirstFailure = calls;
  mode = "success";
  assert.deepEqual(await resolver.resolve(input), { oc_retry: "可重试群" }, "rejected in-flight state is cleared so the next call retries");
  assert.ok(calls > afterFirstFailure);

  now += 5 * 60_000 + 60_001;
  mode = "failure";
  await assert.rejects(() => resolver.resolve(input), /directory unavailable/, "stale names are not served past maxStaleMs");
});

test("chat directory preserves successful names when another explicit group is deleted or inaccessible", async () => {
  const module = await import(`${CONTROLLER}?chat-partial=${Date.now()}`);
  const resolver = module.createChatDirectoryResolver({
    async runLarkJson(call) {
      if (call.args.includes("+chat-list")) return { data: { chats: [{ chat_id: "oc_valid", name: "有效群" }] } };
      if (call.args.includes("oc_deleted")) throw new Error("not found");
      return { data: { name: "回退群" } };
    },
  });
  assert.deepEqual(await resolver.resolve({
    agentId: APP,
    profile: APP,
    configDir: "/canonical/lark-cli",
    chatIds: ["oc_valid", "oc_deleted"],
  }), { oc_valid: "有效群" });
});

test("chat directory treats exit-zero ok:false envelopes as failures and preserves bounded stale names", async () => {
  const module = await import(`${CONTROLLER}?chat-envelope=${Date.now()}`);
  let now = 5_000;
  let failedEnvelope = false;
  const resolver = module.createChatDirectoryResolver({
    now: () => now,
    async runLarkJson(call) {
      if (failedEnvelope) return { ok: false, error: { message: "not authorized" } };
      return call.args.includes("+chat-list")
        ? { ok: true, data: { chats: [{ chat_id: "oc_valid", name: "有效群" }] } }
        : { ok: true, data: { name: "有效群" } };
    },
  });
  const input = { agentId: APP, profile: APP, configDir: "/canonical/lark-cli", chatIds: ["oc_valid"] };
  assert.deepEqual(await resolver.resolve(input), { oc_valid: "有效群" });
  now += 5 * 60_000 + 1;
  failedEnvelope = true;
  assert.deepEqual(await resolver.resolve(input), { oc_valid: "有效群" }, "ok:false refreshes must use bounded stale data instead of caching an empty result");
  failedEnvelope = false;
  assert.deepEqual(await resolver.resolve(input), { oc_valid: "有效群" }, "the next request retries after the failed envelope");
});

test("chat directory falls back to isolated per-group reads when chat-list is unavailable", async () => {
  const module = await import(`${CONTROLLER}?chat-list-fallback=${Date.now()}`);
  const resolver = module.createChatDirectoryResolver({
    async runLarkJson(call) {
      if (call.args.includes("+chat-list")) throw new Error("list unavailable");
      if (call.args.includes("oc_one")) return { data: { name: "单群回退" } };
      throw new Error("not found");
    },
  });
  assert.deepEqual(await resolver.resolve({
    agentId: APP,
    profile: APP,
    configDir: "/canonical/lark-cli",
    chatIds: ["oc_one", "oc_deleted"],
  }), { oc_one: "单群回退" });
});

test("chat directory bounds expired or superseded cache keys instead of retaining them indefinitely", async () => {
  const module = await import(`${CONTROLLER}?chat-bound=${Date.now()}`);
  let calls = 0;
  const resolver = module.createChatDirectoryResolver({
    ttlMs: 60 * 60_000,
    async runLarkJson(call) {
      calls += 1;
      const chatId = call.args.at(-2);
      return call.args.includes("+chat-list")
        ? { data: { chats: [{ chat_id: `oc_${calls}`, name: `群 ${calls}` }] } }
        : { data: { chat_id: chatId, name: `群 ${calls}` } };
    },
  });
  const input = (index) => ({ agentId: `cli_cache${index}`, profile: `cli_cache${index}`, configDir: "/canonical/lark-cli", chatIds: [`oc_${index}`] });
  for (let index = 1; index <= 129; index += 1) await resolver.resolve(input(index));
  const before = calls;
  await resolver.resolve(input(1));
  assert.ok(calls > before, "the oldest cache key is evicted once the bounded cache is full");
});

test("explicit groups survive directory failure with a null display name", async () => {
  const { createDashboardConfigController } = await import(`${CONTROLLER}?chat-fallback=${Date.now()}`);
  const f = fixture();
  onTestFinished(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const controller = createDashboardConfigController({
    csrfCapability: "test",
    env: f.env,
    chatDirectoryResolver: { async resolve() { throw new Error("directory unavailable"); } },
  });
  const response = await get(controller, `/api/config?agent=${APP}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.agents[0].knownChats.map(({ chatId, displayName }) => ({ chatId, displayName })), [
    { chatId: "oc_explicit", displayName: null },
  ]);
});

test("Pi model directory reuses discoverPiModelCatalog and caches default plus authenticated models for five minutes", async () => {
  const module = await import(`${CONTROLLER}?pi-cache=${Date.now()}`);
  assert.equal(typeof module.createPiModelDirectoryResolver, "function", "dashboard controller must export the Pi model directory resolver factory");
  let now = 2_000;
  const calls = [];
  const discoverPiModelCatalog = async (options) => {
    calls.push(options);
    await Promise.resolve();
    return {
      models: [{
        id: "anthropic/claude-sonnet-4-5",
        label: "Claude Sonnet 4.5 · anthropic",
        contextWindow: 200_000,
        supportedReasoningEfforts: ["off", "low", "high"],
        verified: "launchable",
      }],
      effectiveModel: "anthropic/claude-sonnet-4-5",
      effectiveThinkingLevel: "high",
      defaultSource: "settings",
      diagnostics: [],
      services: {},
    };
  };
  const resolver = module.createPiModelDirectoryResolver({ discoverPiModelCatalog, now: () => now, ttlMs: 5 * 60_000 });
  const input = { agentId: APP, cwd: "/tmp/pi-workspace", agentDir: "/tmp/pi-state" };

  const [first, concurrent] = await Promise.all([resolver.resolve(input), resolver.resolve(input)]);
  assert.deepEqual(first.map(({ id }) => id), ["default", "anthropic/claude-sonnet-4-5"]);
  assert.equal(first[0].label, "default: anthropic/claude-sonnet-4-5");
  assert.equal(first[1].contextWindow, 200_000);
  assert.equal(Object.hasOwn(first[0], "supportedReasoningEfforts"), false);
  assert.equal(Object.hasOwn(first[0], "defaultReasoningEffort"), false);
  assert.deepEqual(concurrent, first);
  assert.equal(calls.length, 1, "concurrent Pi model requests share one official discovery");
  assert.deepEqual(calls[0], { cwd: input.cwd, agentDir: input.agentDir });

  now += 5 * 60_000 - 1;
  await resolver.resolve(input);
  assert.equal(calls.length, 1);
  now += 2;
  await resolver.resolve(input);
  assert.equal(calls.length, 2, "Pi catalog refreshes after the five-minute TTL");
});

test("Pi model directory negative-caches discovery failures and retries after the short TTL", async () => {
  const module = await import(`${CONTROLLER}?pi-negative-cache=${Date.now()}`);
  let now = 5_000;
  let calls = 0;
  const resolver = module.createPiModelDirectoryResolver({
    async discoverPiModelCatalog() {
      calls += 1;
      throw new Error("fixture auth detail must stay internal");
    },
    now: () => now,
    negativeTtlMs: 30_000,
  });
  const input = { agentId: APP, cwd: "/tmp/pi-negative", agentDir: "/tmp/pi-state" };

  await assert.rejects(resolver.resolve(input), /fixture auth detail/);
  await assert.rejects(resolver.resolve(input), /Pi model catalog unavailable/);
  assert.equal(calls, 1, "3s status polling must not repeat failed discovery within the negative TTL");

  now += 30_001;
  await assert.rejects(resolver.resolve(input), /fixture auth detail/);
  assert.equal(calls, 2, "catalog discovery retries after the bounded negative TTL");
});

test("GET /api/models/pi returns default plus authenticated models through the injected resolver", async () => {
  const { createDashboardConfigController } = await import(`${CONTROLLER}?pi-endpoint=${Date.now()}`);
  const f = fixture();
  onTestFinished(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const calls = [];
  const models = [
    { id: "default", label: "default: openai/gpt-5.2" },
    { id: "openai/gpt-5.2", label: "GPT-5.2 · openai", supportedReasoningEfforts: ["off", "high"] },
  ];
  const piModelDirectoryResolver = { async resolve(input) { calls.push(input); return models; } };
  const controller = createDashboardConfigController({ csrfCapability: "test", env: f.env, piModelDirectoryResolver });

  const response = await get(controller, `/api/models/pi?agent=${APP}`);
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.models, models);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, APP);
});

test("Codex model directory reuses app-server model/list with five-minute caching and dedupe", async () => {
  const module = await import(`${CONTROLLER}?codex-cache=${Date.now()}`);
  assert.equal(typeof module.createCodexModelDirectoryResolver, "function");
  let now = 4_000;
  const calls = [];
  const discoverCodexModelCatalog = async (options) => {
    calls.push(options);
    await Promise.resolve();
    return { effectiveModel: "gpt-5.4-mini", models: [{ id: "gpt-5.4-mini", label: "GPT-5.4-Mini", supportedReasoningEfforts: ["low", "medium"], defaultReasoningEffort: "medium" }] };
  };
  const resolver = module.createCodexModelDirectoryResolver({ discoverCodexModelCatalog, now: () => now, ttlMs: 5 * 60_000 });
  const input = { agentId: APP, cwd: "/tmp/codex-workspace", env: { CODEX_HOME: "/tmp/codex-home" } };

  const [first, concurrent] = await Promise.all([resolver.resolve(input), resolver.resolve(input)]);
  assert.deepEqual(first.map(({ id }) => id), ["default", "gpt-5.4-mini"]);
  assert.equal(first[0].label, "default: gpt-5.4-mini");
  assert.equal(Object.hasOwn(first[0], "supportedReasoningEfforts"), false);
  assert.equal(Object.hasOwn(first[0], "defaultReasoningEffort"), false);
  assert.deepEqual(concurrent, first);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { cwd: input.cwd, env: input.env });
  now += 5 * 60_000 - 1;
  await resolver.resolve(input);
  assert.equal(calls.length, 1);
  now += 2;
  await resolver.resolve(input);
  assert.equal(calls.length, 2);
});

test("GET /api/models/codex returns the current Codex CLI catalog through the protected model boundary", async () => {
  const { createDashboardConfigController } = await import(`${CONTROLLER}?codex-endpoint=${Date.now()}`);
  const f = fixture();
  onTestFinished(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const calls = [];
  const models = [{ id: "default", label: "default: gpt-5.4-mini" }, { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" }];
  const codexModelDirectoryResolver = { async resolve(input) { calls.push(input); return models; } };
  const controller = createDashboardConfigController({ csrfCapability: "test", env: f.env, codexModelDirectoryResolver });

  const response = await get(controller, `/api/models/codex?agent=${APP}`);
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.models, models);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, APP);
});

test("Claude model directory reuses list_models control with five-minute caching and local default resolution", async () => {
  const module = await import(`${CONTROLLER}?claude-cache=${Date.now()}`);
  assert.equal(typeof module.createClaudeModelDirectoryResolver, "function");
  let now = 6_000;
  const calls = [];
  const discoverClaudeModelCatalog = async (options) => {
    calls.push(options);
    await Promise.resolve();
    return {
      effectiveModel: "claude-opus-4-8[1m]",
      defaultSupportedReasoningEfforts: ["low", "medium", "high"],
      models: [{ id: "opus[1m]", label: "Opus", supportedReasoningEfforts: ["low", "medium", "high"] }],
    };
  };
  const resolver = module.createClaudeModelDirectoryResolver({ discoverClaudeModelCatalog, now: () => now, ttlMs: 5 * 60_000 });
  const input = { agentId: APP, cwd: "/tmp/claude-workspace", env: { CLAUDE_CONFIG_DIR: "/tmp/claude-home" } };
  const [first, concurrent] = await Promise.all([resolver.resolve(input), resolver.resolve(input)]);
  assert.deepEqual(first.map(({ id }) => id), ["default", "opus[1m]"]);
  assert.equal(first[0].label, "default: claude-opus-4-8[1m]");
  assert.equal(Object.hasOwn(first[0], "supportedReasoningEfforts"), false);
  assert.deepEqual(concurrent, first);
  assert.equal(calls.length, 1);
  now += 5 * 60_000 + 1;
  await resolver.resolve(input);
  assert.equal(calls.length, 2);
});

test("GET /api/models/claude returns the current Claude control catalog", async () => {
  const { createDashboardConfigController } = await import(`${CONTROLLER}?claude-endpoint=${Date.now()}`);
  const f = fixture();
  onTestFinished(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const models = [{ id: "default", label: "default: claude-opus-4-8[1m]" }, { id: "sonnet", label: "Sonnet" }];
  const claudeModelDirectoryResolver = { async resolve() { return models; } };
  const controller = createDashboardConfigController({ csrfCapability: "test", env: f.env, claudeModelDirectoryResolver });
  const response = await get(controller, `/api/models/claude?agent=${APP}`);
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.models, models);
});

for (const runtimeCase of [
  { runtime: "codex", model: "gpt-evaluator-dynamic-1", effort: "high" },
  { runtime: "claude", model: "claude-evaluator-9", effort: "medium" },
]) {
  test(`dynamic ${runtimeCase.runtime} directory choices survive Dashboard PATCH and controller reload`, async () => {
    const { createDashboardConfigController } = await import(`${CONTROLLER}?dynamic-persist=${runtimeCase.runtime}-${Date.now()}`);
    const f = fixture();
    onTestFinished(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const models = [
      { id: "default", label: `default: ${runtimeCase.model}` },
      { id: runtimeCase.model, label: "Dynamic evaluator model", supportedReasoningEfforts: [runtimeCase.effort] },
    ];
    const options = {
      csrfCapability: "test",
      env: f.env,
      codexModelDirectoryResolver: { async resolve() { return runtimeCase.runtime === "codex" ? models : []; } },
      claudeModelDirectoryResolver: { async resolve() { return runtimeCase.runtime === "claude" ? models : []; } },
    };
    const controller = createDashboardConfigController(options);
    const directory = await get(controller, `/api/models/${runtimeCase.runtime}?agent=${APP}`);
    assert.equal(directory.status, 200);
    assert.equal(directory.body.models[1].id, runtimeCase.model);

    const runtime = await patch(controller, { operation: "set-agent-runtime", agentId: APP, runtime: runtimeCase.runtime, model: runtimeCase.model });
    assert.equal(runtime.status, 200, JSON.stringify(runtime.body));
    const effort = await patch(controller, { operation: "set-agent-effort", agentId: APP, effort: runtimeCase.effort });
    assert.equal(effort.status, 200, JSON.stringify(effort.body));

    const reloadedController = createDashboardConfigController(options);
    const reloaded = await get(reloadedController, `/api/config?agent=${APP}`);
    assert.equal(reloaded.status, 200);
    assert.deepEqual(
      { model: reloaded.body.agents[0].model, effort: reloaded.body.agents[0].effort },
      { model: runtimeCase.model, effort: runtimeCase.effort },
    );
  });
}

test("dynamic directory GETs require loopback Host and the dashboard capability before resolver work", async () => {
  const { createDashboardConfigController } = await import(`${CONTROLLER}?get-guard=${Date.now()}`);
  const f = fixture();
  onTestFinished(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const calls = [];
  const controller = createDashboardConfigController({
    csrfCapability: "test",
    env: f.env,
    chatDirectoryResolver: { async resolve() { calls.push("chat"); return {}; } },
    piModelDirectoryResolver: { async resolve() { calls.push("pi"); return []; } },
    codexModelDirectoryResolver: { async resolve() { calls.push("codex"); return []; } },
    claudeModelDirectoryResolver: { async resolve() { calls.push("claude"); return []; } },
  });

  const badHost = await get(controller, `/api/models/pi?agent=${APP}`, { host: "evil.example", "x-larkin-csrf": "test" });
  const missingCodexCapability = await get(controller, `/api/models/codex?agent=${APP}`, { host: "localhost:9996" });
  const missingClaudeCapability = await get(controller, `/api/models/claude?agent=${APP}`, { host: "localhost:9996" });
  const missingCapability = await get(controller, `/api/config?agent=${APP}`, { host: "localhost:9996" });
  assert.equal(badHost.handled, true);
  assert.equal(missingCapability.handled, true);
  assert.deepEqual([badHost.status, missingCodexCapability.status, missingClaudeCapability.status, missingCapability.status], [403, 403, 403, 403]);
  assert.deepEqual(calls, [], "untrusted dynamic GETs never reach local credential-backed resolvers");
});
