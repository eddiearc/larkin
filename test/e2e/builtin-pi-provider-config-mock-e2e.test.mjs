import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("credential-present target apply observes only the configured Agent", async () => {
  const { configureBuiltinPiProvider } = await import(pathToFileURL(path.join(ROOT, "dist/runtime/pi-provider-login.mjs")).href);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-provider-mock-e2e-"));
  const target = "cli_mockTargetA1";
  const other = "cli_mockOtherB2";
  try {
    fs.chmodSync(temp, 0o700);
    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-mock-e2e", mentionPolicy: "require", activeAgent: target,
      agents: {
        [target]: { runtime: "pi", piDistribution: "builtin", model: "default", createdAt: "2026-09-04T00:00:00.000Z" },
        [other]: { runtime: "pi", piDistribution: "builtin", model: "kimi/kimi-k2.6", createdAt: "2026-09-04T00:00:00.000Z" },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    for (const agentId of [target, other]) {
      const directory = path.join(temp, "providers", "pi", agentId);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
    }
    const otherAuth = { "moonshotai-cn": { type: "api_key", key: "sibling-secret" } };
    fs.writeFileSync(path.join(temp, "providers", "pi", other, "auth.json"), `${JSON.stringify(otherAuth, null, 2)}\n`, { mode: 0o600 });
    const env = { ...process.env, LARKIN_CONFIG_DIR: temp, LARKIN_HOME: temp };
    const upserts = [];
    const result = await configureBuiltinPiProvider({
      agentId: target, preset: "zhipu", apiKey: "target-recovery-secret", env,
    }, {
      createRuntime: async () => ({}),
      runLogin: async (_runtime, providerId) => {
        const authFile = path.join(temp, "providers", "pi", target, "auth.json");
        fs.writeFileSync(authFile, `${JSON.stringify({ [providerId]: { type: "api_key", key: "target-recovery-secret" } }, null, 2)}\n`, { mode: 0o600 });
        return { type: "api_key", key: "target-recovery-secret" };
      },
      readProcessState: () => ({ daemon: { state: "owned" }, supervisor: { state: "owned" } }),
      requestUpsert: async (input) => {
        upserts.push(input.agentId);
        return { ok: true, operationId: "op", agentId: input.agentId };
      },
      markApplied: () => {},
    });
    assert.equal(result.provider, "zai-coding-cn");
    assert.equal(result.model, "zai-coding-cn/glm-5.2");
    assert.equal(result.applyState, "applied");
    assert.deepEqual(upserts, [target], "targeted hot upsert must not touch the sibling Agent");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, "providers", "pi", other, "auth.json"), "utf8")), otherAuth);
    const config = JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8"));
    assert.equal(config.agents[other].model, "kimi/kimi-k2.6");
    assert.equal(config.agents[target].model, "zai-coding-cn/glm-5.2");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
