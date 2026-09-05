import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");

async function loadLogin() {
  return import(`${pathToFileURL(path.join(ROOT, "dist/runtime/pi-provider-login.mjs")).href}?t=${Date.now()}`);
}

function pathToFileURL(file) {
  return new URL(`file://${file}`);
}

function seedHome(options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-provider-login-"));
  fs.chmodSync(temp, 0o700);
  const target = options.targetId || "cli_loginTargetA1";
  const other = options.otherId || "cli_loginOtherB2";
  const agents = {
    [target]: { runtime: "pi", piDistribution: "builtin", model: "deepseek/old-model", createdAt: "2026-09-04T00:00:00.000Z" },
    [other]: { runtime: "pi", piDistribution: "builtin", model: "kimi/kimi-k2.6", createdAt: "2026-09-04T00:00:00.000Z" },
  };
  if (options.extraAgents) Object.assign(agents, options.extraAgents);
  fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-login", mentionPolicy: "require", activeAgent: target, agents,
  }, null, 2)}\n`, { mode: 0o600 });
  for (const agentId of Object.keys(agents)) {
    const directory = path.join(temp, "providers", "pi", agentId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  if (options.otherAuth) {
    fs.writeFileSync(path.join(temp, "providers", "pi", other, "auth.json"), `${JSON.stringify(options.otherAuth, null, 2)}\n`, { mode: 0o600 });
  }
  if (options.targetAuth) {
    fs.writeFileSync(path.join(temp, "providers", "pi", target, "auth.json"), `${JSON.stringify(options.targetAuth, null, 2)}\n`, { mode: 0o600 });
  }
  const env = { ...process.env, LARKIN_CONFIG_DIR: temp, LARKIN_HOME: temp };
  return { temp, target, other, env };
}

function writeLogin(authFile, providerId, key) {
  const current = fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, "utf8")) : {};
  current[providerId] = { type: "api_key", key };
  fs.writeFileSync(authFile, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}

test("known preset login writes only the target Agent, binds the default model, and skips upsert when daemon is not owned", async () => {
  const { configureBuiltinPiProvider } = await loadLogin();
  const { temp, target, other, env } = seedHome({
    otherAuth: { "moonshotai-cn": { type: "api_key", key: "keep-other-secret" } },
    targetAuth: { unrelated: { type: "api_key", key: "keep-target-unrelated" } },
  });
  try {
    const upserts = [];
    const result = await configureBuiltinPiProvider({
      agentId: target, preset: "deepseek", apiKey: "target-login-secret", env,
    }, {
      createRuntime: async () => ({}),
      runLogin: async (_runtime, providerId) => {
        writeLogin(path.join(temp, "providers", "pi", target, "auth.json"), providerId, "target-login-secret");
        return { type: "api_key", key: "target-login-secret" };
      },
      readProcessState: () => ({ daemon: { state: "absent" }, supervisor: { state: "absent" } }),
      requestUpsert: async (input) => { upserts.push(input); return { ok: true }; },
    });
    assert.deepEqual({
      agentId: result.agentId, provider: result.provider, model: result.model,
      credentialType: result.credentialType, applyState: result.applyState,
    }, {
      agentId: target, provider: "deepseek", model: "deepseek/deepseek-v4-pro",
      credentialType: "api_key", applyState: "saved_not_applied",
    });
    assert.equal(upserts.length, 0);
    const auth = JSON.parse(fs.readFileSync(path.join(temp, "providers", "pi", target, "auth.json"), "utf8"));
    assert.equal(auth.deepseek.key, "target-login-secret");
    assert.equal(auth.unrelated.key, "keep-target-unrelated");
    const otherAuth = JSON.parse(fs.readFileSync(path.join(temp, "providers", "pi", other, "auth.json"), "utf8"));
    assert.deepEqual(otherAuth, { "moonshotai-cn": { type: "api_key", key: "keep-other-secret" } });
    const config = JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8"));
    assert.equal(config.agents[target].model, "deepseek/deepseek-v4-pro");
    assert.equal(config.agents[other].model, "kimi/kimi-k2.6");
    assert.equal(fs.statSync(path.join(temp, "providers", "pi", target)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(temp, "providers", "pi", target, "auth.json")).mode & 0o777, 0o600);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("custom OpenAI-compatible login writes models.json without the secret and rolls back on login failure", async () => {
  const { configureBuiltinPiProvider } = await loadLogin();
  const { temp, target, env } = seedHome({
    targetAuth: { keep: { type: "api_key", key: "original-secret" } },
  });
  const modelsBefore = { providers: { keep: { baseUrl: "https://keep.example/v1" } } };
  fs.writeFileSync(path.join(temp, "providers", "pi", target, "models.json"), `${JSON.stringify(modelsBefore, null, 2)}\n`, { mode: 0o600 });
  try {
    await assert.rejects(() => configureBuiltinPiProvider({
      agentId: target, preset: "custom", apiKey: "custom-super-secret",
      baseUrl: "https://gateway.example/v1", model: "acme-code", env,
    }, {
      createRuntime: async () => ({}),
      runLogin: async () => { throw new Error(`login failed key=custom-super-secret`); },
    }), (error) => {
      assert.match(error.message, /login failed|redacted/i);
      assert.doesNotMatch(error.message, /custom-super-secret/);
      return true;
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, "providers", "pi", target, "auth.json"), "utf8")), {
      keep: { type: "api_key", key: "original-secret" },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, "providers", "pi", target, "models.json"), "utf8")), modelsBefore);
    const config = JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8"));
    assert.equal(config.agents[target].model, "deepseek/old-model");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("custom login success binds larkin-custom/<model> and surfaces pending apply without claiming a running change", async () => {
  const { configureBuiltinPiProvider } = await loadLogin();
  const { temp, target, other, env } = seedHome();
  try {
    const upserts = [];
    const result = await configureBuiltinPiProvider({
      agentId: target, preset: "custom", apiKey: "custom-ok-secret",
      baseUrl: "http://127.0.0.1:8123/v1", model: "fixture-model", env,
    }, {
      createRuntime: async () => ({}),
      runLogin: async (_runtime, providerId) => {
        writeLogin(path.join(temp, "providers", "pi", target, "auth.json"), providerId, "custom-ok-secret");
        return { type: "api_key", key: "custom-ok-secret" };
      },
      readProcessState: () => ({ daemon: { state: "owned" }, supervisor: { state: "owned" } }),
      requestUpsert: async (input) => {
        upserts.push(input.agentId);
        return { ok: false, error: "agent busy" };
      },
    });
    assert.equal(result.provider, "larkin-custom");
    assert.equal(result.model, "larkin-custom/fixture-model");
    assert.equal(result.applyState, "pending");
    assert.match(result.applyError, /busy/i);
    assert.deepEqual(upserts, [target]);
    const models = JSON.parse(fs.readFileSync(path.join(temp, "providers", "pi", target, "models.json"), "utf8"));
    assert.equal(models.providers["larkin-custom"].baseUrl, "http://127.0.0.1:8123/v1");
    assert.doesNotMatch(fs.readFileSync(path.join(temp, "providers", "pi", target, "models.json"), "utf8"), /custom-ok-secret/);
    assert.equal(fs.existsSync(path.join(temp, "providers", "pi", other, "auth.json")), false);
    const config = JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8"));
    assert.equal(config.agents[other].model, "kimi/kimi-k2.6");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("non-builtin Agents and host fallback are rejected", async () => {
  const { configureBuiltinPiProvider, sanitizeProviderLoginError } = await loadLogin();
  const { temp, target, env } = seedHome({
    extraAgents: { cli_codexA1: { runtime: "codex", model: "gpt-5.6-sol", createdAt: "2026-09-04T00:00:00.000Z" } },
  });
  const home = path.join(temp, "home");
  const hostAuth = path.join(home, ".pi", "auth.json");
  fs.mkdirSync(path.dirname(hostAuth), { recursive: true, mode: 0o700 });
  const hostBytes = `${JSON.stringify({ deepseek: { type: "api_key", key: "host-global-secret" } }, null, 2)}\n`;
  fs.writeFileSync(hostAuth, hostBytes, { mode: 0o600 });
  env.HOME = home;
  env.USERPROFILE = home;
  try {
    await assert.rejects(() => configureBuiltinPiProvider({
      agentId: "cli_codexA1", preset: "deepseek", apiKey: "should-not-store", env,
    }), /不是内置 Pi/);
    assert.equal(fs.existsSync(path.join(temp, "providers", "pi", "cli_codexA1", "auth.json")), false);
    const result = await configureBuiltinPiProvider({
      agentId: target, preset: "deepseek", apiKey: "target-only-secret", env,
    }, {
      createRuntime: async () => ({}),
      runLogin: async (_runtime, providerId) => {
        writeLogin(path.join(temp, "providers", "pi", target, "auth.json"), providerId, "target-only-secret");
        return { type: "api_key", key: "target-only-secret" };
      },
      readProcessState: () => ({ daemon: { state: "absent" }, supervisor: { state: "absent" } }),
      requestUpsert: async () => ({ ok: true }),
    });
    assert.equal(result.provider, "deepseek");
    assert.equal(fs.readFileSync(hostAuth, "utf8"), hostBytes, "host ~/.pi must remain unread and unchanged");
    assert.doesNotMatch(fs.readFileSync(path.join(temp, "providers", "pi", target, "auth.json"), "utf8"), /host-global-secret/);
    const leaked = sanitizeProviderLoginError(new Error("failed Authorization: Bearer should-not-store api_key=should-not-store"), "should-not-store");
    assert.doesNotMatch(leaked, /should-not-store/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("login cancels roll back owned credential files and leaves sibling Agents untouched", async () => {
  const { configureBuiltinPiProvider } = await loadLogin();
  const { temp, target, other, env } = seedHome({
    targetAuth: { keep: { type: "api_key", key: "original-secret" } },
    otherAuth: { "moonshotai-cn": { type: "api_key", key: "keep-other-secret" } },
  });
  const modelsBefore = { providers: { keep: { baseUrl: "https://keep.example/v1" } } };
  fs.writeFileSync(path.join(temp, "providers", "pi", target, "models.json"), `${JSON.stringify(modelsBefore, null, 2)}\n`, { mode: 0o600 });
  try {
    await assert.rejects(() => configureBuiltinPiProvider({
      agentId: target, preset: "custom", apiKey: "cancel-secret",
      baseUrl: "http://127.0.0.1:1/v1", model: "fixture-model", env,
    }, {
      createRuntime: async () => ({}),
      runLogin: async () => {
        const error = new Error("Pi auth login cancelled");
        error.name = "AbortError";
        throw error;
      },
    }), /cancelled|redacted/i);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, "providers", "pi", target, "auth.json"), "utf8")), {
      keep: { type: "api_key", key: "original-secret" },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, "providers", "pi", target, "models.json"), "utf8")), modelsBefore);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, "providers", "pi", other, "auth.json"), "utf8")), {
      "moonshotai-cn": { type: "api_key", key: "keep-other-secret" },
    });
    const config = JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8"));
    assert.equal(config.agents[target].model, "deepseek/old-model");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("targeted apply errors redact the submitted API key", async () => {
  const { configureBuiltinPiProvider } = await loadLogin();
  const { temp, target, env } = seedHome();
  const secret = "apply-error-super-secret";
  try {
    const upserted = await configureBuiltinPiProvider({
      agentId: target, preset: "deepseek", apiKey: secret, env,
    }, {
      createRuntime: async () => ({}),
      runLogin: async (_runtime, providerId) => {
        writeLogin(path.join(temp, "providers", "pi", target, "auth.json"), providerId, secret);
        return { type: "api_key", key: secret };
      },
      readProcessState: () => ({ daemon: { state: "owned" }, supervisor: { state: "owned" } }),
      requestUpsert: async () => ({ ok: false, error: `upsert failed key=${secret}` }),
    });
    assert.equal(upserted.applyState, "pending");
    assert.match(upserted.applyError, /\[redacted\]/);
    assert.doesNotMatch(upserted.applyError, new RegExp(secret));

    const thrown = await configureBuiltinPiProvider({
      agentId: target, preset: "deepseek", apiKey: secret, env,
    }, {
      createRuntime: async () => ({}),
      runLogin: async (_runtime, providerId) => {
        writeLogin(path.join(temp, "providers", "pi", target, "auth.json"), providerId, secret);
        return { type: "api_key", key: secret };
      },
      readProcessState: () => ({ daemon: { state: "owned" }, supervisor: { state: "owned" } }),
      requestUpsert: async () => { throw new Error(`hot upsert exploded ${secret}`); },
    });
    assert.equal(thrown.applyState, "pending");
    assert.match(thrown.applyError, /\[redacted\]/);
    assert.doesNotMatch(thrown.applyError, new RegExp(secret));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("a post-mutation runtime switch cannot hot-reload the switched Agent", async () => {
  const { configureBuiltinPiProvider } = await loadLogin();
  const { mutateConfig, runtimeConfigSignature } = await import(`${pathToFileURL(path.join(ROOT, "dist/platform/config.mjs")).href}?t=${Date.now()}`);
  const { loadAndSyncRuntimeAgent } = await import(`${pathToFileURL(path.join(ROOT, "dist/app/runtime-process.mjs")).href}?t=${Date.now()}`);
  const { temp, target, other, env } = seedHome();
  const secret = "post-mutate-toctou-secret";
  const upserts = [];
  const reloads = [];
  const appliedMarks = [];
  let expectedAfterMutate;
  try {
    const result = await configureBuiltinPiProvider({
      agentId: target, preset: "deepseek", apiKey: secret, env,
    }, {
      createRuntime: async () => ({}),
      runLogin: async (_runtime, providerId) => {
        writeLogin(path.join(temp, "providers", "pi", target, "auth.json"), providerId, secret);
        return { type: "api_key", key: secret };
      },
      mutateConfig: (mutateEnv, mutation, authority) => {
        const mutated = mutateConfig(mutateEnv, mutation, authority);
        expectedAfterMutate = runtimeConfigSignature(mutated.config, target);
        return mutated;
      },
      readProcessState: () => ({ daemon: { state: "owned" }, supervisor: { state: "owned" } }),
      requestUpsert: async (input) => {
        mutateConfig(env, { kind: "set-agent-pi-distribution", agentId: target, distribution: "external" }, { kind: "user" });
        upserts.push({
          agentId: input.agentId,
          expectedSignature: input.expectedSignature,
          other: input.agentId === other,
        });
        try {
          const agent = loadAndSyncRuntimeAgent(env, input.agentId, {
            runOfficialCli: () => {
              reloads.push("synced");
              throw new Error("profile sync must not run after a runtime switch");
            },
          }, { expectedSignature: input.expectedSignature });
          reloads.push(agent.runtime, agent.piDistribution);
          return { ok: true, operationId: "op", agentId: input.agentId };
        } catch (error) {
          reloads.push("rejected");
          return { ok: false, operationId: "op", agentId: input.agentId,
            error: error instanceof Error ? error.message : String(error) };
        }
      },
      markApplied: (_env, agentId, signature) => { appliedMarks.push({ agentId, signature }); },
    });
    assert.equal(result.applyState, "pending");
    assert.match(result.applyError, /配置在 apply 期间发生变化|未热加载/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].agentId, target);
    assert.equal(upserts[0].expectedSignature, expectedAfterMutate);
    assert.match(upserts[0].expectedSignature, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(reloads, ["rejected"]);
    assert.deepEqual(appliedMarks, []);
    const config = JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8"));
    assert.equal(config.agents[target].runtime, "pi");
    assert.equal(config.agents[target].piDistribution, "external");
    assert.equal(config.agents[target].model, "deepseek/deepseek-v4-pro");
    assert.equal(config.agents[other].model, "kimi/kimi-k2.6");
    const auth = JSON.parse(fs.readFileSync(path.join(temp, "providers", "pi", target, "auth.json"), "utf8"));
    assert.equal(auth.deepseek.key, secret);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("a concurrent runtime switch cannot bind a builtin model or upsert the switched Agent", async () => {
  const { configureBuiltinPiProvider } = await loadLogin();
  const { mutateConfig } = await import(`${pathToFileURL(path.join(ROOT, "dist/platform/config.mjs")).href}?t=${Date.now()}`);
  const { temp, target, other, env } = seedHome();
  const upserts = [];
  try {
    await assert.rejects(() => configureBuiltinPiProvider({
      agentId: target, preset: "deepseek", apiKey: "toctou-secret", env,
    }, {
      createRuntime: async () => ({}),
      runLogin: async (_runtime, providerId) => {
        writeLogin(path.join(temp, "providers", "pi", target, "auth.json"), providerId, "toctou-secret");
        return { type: "api_key", key: "toctou-secret" };
      },
      mutateConfig: (mutateEnv, mutation, authority) => {
        mutateConfig(mutateEnv, { kind: "set-agent-runtime", agentId: target, runtime: "codex", model: "gpt-5.6-sol" }, { kind: "user" });
        return mutateConfig(mutateEnv, mutation, authority);
      },
      readProcessState: () => ({ daemon: { state: "owned" }, supervisor: { state: "owned" } }),
      requestUpsert: async (input) => { upserts.push(input.agentId); return { ok: true }; },
    }), /不是内置 Pi/);
    const config = JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8"));
    assert.equal(config.agents[target].runtime, "codex");
    assert.equal(config.agents[target].model, "gpt-5.6-sol");
    assert.equal(config.agents[other].model, "kimi/kimi-k2.6");
    assert.deepEqual(upserts, []);
    assert.equal(fs.existsSync(path.join(temp, "providers", "pi", target, "auth.json")), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
