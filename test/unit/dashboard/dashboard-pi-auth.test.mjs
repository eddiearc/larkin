import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP = "cli_dashboardPiAuthA1";
const OTHER = "cli_dashboardPiAuthB2";
const CONTROLLER = pathToFileURL(path.join(ROOT, "dist/dashboard/dashboard-config-controller.mjs")).href;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-pi-auth-"));
  fs.chmodSync(root, 0o700);
  const env = { ...process.env, LARKIN_CONFIG_DIR: root };
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-dashboard-pi-auth", mentionPolicy: "require", activeAgent: APP,
    agents: {
      [APP]: { runtime: "pi", piDistribution: "builtin", model: "deepseek/old", createdAt: "2026-09-04T00:00:00.000Z" },
      [OTHER]: { runtime: "codex", model: "gpt-5.6-sol", createdAt: "2026-09-04T00:00:00.000Z" },
    },
  })}\n`, { mode: 0o600 });
  for (const agentId of [APP, OTHER]) {
    const state = path.join(root, "state", "agents", agentId);
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  }
  fs.mkdirSync(path.join(root, "providers", "pi", APP), { recursive: true, mode: 0o700 });
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

async function post(controller, pathname, body, headers = {
  host: "localhost:9996",
  origin: "http://localhost:9996",
  "content-type": "application/json",
  "x-larkin-csrf": "test",
}) {
  const request = Readable.from([JSON.stringify(body)]);
  request.method = "POST";
  request.headers = headers;
  const response = captureResponse();
  const handled = await controller.handle(request, response.res, new URL(pathname, "http://localhost"));
  return { handled, ...response.value() };
}

test("dashboard provider catalog/status are redacted and login is target-only with cache invalidation", async () => {
  const { createDashboardConfigController } = await import(`${CONTROLLER}?pi-auth=${Date.now()}`);
  const f = fixture();
  onTestFinished(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const invalidated = [];
  const logins = [];
  const controller = createDashboardConfigController({
    csrfCapability: "test",
    env: f.env,
    piModelDirectoryResolver: {
      async resolve() { return [{ id: "default", label: "default" }]; },
      invalidate(agentId) { invalidated.push(agentId); },
    },
    listProviderCatalog: () => [{ id: "deepseek", name: "DeepSeek", provider: "deepseek", defaultModel: "deepseek/deepseek-v4-pro", custom: false, openaiCompatible: true }],
    loadProviderStatus: async () => [{ providerId: "deepseek", providerName: "DeepSeek", credentialType: "api_key", source: "configured", stored: true }],
    configureProvider: async (input) => {
      logins.push({ agentId: input.agentId, preset: input.preset, hasKey: Boolean(input.apiKey), key: input.apiKey });
      return {
        agentId: input.agentId, provider: "deepseek", preset: input.preset,
        model: "deepseek/deepseek-v4-pro", credentialType: "api_key", applyState: "saved_not_applied",
      };
    },
    logoutProvider: async (input) => ({ agentId: input.agentId, provider: input.providerId }),
  });

  const catalog = await get(controller, "/api/pi-auth/providers");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.providers[0].id, "deepseek");
  assert.equal(JSON.stringify(catalog.body).includes("sk-"), false);

  const status = await get(controller, `/api/pi-auth/status?agent=${APP}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.agentId, APP);
  assert.equal(status.body.credentials[0].credentialType, "api_key");
  assert.doesNotMatch(JSON.stringify(status.body), /Bearer |sk-|apiKey/i);

  const forbidden = await get(controller, "/api/pi-auth/providers", { host: "example.com", "x-larkin-csrf": "test" });
  assert.equal(forbidden.status, 403);

  const login = await post(controller, "/api/pi-auth/login", {
    agentId: APP, preset: "deepseek", apiKey: "dashboard-secret-key",
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.provider, "deepseek");
  assert.equal(login.body.applyState, "saved_not_applied");
  assert.equal(Object.hasOwn(login.body, "apiKey"), false);
  assert.doesNotMatch(JSON.stringify(login.body), /dashboard-secret-key/);
  assert.deepEqual(invalidated, [APP]);
  assert.equal(logins[0].hasKey, true);
  assert.equal(logins[0].agentId, APP);

  const extraField = await post(controller, "/api/pi-auth/login", {
    agentId: APP, preset: "deepseek", apiKey: "x", padding: "nope",
  });
  assert.equal(extraField.status, 400);

  const leaky = createDashboardConfigController({
    csrfCapability: "test",
    env: f.env,
    configureProvider: async (input) => {
      throw new Error(`failed key=${input.apiKey}`);
    },
  });
  const leaked = await post(leaky, "/api/pi-auth/login", {
    agentId: APP, preset: "deepseek", apiKey: "dashboard-secret-key",
  });
  assert.equal(leaked.status, 400);
  assert.doesNotMatch(JSON.stringify(leaked.body), /dashboard-secret-key/);

  const otherAgent = await post(controller, "/api/pi-auth/login", {
    agentId: OTHER, preset: "deepseek", apiKey: "should-not-reach-other",
  });
  assert.equal(otherAgent.status, 400);
  assert.equal(logins.length, 1, "non-builtin Agents must not enter the login service");
  assert.doesNotMatch(JSON.stringify(otherAgent.body), /should-not-reach-other/);

  const logout = await post(controller, "/api/pi-auth/logout", { agentId: APP, provider: "deepseek" });
  assert.equal(logout.status, 200);
  assert.deepEqual(invalidated, [APP, APP]);
});

