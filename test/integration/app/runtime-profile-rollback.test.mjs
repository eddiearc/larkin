import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { loadAndSyncRuntimeAgent } from "../../../dist/app/runtime-process.mjs";

process.env.LARKIN_BUN_TEST_RUNNER = "1";

function fixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-binding-${label}-`));
  fs.chmodSync(root, 0o700);
  const target = "cli_profileTargetA1";
  const other = "cli_profileOtherB2";
  const profileDir = path.join(root, "state", "agents", target, "lark-cli-config");
  const workspaceDir = path.join(profileDir, "lark-channel");
  const workspaceFile = path.join(workspaceDir, "config.json");
  const sourceDir = path.join(root, "state", "agents", target, "lark-channel-source");
  const sourceFile = path.join(sourceDir, "config.json");
  const botsDir = path.join(root, "bots");
  for (const directory of [profileDir, workspaceDir, sourceDir, botsDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: `server-${label}`, mentionPolicy: "require", activeAgent: target,
    agents: { [target]: { runtime: "codex", model: "gpt" }, [other]: { runtime: "codex", model: "gpt" } },
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(botsDir, `${target}.json`), JSON.stringify({
    appId: target, appSecret: "new-target-secret", tenant: "feishu", updatedAt: "2026-07-28T00:00:00.000Z",
  }), { mode: 0o600 });
  const workspaceBefore = Buffer.from(`${JSON.stringify({ apps: [{
    appId: other, appSecret: { source: "keychain", id: `appsecret:${other}` }, defaultAs: "bot", strictMode: "bot",
  }] }, null, 2)}\n`);
  const sourceBefore = Buffer.from(`${JSON.stringify({ accounts: { app: { id: other } } }, null, 2)}\n`);
  fs.writeFileSync(workspaceFile, workspaceBefore, { mode: 0o600 });
  fs.writeFileSync(sourceFile, sourceBefore, { mode: 0o600 });
  return { root, target, profileDir, workspaceFile, workspaceBefore, sourceFile, sourceBefore };
}

function fakeOfficialRunner({ fail = false, invalidWorkspace = false } = {}) {
  const calls = [];
  const runOfficialCli = (command, args, options) => {
    calls.push({ command, args: [...args], env: options.env, input: options.input });
    if (fail) return { status: 1, signal: null, stdout: "", stderr: "controlled failure new-target-secret", error: undefined };
    const projection = JSON.parse(fs.readFileSync(options.env.LARK_CHANNEL_CONFIG, "utf8"));
    const appId = projection.accounts.app.id;
    const file = path.join(options.env.LARKSUITE_CLI_CONFIG_DIR, "lark-channel", "config.json");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ apps: [{
      appId: invalidWorkspace ? "cli_wrong" : appId,
      appSecret: { source: "keychain", id: `appsecret:${appId}` },
      defaultAs: "bot", strictMode: "bot", users: [],
    }] }, null, 2)}\n`, { mode: 0o600 });
    return { status: 0, signal: null, stdout: JSON.stringify({ ok: true, workspace: "lark-channel", app_id: appId, identity: "bot-only" }), stderr: "", error: undefined };
  };
  return { calls, resolveOfficialCli: () => ({ command: "/usr/local/bin/lark-cli", argsPrefix: [], version: "1.0.79" }), runOfficialCli };
}

