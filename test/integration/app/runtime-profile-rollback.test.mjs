import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { loadAndSyncRuntimeAgent } from "../../../dist/app/runtime-process.mjs";

process.env.LARKIN_BUN_TEST_RUNNER = "1";

function fixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-profile-${label}-`));
  fs.chmodSync(root, 0o700);
  const target = "cli_profileTargetA1";
  const other = "cli_profileOtherB2";
  const profileDir = path.join(root, "state", "agents", target, "lark-cli-config");
  const botsDir = path.join(root, "bots");
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(botsDir, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: `server-${label}`, mentionPolicy: "require", activeAgent: target,
    agents: { [target]: { runtime: "codex", model: "gpt" }, [other]: { runtime: "codex", model: "gpt" } },
  }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(botsDir, `${target}.json`), JSON.stringify({
    appId: target, appSecret: "new-target-secret", tenant: "feishu",
  }), { mode: 0o600 });
  const profileFile = path.join(profileDir, "config.json");
  const before = Buffer.from(`${JSON.stringify({
    apps: [
      { name: target, appId: target, appSecret: "old-secret", brand: "feishu", defaultAs: "user", strictMode: "off", users: [{ refreshToken: "old-user-token" }] },
      { name: other, appId: other, appSecret: "other-secret", brand: "lark", users: [] },
    ],
    unrelated: { preserve: true },
  }, null, 2)}\n`);
  fs.writeFileSync(profileFile, before, { mode: 0o600 });
  const nativeCli = path.join(root, "fixture-global-lark-cli");
  fs.writeFileSync(nativeCli, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ name: "lark-cli", version: "fixture", runtimeDelegateProtocol: 1 })}'\n`, { mode: 0o700 });
  const runtimeDir = path.join(root, "runtime");
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  fs.writeFileSync(path.join(runtimeDir, "lark-cli.json"), `${JSON.stringify({
    protocolVersion: 1, version: "fixture", executable: fs.realpathSync(nativeCli),
  })}\n`, { mode: 0o600 });
  const canonicalNative = fs.realpathSync(nativeCli);
  return { root, target, profileDir, profileFile, before, nativeCli: canonicalNative,
    globalCli: { spawn: () => ({ status: 0, stdout: `__LARKIN_CLI_PATH__${canonicalNative}\n${JSON.stringify({ name: "lark-cli", version: "fixture", runtimeDelegateProtocol: 1 })}\n`, stderr: "" }) } };
}

function fakePinnedRunner({ failAt = null, injectToken = false } = {}) {
  const calls = [];
  const runPinnedCli = (command, args, options) => {
    calls.push({ command, args: [...args], secretInput: options.input });
    const configDir = options.env.LARKSUITE_CLI_CONFIG_DIR;
    const file = path.join(configDir, "config.json");
    const action = args[0] === "config" && args[1] === "init" ? "sync"
      : args.includes("default-as") ? "default-as"
        : args.includes("strict-mode") ? "strict-mode" : "unknown";
    if (failAt === action) return { status: 1, signal: null, stdout: "", stderr: "controlled failure", error: undefined };
    if (action === "sync") {
      const appId = args[args.indexOf("--app-id") + 1];
      const name = args[args.indexOf("--name") + 1];
      const brand = args[args.indexOf("--brand") + 1];
      fs.writeFileSync(file, `${JSON.stringify({ apps: [{
        name, appId, appSecret: options.input, brand, defaultAs: "auto", strictMode: "off", users: [],
      }] }, null, 2)}\n`, { mode: 0o600 });
    } else {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (action === "default-as") value.apps[0].defaultAs = "bot";
      if (action === "strict-mode") {
        value.apps[0].strictMode = "bot";
        if (injectToken) value.apps[0].users = [{ accessToken: "must-not-publish" }];
      }
      fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    }
    return { status: 0, signal: null, stdout: "", stderr: "", error: undefined };
  };
  return { calls, runPinnedCli };
}

test("profile sync uses the setup-recorded global command and publishes one Bot-only Agent config", () => {
  const f = fixture("exclusive-bot");
  const runner = fakePinnedRunner();
  try {
    loadAndSyncRuntimeAgent({ ...process.env, LARKIN_CONFIG_DIR: f.root, LARKIN_HOME: f.root, PATH: "/ambient-must-not-run" }, f.target, { ...runner, globalCli: f.globalCli });
    const published = JSON.parse(fs.readFileSync(f.profileFile, "utf8"));
    assert.equal(published.apps.length, 1);
    assert.deepEqual({ ...published.apps[0], appSecret: "<redacted>" }, {
      name: f.target, appId: f.target, appSecret: "<redacted>", brand: "feishu", defaultAs: "bot", strictMode: "bot", users: [],
    });
    assert.deepEqual(runner.calls.map((call) => call.args.slice(0, 4)), [
      ["config", "init", "--app-id", f.target],
      ["--profile", f.target, "config", "default-as"],
      ["--profile", f.target, "config", "strict-mode"],
    ]);
    for (const call of runner.calls) {
      assert.equal(call.command.command, f.nativeCli);
      assert.deepEqual(call.command.argsPrefix, []);
    }
    assert.equal(runner.calls[0].secretInput, "new-target-secret");
    assert.deepEqual(fs.readdirSync(f.profileDir).filter((name) => name.includes("profile-stage")), []);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const failure of ["strict-mode", "token-validation"]) {
  test(`profile ${failure} failure leaves the exact prior config unchanged and does not disclose the secret`, () => {
    const f = fixture(failure);
    const runner = fakePinnedRunner(failure === "strict-mode" ? { failAt: "strict-mode" } : { injectToken: true });
    try {
      let message = "";
      assert.throws(() => loadAndSyncRuntimeAgent({ ...process.env, LARKIN_CONFIG_DIR: f.root, LARKIN_HOME: f.root }, f.target, { ...runner, globalCli: f.globalCli }), (error) => {
        message = error.message;
        return /原 profile 未变更/.test(error.message);
      });
      assert.doesNotMatch(message, /new-target-secret|must-not-publish/);
      assert.deepEqual(fs.readFileSync(f.profileFile), f.before);
      assert.deepEqual(fs.readdirSync(f.profileDir).filter((name) => name.includes("profile-stage")), []);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("a post-publish binding failure atomically restores the exact previous config", () => {
  const f = fixture("publish-rollback");
  const runner = fakePinnedRunner();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-profile-runtime-bin-outside-"));
  try {
    const bindingDir = path.join(f.root, "state", "agents", f.target, "runtime-cli-binding");
    fs.symlinkSync(outside, bindingDir, "dir");
    assert.throws(() => loadAndSyncRuntimeAgent({ ...process.env, LARKIN_CONFIG_DIR: f.root, LARKIN_HOME: f.root }, f.target, { ...runner, globalCli: f.globalCli }), /Runtime CLI 目录.*已恢复此前 profile/);
    assert.deepEqual(fs.readFileSync(f.profileFile), f.before);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("invalid prior profile fails before recorded global CLI execution", () => {
  const f = fixture("invalid-prior");
  const runner = fakePinnedRunner();
  try {
    fs.writeFileSync(f.profileFile, '{"apps":[', { mode: 0o600 });
    assert.throws(() => loadAndSyncRuntimeAgent({ ...process.env, LARKIN_CONFIG_DIR: f.root, LARKIN_HOME: f.root }, f.target, runner), /JSON|Unexpected|position|end/i);
    assert.equal(runner.calls.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
