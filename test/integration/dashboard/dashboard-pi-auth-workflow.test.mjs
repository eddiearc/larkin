import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONTROLLER = pathToFileURL(path.join(ROOT, "dist/dashboard/dashboard-config-controller.mjs")).href;
const APP = "cli_dashboardWorkflowA1";
const OTHER = "cli_dashboardWorkflowB2";

function startFakeProvider() {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "fake provider must not be contacted on save" } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        hits: () => hits,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function seedHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-pi-auth-wf-"));
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-dashboard-pi-auth-wf", mentionPolicy: "require", activeAgent: APP,
    agents: {
      [APP]: { runtime: "pi", piDistribution: "builtin", model: "deepseek/old", createdAt: "2026-09-04T00:00:00.000Z" },
      [OTHER]: { runtime: "pi", piDistribution: "builtin", model: "kimi/kimi-k2.6", createdAt: "2026-09-04T00:00:00.000Z" },
    },
  })}\n`, { mode: 0o600 });
  for (const agentId of [APP, OTHER]) {
    fs.mkdirSync(path.join(root, "state", "agents", agentId), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, "providers", "pi", agentId), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(root, "providers", "pi", agentId), 0o700);
  }
  return { root, env: { ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_HOME: root, HOME: root } };
}

function captureResponse() {
  let status = 0;
  let headers = {};
  let body = "";
  return {
    res: {
      writeHead(value, next) { status = value; headers = next || {}; },
      end(value = "") { body += String(value); },
    },
    value() { return { status, headers, body: body ? JSON.parse(body) : null }; },
  };
}

async function get(controller, pathname) {
  const response = captureResponse();
  await controller.handle(
    { method: "GET", headers: { host: "localhost:9996", "x-larkin-csrf": "test" } },
    response.res,
    new URL(pathname, "http://localhost"),
  );
  return response.value();
}

async function post(controller, pathname, body) {
  const request = Readable.from([JSON.stringify(body)]);
  request.method = "POST";
  request.headers = {
    host: "localhost:9996",
    origin: "http://localhost:9996",
    "content-type": "application/json",
    "x-larkin-csrf": "test",
  };
  const response = captureResponse();
  await controller.handle(request, response.res, new URL(pathname, "http://localhost"));
  return response.value();
}

test("Dashboard login uses the real provider service and returns redacted status/model", async () => {
  const { createDashboardConfigController } = await import(`${CONTROLLER}?wf=${Date.now()}`);
  const f = seedHome();
  const provider = await startFakeProvider();
  onTestFinished(async () => {
    await provider.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const controller = createDashboardConfigController({ csrfCapability: "test", env: f.env });
  const secret = "dashboard-workflow-super-secret";

  const custom = await post(controller, "/api/pi-auth/login", {
    agentId: APP, preset: "custom", apiKey: secret, baseUrl: provider.baseUrl, model: "fixture-model",
  });
  assert.equal(custom.status, 200, JSON.stringify(custom.body));
  assert.equal(custom.body.provider, "larkin-custom");
  assert.equal(custom.body.model, "larkin-custom/fixture-model");
  assert.equal(custom.body.credentialType, "api_key");
  assert.equal(Object.hasOwn(custom.body, "apiKey"), false);
  assert.doesNotMatch(JSON.stringify(custom.body), new RegExp(secret));
  assert.equal(custom.headers["Cache-Control"], "no-store");
  assert.equal(provider.hits(), 0);

  const status = await get(controller, `/api/pi-auth/status?agent=${APP}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.model, "larkin-custom/fixture-model");
  assert.ok(status.body.credentials.some((entry) => entry.providerId === "larkin-custom" && entry.stored));
  assert.doesNotMatch(JSON.stringify(status.body), new RegExp(secret));

  const sibling = await get(controller, `/api/pi-auth/status?agent=${OTHER}`);
  assert.equal(sibling.status, 200);
  assert.equal(sibling.body.model, "kimi/kimi-k2.6");
  assert.equal((sibling.body.credentials || []).some((entry) => entry.providerId === "larkin-custom"), false);

  const known = await post(controller, "/api/pi-auth/login", {
    agentId: APP, preset: "zhipu", apiKey: secret,
  });
  assert.equal(known.status, 200, JSON.stringify(known.body));
  assert.equal(known.body.provider, "zai-coding-cn");
  assert.equal(known.body.model, "zai-coding-cn/glm-5.2");
  assert.doesNotMatch(JSON.stringify(known.body), new RegExp(secret));
  const afterKnown = await get(controller, `/api/pi-auth/status?agent=${APP}`);
  assert.equal(afterKnown.body.model, "zai-coding-cn/glm-5.2");
  assert.ok(afterKnown.body.credentials.some((entry) => entry.providerId === "zai-coding-cn" && entry.stored));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "config.json"), "utf8")).agents[OTHER].model, "kimi/kimi-k2.6");
});