test("Pi model directory invalidate drops only the target Agent cache", async () => {
  const module = await import(`${CONTROLLER}?pi-invalidate=${Date.now()}`);
  let now = 8_000;
  const calls = [];
  const resolver = module.createPiModelDirectoryResolver({
    async discoverPiModelCatalog(options) {
      calls.push(options.agentDir);
      return { models: [], effectiveModel: "owned/model", effectiveThinkingLevel: "off", defaultSource: "settings", diagnostics: [] };
    },
    now: () => now,
    ttlMs: 5 * 60_000,
  });
  await resolver.resolve({ agentId: APP, cwd: "/tmp/a", agentDir: "/tmp/a-dir" });
  await resolver.resolve({ agentId: OTHER, cwd: "/tmp/b", agentDir: "/tmp/b-dir" });
  assert.equal(calls.length, 2);
  resolver.invalidate(APP);
  await resolver.resolve({ agentId: APP, cwd: "/tmp/a", agentDir: "/tmp/a-dir" });
  await resolver.resolve({ agentId: OTHER, cwd: "/tmp/b", agentDir: "/tmp/b-dir" });
  assert.equal(calls.length, 3, "only the invalidated Agent must refresh");
  assert.equal(calls[2], "/tmp/a-dir");
});

test("in-flight pre-login catalog resolve cannot repopulate cache after invalidate", async () => {
  const module = await import(`${CONTROLLER}?pi-invalidate-race=${Date.now()}`);
  let releasePositive;
  const holdPositive = new Promise((resolve) => { releasePositive = resolve; });
  let releaseNegative;
  const holdNegative = new Promise((resolve) => { releaseNegative = resolve; });
  let now = 8_000;
  const calls = [];
  const resolver = module.createPiModelDirectoryResolver({
    async discoverPiModelCatalog(options) {
      calls.push(options.agentDir);
      const n = calls.filter((dir) => dir === options.agentDir).length;
      if (options.agentDir === "/tmp/stale-dir") {
        if (n === 1) await holdPositive;
        return {
          models: [{ id: `catalog-${n}`, label: `catalog-${n}` }],
          effectiveModel: `catalog-${n}`, effectiveThinkingLevel: "off", defaultSource: "settings", diagnostics: [],
        };
      }
      if (n === 1) await holdNegative;
      if (n === 1) throw new Error("stale negative catalog");
      return {
        models: [{ id: "recovered", label: "recovered" }],
        effectiveModel: "recovered", effectiveThinkingLevel: "off", defaultSource: "settings", diagnostics: [],
      };
    },
    now: () => now,
    ttlMs: 5 * 60_000,
    negativeTtlMs: 30_000,
  });
  const stale = resolver.resolve({ agentId: APP, cwd: "/tmp/a", agentDir: "/tmp/stale-dir" });
  const staleFail = resolver.resolve({ agentId: OTHER, cwd: "/tmp/b", agentDir: "/tmp/fail-dir" });
  while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  resolver.invalidate(APP);
  resolver.invalidate(OTHER);
  releasePositive();
  releaseNegative();
  const staleResult = await stale;
  assert.equal(staleResult.some((model) => model.id === "catalog-1"), true);
  await assert.rejects(() => staleFail, /stale negative catalog/);

  const fresh = await resolver.resolve({ agentId: APP, cwd: "/tmp/a", agentDir: "/tmp/stale-dir" });
  assert.equal(calls.filter((dir) => dir === "/tmp/stale-dir").length, 2);
  assert.equal(fresh.some((model) => model.id === "catalog-2"), true);
  assert.equal(fresh.some((model) => model.id === "catalog-1"), false);
  now += 1;
  const cached = await resolver.resolve({ agentId: APP, cwd: "/tmp/a", agentDir: "/tmp/stale-dir" });
  assert.equal(calls.filter((dir) => dir === "/tmp/stale-dir").length, 2);
  assert.deepEqual(cached.map((model) => model.id).filter((id) => id !== "default"), ["catalog-2"]);

  const recovered = await resolver.resolve({ agentId: OTHER, cwd: "/tmp/b", agentDir: "/tmp/fail-dir" });
  assert.equal(calls.filter((dir) => dir === "/tmp/fail-dir").length, 2);
  assert.equal(recovered.some((model) => model.id === "recovered"), true);
});

