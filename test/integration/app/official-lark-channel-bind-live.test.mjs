import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { loadAndSyncRuntimeAgent } from "../../../dist/app/runtime-process.mjs";

// The official macOS backend reaches the user's system Keychain even with an
// isolated HOME and can show interactive master.key prompts. Keep this Real
// CLI evidence runnable on non-macOS CI; macOS requires a separately designed
// keychain-safe harness instead of silently touching the user's keychain.
const RUN = process.env.LARKIN_RUN_OFFICIAL_LARK_CHANNEL_BIND === "1" && process.platform !== "darwin";
const VERSION = "1.0.79";

function privateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

test.skipIf(!RUN)("published lark-cli binds two isolated lark-channel Bot workspaces and fails closed when unbound", { timeout: 5 * 60_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-official-lark-channel-bind-"));
  const home = path.join(root, "home");
  const prefix = path.join(root, "npm-prefix");
  const cleanupEnvs = [];
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    execFileSync("npm", ["install", "--prefix", prefix, `@larksuite/cli@${VERSION}`], {
      cwd: root, env: { ...process.env, HOME: home }, stdio: "pipe", timeout: 2 * 60_000,
    });
    const cli = path.join(prefix, "node_modules", ".bin", "lark-cli");
    assert.match(execFileSync(cli, ["--version"], { encoding: "utf8", env: { ...process.env, HOME: home } }), /1\.0\.79/);
    assert.match(execFileSync(cli, ["config", "bind", "--help"], { encoding: "utf8", env: { ...process.env, HOME: home } }), /lark-channel/);

    const unboundRoot = path.join(root, "unbound", "lark-cli-config");
    privateJson(path.join(unboundRoot, "config.json"), { apps: [{ appId: "cli_local_must_not_fallback", appSecret: "local-secret", defaultAs: "bot", strictMode: "bot" }] });
    const unbound = spawnSync(cli, ["config", "show"], {
      encoding: "utf8", env: { ...process.env, HOME: home, LARK_CHANNEL: "1", LARKSUITE_CLI_CONFIG_DIR: unboundRoot },
    });
    assert.equal(unbound.status, 3, unbound.stderr || unbound.stdout);
    assert.match(`${unbound.stdout}${unbound.stderr}`, /not_configured/);
    assert.match(`${unbound.stdout}${unbound.stderr}`, /lark-channel/);
    assert.doesNotMatch(`${unbound.stdout}${unbound.stderr}`, /cli_local_must_not_fallback/);

    const appIds = ["cli_larkinBindAgentA", "cli_larkinBindAgentB"];
    const larkinRoot = path.join(root, "larkin");
    fs.mkdirSync(path.join(larkinRoot, "bots"), { recursive: true, mode: 0o700 });
    privateJson(path.join(larkinRoot, "config.json"), {
      version: 4, serverId: "official-bind", mentionPolicy: "require", activeAgent: appIds[0],
      agents: Object.fromEntries(appIds.map((appId) => [appId, { runtime: "codex", model: "default" }])),
    });
    for (const [index, appId] of appIds.entries()) privateJson(path.join(larkinRoot, "bots", `${appId}.json`), {
      appId, appSecret: `bind-secret-${index + 1}`, tenant: index === 0 ? "feishu" : "lark",
    });
    const workspaceFiles = [];
    for (const [index, appId] of appIds.entries()) {
      const stateDir = path.join(larkinRoot, "state", "agents", appId);
      const sourceDir = path.join(stateDir, "lark-channel-source");
      const sourceFile = path.join(sourceDir, "config.json");
      const baseConfigDir = path.join(stateDir, "lark-cli-config");
      const env = {
        ...process.env, HOME: home, LARKIN_CONFIG_DIR: larkinRoot, LARKIN_HOME: larkinRoot,
        LARKIN_BINARY_ENTRY_PATH: path.join(path.resolve(import.meta.dirname, "../../.."), "dist", "app", "binary-entry.mjs"),
      };
      loadAndSyncRuntimeAgent(env, appId, {
        resolveOfficialCli: () => ({ command: cli, argsPrefix: [], version: VERSION }),
      });
      const workspaceEnv = { ...env, LARK_CHANNEL: "1", LARK_CHANNEL_CONFIG: sourceFile, LARKSUITE_CLI_CONFIG_DIR: baseConfigDir };
      cleanupEnvs.push(workspaceEnv);
      const workspaceFile = path.join(baseConfigDir, "lark-channel", "config.json");
      workspaceFiles.push(workspaceFile);
      const workspace = JSON.parse(fs.readFileSync(workspaceFile, "utf8"));
      assert.equal(workspace.apps.length, 1);
      assert.equal(workspace.apps[0].appId, appId);
      assert.equal(workspace.apps[0].defaultAs, "bot");
      assert.equal(workspace.apps[0].strictMode, "bot");
      assert.equal(workspace.apps[0].appSecret?.source, "keychain");
      const projectionText = fs.readFileSync(sourceFile, "utf8");
      assert.doesNotMatch(projectionText, new RegExp(`bind-secret-${index + 1}`));
      const projection = JSON.parse(projectionText);
      assert.deepEqual(projection.accounts.app.secret, { source: "exec", provider: "larkin-bot-credential", id: appId });
      assert.equal(projection.secrets.providers["larkin-bot-credential"].source, "exec");
      assert.equal(projection.secrets.providers["larkin-bot-credential"].env.LARKIN_AGENT_ID, appId);
      assert.equal(mode(sourceDir), 0o700);
      assert.equal(mode(sourceFile), 0o600);
      assert.equal(mode(path.join(larkinRoot, "bots", `${appId}.json`)), 0o600);
      assert.equal(mode(path.dirname(workspaceFile)), 0o700);
      assert.equal(mode(workspaceFile), 0o600);
    }
    assert.notEqual(fs.realpathSync(path.dirname(workspaceFiles[0])), fs.realpathSync(path.dirname(workspaceFiles[1])));
    assert.deepEqual(workspaceFiles.map((file) => JSON.parse(fs.readFileSync(file, "utf8")).apps[0].appId), appIds);
  } finally {
    const cli = path.join(prefix, "node_modules", ".bin", "lark-cli");
    if (fs.existsSync(cli)) for (const env of cleanupEnvs) spawnSync(cli, ["config", "remove"], { encoding: "utf8", env });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