test("profile sync binds one Bot through the verified official lark-channel workspace without argv/stdin secret", () => {
  const f = fixture("exclusive-bot");
  const runner = fakeOfficialRunner();
  try {
    loadAndSyncRuntimeAgent({ ...process.env, LARKIN_CONFIG_DIR: f.root, LARKIN_HOME: f.root }, f.target, runner);
    assert.equal(runner.calls.length, 1);
    assert.deepEqual(runner.calls[0].args, ["config", "bind", "--source", "lark-channel", "--identity", "bot-only"]);
    assert.equal(runner.calls[0].input, undefined);
    assert.equal(runner.calls[0].env.LARK_CHANNEL, "1");
    assert.doesNotMatch(JSON.stringify(runner.calls[0]), /new-target-secret/);
    const published = JSON.parse(fs.readFileSync(f.workspaceFile, "utf8"));
    assert.equal(published.apps.length, 1);
    assert.deepEqual(published.apps[0], { appId: f.target,
      appSecret: { source: "keychain", id: `appsecret:${f.target}` }, defaultAs: "bot", strictMode: "bot", users: [] });
    const projectionText = fs.readFileSync(f.sourceFile, "utf8");
    assert.doesNotMatch(projectionText, /new-target-secret|appSecret/);
    const projection = JSON.parse(projectionText);
    assert.equal(projection.accounts.app.id, f.target);
    assert.deepEqual(projection.accounts.app.secret, { source: "exec", provider: "larkin-bot-credential", id: f.target });
    assert.equal(projection.secrets.providers["larkin-bot-credential"].env.LARKIN_AGENT_ID, f.target);
    assert.equal(fs.statSync(f.sourceFile).mode & 0o777, 0o600);
    loadAndSyncRuntimeAgent({ ...process.env, LARKIN_CONFIG_DIR: f.root, LARKIN_HOME: f.root }, f.target, runner);
    assert.equal(runner.calls.length, 1, "repeated startup/upsert must validate without another bind/keychain call");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("credential revision change causes exactly one new bind", () => {
  const f = fixture("credential-revision");
  const runner = fakeOfficialRunner();
  try {
    const env = { ...process.env, LARKIN_CONFIG_DIR: f.root, LARKIN_HOME: f.root };
    loadAndSyncRuntimeAgent(env, f.target, runner);
    loadAndSyncRuntimeAgent(env, f.target, runner);
    const credentialFile = path.join(f.root, "bots", `${f.target}.json`);
    fs.writeFileSync(credentialFile, JSON.stringify({ appId: f.target, appSecret: "rotated-target-secret",
      tenant: "feishu", updatedAt: "2026-07-29T00:00:00.000Z" }), { mode: 0o600 });
    loadAndSyncRuntimeAgent(env, f.target, runner);
    loadAndSyncRuntimeAgent(env, f.target, runner);
    assert.equal(runner.calls.length, 2, "one initial bind plus exactly one credential-revision rebind");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("capability-only credential metadata change performs zero bind/keychain calls", () => {
  const f = fixture("capability-metadata");
  const runner = fakeOfficialRunner();
  try {
    const env = { ...process.env, LARKIN_CONFIG_DIR: f.root, LARKIN_HOME: f.root };
    loadAndSyncRuntimeAgent(env, f.target, runner);
    const credentialFile = path.join(f.root, "bots", `${f.target}.json`);
    fs.writeFileSync(credentialFile, JSON.stringify({ appId: f.target, appSecret: "new-target-secret", tenant: "feishu",
      updatedAt: "2026-07-28T00:00:00.000Z", capabilities: { cardActionCallback: {
        status: "requested-unverified", requestedAt: "2026-07-29T00:00:00.000Z",
      } } }), { mode: 0o600 });
    loadAndSyncRuntimeAgent(env, f.target, runner);
    assert.equal(runner.calls.length, 1, "capability metadata must not trigger another bind");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const [label, options] of [["bind-failure", { fail: true }], ["workspace-mismatch", { invalidWorkspace: true }]]) {
  test(`${label} fails closed without claiming a keychain rollback`, () => {
    const f = fixture(label);
    const runner = fakeOfficialRunner(options);
    try {
      let message = "";
      assert.throws(() => loadAndSyncRuntimeAgent({ ...process.env, LARKIN_CONFIG_DIR: f.root, LARKIN_HOME: f.root }, f.target, runner), (error) => {
        message = error.message; return /结果未被证明可回滚.*fail-closed/.test(message);
      });
      assert.doesNotMatch(message, /new-target-secret/);
      if (label === "bind-failure") assert.deepEqual(fs.readFileSync(f.workspaceFile), f.workspaceBefore);
      assert.deepEqual(fs.readFileSync(f.sourceFile), f.sourceBefore);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("shim preflight failure happens before bind/keychain mutation", () => {
  const f = fixture("shim-rollback");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-binding-runtime-bin-outside-"));
  try {
    fs.symlinkSync(outside, path.join(f.root, "state", "agents", f.target, "runtime-bin"), "dir");
    const runner = fakeOfficialRunner();
    assert.throws(() => loadAndSyncRuntimeAgent({ ...process.env, LARKIN_CONFIG_DIR: f.root, LARKIN_HOME: f.root }, f.target, runner), /目录不安全/);
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(fs.readFileSync(f.workspaceFile), f.workspaceBefore);
    assert.deepEqual(fs.readFileSync(f.sourceFile), f.sourceBefore);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("post-bind validation failure preserves the observable keychain side effect and never reports file restore as binding rollback", () => {
  const f = fixture("keychain-side-effect");
  const keychain = new Map([[f.target, "prior-secret"]]);
  const runner = fakeOfficialRunner({ invalidWorkspace: true });
  const original = runner.runOfficialCli;
  runner.runOfficialCli = (...args) => {
    keychain.set(f.target, "new-target-secret");
    return original(...args);
  };
  try {
    let message = "";
    assert.throws(() => loadAndSyncRuntimeAgent({ ...process.env, LARKIN_CONFIG_DIR: f.root, LARKIN_HOME: f.root }, f.target, runner), (error) => {
      message = error.message; return true;
    });
    assert.equal(keychain.get(f.target), "new-target-secret");
    assert.doesNotMatch(message, /已恢复|原 binding 未变更/);
    assert.match(message, /结果未被证明可回滚/);
    assert.deepEqual(fs.readFileSync(f.sourceFile), f.sourceBefore, "new revision is not published until bind validation succeeds");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("invalid prior workspace fails before official CLI execution", () => {
  const f = fixture("invalid-prior");
  const runner = fakeOfficialRunner();
  try {
    fs.writeFileSync(f.workspaceFile, '{"apps":[', { mode: 0o600 });
    assert.throws(() => loadAndSyncRuntimeAgent({ ...process.env, LARKIN_CONFIG_DIR: f.root, LARKIN_HOME: f.root }, f.target, runner), /JSON|Unexpected|position|end/i);
    assert.equal(runner.calls.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
