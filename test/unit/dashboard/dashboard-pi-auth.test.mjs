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
      [APP]: { runtime: "pi", model: "deepseek/old", createdAt: "2026-09-04T00:00:00.000Z" },
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

test("removed pi-auth routes are unhandled like any unknown Dashboard route", async () => {
  const { createDashboardConfigController } = await import(`${CONTROLLER}?pi-auth=${Date.now()}`);
  const f = fixture();
  onTestFinished(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const controller = createDashboardConfigController({ csrfCapability: "test", env: f.env });
  const unknown = await get(controller, "/api/does-not-exist");
  assert.equal(unknown.handled, false);
  for (const pathname of [
    "/api/pi-auth/providers",
    `/api/pi-auth/status?agent=${APP}`,
  ]) {
    const response = await get(controller, pathname);
    assert.equal(response.handled, false, pathname);
  }
  for (const [pathname, body] of [
    ["/api/pi-auth/login", { agentId: APP, preset: "deepseek", apiKey: "dashboard-secret-key" }],
    ["/api/pi-auth/logout", { agentId: APP, provider: "deepseek" }],
  ]) {
    const response = await post(controller, pathname, body);
    assert.equal(response.handled, false, pathname);
    assert.doesNotMatch(JSON.stringify(response.body), /dashboard-secret-key/);
  }
});

test("Pi model directory invalidate drops only the target Agent cache", async () => {
  const module = await import(`${CONTROLLER}?pi-invalidate=${Date.now()}`);
  let now = 8_000;
  const calls = [];
  const resolver = module.createPiModelDirectoryResolver({
    async discoverPiModelCatalog(options) {
      calls.push(options.cwd);
      return { models: [], effectiveModel: "owned/model", effectiveThinkingLevel: "off", defaultSource: "settings", diagnostics: [] };
    },
    now: () => now,
    ttlMs: 5 * 60_000,
  });
  await resolver.resolve({ agentId: APP, cwd: "/tmp/a" });
  await resolver.resolve({ agentId: OTHER, cwd: "/tmp/b" });
  assert.equal(calls.length, 2);
  resolver.invalidate(APP);
  await resolver.resolve({ agentId: APP, cwd: "/tmp/a" });
  await resolver.resolve({ agentId: OTHER, cwd: "/tmp/b" });
  assert.equal(calls.length, 3, "only the invalidated Agent must refresh");
  assert.equal(calls[2], "/tmp/a");
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
      calls.push(options.cwd);
      const n = calls.filter((dir) => dir === options.cwd).length;
      if (options.cwd === "/tmp/a") {
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
  const stale = resolver.resolve({ agentId: APP, cwd: "/tmp/a" });
  const staleFail = resolver.resolve({ agentId: OTHER, cwd: "/tmp/b" });
  while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  resolver.invalidate(APP);
  resolver.invalidate(OTHER);
  releasePositive();
  releaseNegative();
  const staleResult = await stale;
  assert.equal(staleResult.some((model) => model.id === "catalog-1"), true);
  await assert.rejects(() => staleFail, /stale negative catalog/);

  const fresh = await resolver.resolve({ agentId: APP, cwd: "/tmp/a" });
  assert.equal(calls.filter((dir) => dir === "/tmp/a").length, 2);
  assert.equal(fresh.some((model) => model.id === "catalog-2"), true);
  assert.equal(fresh.some((model) => model.id === "catalog-1"), false);
  now += 1;
  const cached = await resolver.resolve({ agentId: APP, cwd: "/tmp/a" });
  assert.equal(calls.filter((dir) => dir === "/tmp/a").length, 2);
  assert.deepEqual(cached.map((model) => model.id).filter((id) => id !== "default"), ["catalog-2"]);

  const recovered = await resolver.resolve({ agentId: OTHER, cwd: "/tmp/b" });
  assert.equal(calls.filter((dir) => dir === "/tmp/b").length, 2);
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
      calls.push(options.cwd);
      const n = calls.filter((dir) => dir === options.cwd).length;
      if (n === 1) await holdStale;
      return {
        models: [{ id: `catalog-${n}`, label: `catalog-${n}` }],
        effectiveModel: `catalog-${n}`, effectiveThinkingLevel: "off", defaultSource: "settings", diagnostics: [],
      };
    },
    now: () => now,
    ttlMs: 5 * 60_000,
  });
  const stale = resolver.resolve({ agentId: APP, cwd: "/tmp/a" });
  while (calls.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
  resolver.invalidate(APP);
  resolver.invalidate();
  releaseStale();
  const staleResult = await stale;
  assert.equal(staleResult.some((model) => model.id === "catalog-1"), true);

  const fresh = await resolver.resolve({ agentId: APP, cwd: "/tmp/a" });
  assert.equal(calls.length, 2);
  assert.equal(fresh.some((model) => model.id === "catalog-2"), true);
  assert.equal(fresh.some((model) => model.id === "catalog-1"), false);
  now += 1;
  const cached = await resolver.resolve({ agentId: APP, cwd: "/tmp/a" });
  assert.equal(calls.length, 2);
  assert.deepEqual(cached.map((model) => model.id).filter((id) => id !== "default"), ["catalog-2"]);
});
