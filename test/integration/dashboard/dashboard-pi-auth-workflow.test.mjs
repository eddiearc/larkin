import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONTROLLER = pathToFileURL(path.join(ROOT, "dist/dashboard/dashboard-config-controller.mjs")).href;
const APP = "cli_dashboardWorkflowA1";

function seedHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-pi-auth-wf-"));
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-dashboard-pi-auth-wf", mentionPolicy: "require", activeAgent: APP,
    agents: {
      [APP]: { runtime: "pi", model: "deepseek/old", createdAt: "2026-09-04T00:00:00.000Z" },
    },
  })}\n`, { mode: 0o600 });
  fs.mkdirSync(path.join(root, "state", "agents", APP), { recursive: true, mode: 0o700 });
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
  const handled = await controller.handle(
    { method: "GET", headers: { host: "localhost:9996", "x-larkin-csrf": "test" } },
    response.res,
    new URL(pathname, "http://localhost"),
  );
  return { handled, ...response.value() };
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
  const handled = await controller.handle(request, response.res, new URL(pathname, "http://localhost"));
  return { handled, ...response.value() };
}

test("removed Dashboard pi-auth routes stay unhandled while /api/config still projects pi", async () => {
  const { createDashboardConfigController } = await import(`${CONTROLLER}?wf=${Date.now()}`);
  const f = seedHome();
  onTestFinished(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const controller = createDashboardConfigController({ csrfCapability: "test", env: f.env });

  const config = await get(controller, `/api/config?agent=${APP}`);
  assert.equal(config.handled, true);
  assert.equal(config.status, 200);
  assert.equal(config.body.agents[0].runtimeOption, "pi");
  assert.deepEqual(config.body.runtimeOptions, ["codex", "claude", "pi"]);
  assert.equal(config.headers["Cache-Control"], "no-store");

  const providers = await get(controller, "/api/pi-auth/providers");
  const status = await get(controller, `/api/pi-auth/status?agent=${APP}`);
  const login = await post(controller, "/api/pi-auth/login", {
    agentId: APP, preset: "deepseek", apiKey: "dashboard-workflow-super-secret",
  });
  const logout = await post(controller, "/api/pi-auth/logout", { agentId: APP, provider: "deepseek" });
  assert.deepEqual([providers.handled, status.handled, login.handled, logout.handled], [false, false, false, false]);
  assert.doesNotMatch(JSON.stringify(login.body), /dashboard-workflow-super-secret/);
});