test("targeted then global invalidate cannot admit a stale in-flight catalog result", async () => {
  const module = await import(`${CONTROLLER}?pi-invalidate-generation=${Date.now()}`);
  let releaseStale;
  const holdStale = new Promise((resolve) => { releaseStale = resolve; });
  let now = 8_000;
  const calls = [];
  const resolver = module.createPiModelDirectoryResolver({
    async discoverPiModelCatalog(options) {
      calls.push(options.agentDir);
      const n = calls.filter((dir) => dir === options.agentDir).length;
      if (n === 1) await holdStale;
      return {
        models: [{ id: `catalog-${n}`, label: `catalog-${n}` }],
        effectiveModel: `catalog-${n}`, effectiveThinkingLevel: "off", defaultSource: "settings", diagnostics: [],
      };
    },
    now: () => now,
    ttlMs: 5 * 60_000,
  });
  const stale = resolver.resolve({ agentId: APP, cwd: "/tmp/a", agentDir: "/tmp/generation-dir" });
  while (calls.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
  resolver.invalidate(APP);
  resolver.invalidate();
  releaseStale();
  const staleResult = await stale;
  assert.equal(staleResult.some((model) => model.id === "catalog-1"), true);

  const fresh = await resolver.resolve({ agentId: APP, cwd: "/tmp/a", agentDir: "/tmp/generation-dir" });
  assert.equal(calls.length, 2);
  assert.equal(fresh.some((model) => model.id === "catalog-2"), true);
  assert.equal(fresh.some((model) => model.id === "catalog-1"), false);
  now += 1;
  const cached = await resolver.resolve({ agentId: APP, cwd: "/tmp/a", agentDir: "/tmp/generation-dir" });
  assert.equal(calls.length, 2);
  assert.deepEqual(cached.map((model) => model.id).filter((id) => id !== "default"), ["catalog-2"]);
});

test("login applyError response redacts the submitted API key", async () => {
  const { createDashboardConfigController } = await import(`${CONTROLLER}?pi-apply-error=${Date.now()}`);
  const f = fixture();
  onTestFinished(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const secret = "dashboard-apply-secret-key";
  const controller = createDashboardConfigController({
    csrfCapability: "test",
    env: f.env,
    configureProvider: async (input) => ({
      agentId: input.agentId, provider: "deepseek", preset: input.preset,
      model: "deepseek/deepseek-v4-pro", credentialType: "api_key", applyState: "pending",
      applyError: `targeted upsert failed key=${input.apiKey}`,
    }),
  });
  const login = await post(controller, "/api/pi-auth/login", {
    agentId: APP, preset: "deepseek", apiKey: secret,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.applyState, "pending");
  assert.match(login.body.applyError, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(login.body), new RegExp(secret));
});
