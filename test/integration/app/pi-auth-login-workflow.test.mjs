import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const ENTRY = path.join(ROOT, "dist/app/binary-entry.mjs");

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
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        hits: () => hits,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("compiled CLI login custom --api-key-stdin configures one Agent without leaking the key or touching a sibling", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-auth-workflow-"));
  const target = "cli_workflowTargetA1";
  const other = "cli_workflowOtherB2";
  const secret = "workflow-stdin-super-secret";
  const provider = await startFakeProvider();
  try {
    fs.chmodSync(temp, 0o700);
    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-workflow", mentionPolicy: "require", activeAgent: target,
      agents: {
        [target]: { runtime: "pi", piDistribution: "builtin", model: "deepseek/old-model", createdAt: "2026-09-04T00:00:00.000Z" },
        [other]: { runtime: "pi", piDistribution: "builtin", model: "kimi/kimi-k2.6", createdAt: "2026-09-04T00:00:00.000Z" },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    for (const agentId of [target, other]) {
      const directory = path.join(temp, "providers", "pi", agentId);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
    }
    fs.writeFileSync(path.join(temp, "providers", "pi", other, "auth.json"), `${JSON.stringify({
      "moonshotai-cn": { type: "api_key", key: "other-agent-secret" },
    }, null, 2)}\n`, { mode: 0o600 });
    const env = { ...process.env, LARKIN_CONFIG_DIR: temp, LARKIN_HOME: temp };
    const login = spawnSync(process.execPath, [
      ENTRY, "pi-auth", "login", "custom", "--agent", target,
      "--base-url", provider.baseUrl, "--model", "fixture-model", "--api-key-stdin", "--json",
    ], { cwd: ROOT, env, encoding: "utf8", input: `${secret}\n\n`, timeout: 30_000 });
    assert.equal(login.status, 0, login.stderr + login.stdout);
    const payload = JSON.parse(login.stdout);
    assert.equal(payload.agentId, target);
    assert.equal(payload.provider, "larkin-custom");
    assert.equal(payload.model, "larkin-custom/fixture-model");
    assert.equal(payload.credentialType, "api_key");
    assert.ok(["saved_not_applied", "pending", "applied"].includes(payload.applyState));
    assert.doesNotMatch(login.stdout + login.stderr, new RegExp(secret));

    const capturedArgv = spawnSync(process.execPath, [
      ENTRY, "pi-auth", "login", "custom", "--agent", target, "--base-url", provider.baseUrl,
      "--model", "fixture-model", "--api-key", secret,
    ], { cwd: ROOT, env, encoding: "utf8", timeout: 15_000 });
    assert.notEqual(capturedArgv.status, 0);
    assert.doesNotMatch(`${capturedArgv.stdout}\n${capturedArgv.stderr}`, new RegExp(secret));

    const status = spawnSync(process.execPath, [ENTRY, "pi-auth", "status", "--agent", target, "--json"], {
      cwd: ROOT, env, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(status.status, 0, status.stderr);
    const credentials = JSON.parse(status.stdout).credentials;
    assert.ok(credentials.some((entry) => entry.providerId === "larkin-custom" && entry.credentialType === "api_key" && entry.stored));
    assert.doesNotMatch(status.stdout + status.stderr, new RegExp(secret));

    const config = JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8"));
    assert.equal(config.agents[target].model, "larkin-custom/fixture-model");
    assert.equal(config.agents[other].model, "kimi/kimi-k2.6");
    const otherAuth = JSON.parse(fs.readFileSync(path.join(temp, "providers", "pi", other, "auth.json"), "utf8"));
    assert.equal(otherAuth["moonshotai-cn"].key, "other-agent-secret");
    const authPath = path.join(temp, "providers", "pi", target, "auth.json");
    assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(authPath)).mode & 0o777, 0o700);
    const models = JSON.parse(fs.readFileSync(path.join(temp, "providers", "pi", target, "models.json"), "utf8"));
    assert.equal(models.providers["larkin-custom"].baseUrl, provider.baseUrl.replace(/\/$/, ""));
    assert.doesNotMatch(fs.readFileSync(path.join(temp, "providers", "pi", target, "models.json"), "utf8"), new RegExp(secret));
    assert.equal(provider.hits(), 0, "save must not validate against the fake provider");
  } finally {
    await provider.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("compiled CLI login known preset --api-key-stdin binds the default model without a provider HTTP round-trip", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-auth-preset-"));
  const target = "cli_workflowPresetA1";
  const other = "cli_workflowPresetB2";
  const secret = "workflow-preset-super-secret";
  try {
    fs.chmodSync(temp, 0o700);
    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-workflow-preset", mentionPolicy: "require", activeAgent: target,
      agents: {
        [target]: { runtime: "pi", piDistribution: "builtin", model: "deepseek/old-model", createdAt: "2026-09-04T00:00:00.000Z" },
        [other]: { runtime: "pi", piDistribution: "builtin", model: "kimi/kimi-k2.6", createdAt: "2026-09-04T00:00:00.000Z" },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    for (const agentId of [target, other]) {
      fs.mkdirSync(path.join(temp, "providers", "pi", agentId), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.join(temp, "providers", "pi", agentId), 0o700);
    }
    const env = { ...process.env, LARKIN_CONFIG_DIR: temp, LARKIN_HOME: temp, HOME: temp };
    const login = spawnSync(process.execPath, [
      ENTRY, "pi-auth", "login", "zhipu", "--agent", target, "--api-key-stdin", "--json",
    ], { cwd: ROOT, env, encoding: "utf8", input: `${secret}\r\n\n`, timeout: 30_000 });
    assert.equal(login.status, 0, login.stderr + login.stdout);
    const payload = JSON.parse(login.stdout);
    assert.equal(payload.provider, "zai-coding-cn");
    assert.equal(payload.model, "zai-coding-cn/glm-5.2");
    assert.equal(payload.credentialType, "api_key");
    assert.doesNotMatch(login.stdout + login.stderr, new RegExp(secret));
    const status = spawnSync(process.execPath, [ENTRY, "pi-auth", "status", "--agent", target, "--json"], {
      cwd: ROOT, env, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(status.status, 0, status.stderr);
    const credentials = JSON.parse(status.stdout).credentials;
    assert.ok(credentials.some((entry) => entry.providerId === "zai-coding-cn" && entry.stored));
    assert.doesNotMatch(status.stdout + status.stderr, new RegExp(secret));
    const config = JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8"));
    assert.equal(config.agents[target].model, "zai-coding-cn/glm-5.2");
    assert.equal(config.agents[other].model, "kimi/kimi-k2.6");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("compiled-service cancellation rolls back the target credential transaction", async () => {
  const { configureBuiltinPiProvider } = await import(new URL(`file://${path.join(ROOT, "dist/runtime/pi-provider-login.mjs")}`).href);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-auth-cancel-"));
  const target = "cli_workflowCancelA1";
  const original = { keep: { type: "api_key", key: "original-secret" } };
  try {
    fs.chmodSync(temp, 0o700);
    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-workflow-cancel", mentionPolicy: "require", activeAgent: target,
      agents: { [target]: { runtime: "pi", piDistribution: "builtin", model: "deepseek/old-model", createdAt: "2026-09-04T00:00:00.000Z" } },
    }, null, 2)}\n`, { mode: 0o600 });
    const directory = path.join(temp, "providers", "pi", target);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(path.join(directory, "auth.json"), `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
    const env = { ...process.env, LARKIN_CONFIG_DIR: temp, LARKIN_HOME: temp };
    await assert.rejects(() => configureBuiltinPiProvider({
      agentId: target, preset: "deepseek", apiKey: "cancel-workflow-secret", env,
    }, {
      createRuntime: async () => ({}),
      runLogin: async () => {
        const error = new Error("Pi auth login cancelled");
        error.name = "AbortError";
        throw error;
      },
    }), /cancelled/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "auth.json"), "utf8")), original);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8")).agents[target].model, "deepseek/old-model");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
