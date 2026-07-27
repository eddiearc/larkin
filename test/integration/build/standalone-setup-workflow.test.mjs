import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const enabled = process.env.LARKIN_RUN_STANDALONE_SETUP_WORKFLOW === "1";

function checked(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message || "spawn error"}`);
  assert.equal(result.status, 0, `${label} failed\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`);
  return result;
}

function writeLarkCli(binDir) {
  fs.writeFileSync(path.join(binDir, "lark-cli"), `#!/bin/sh
count=0
if [ -f "$SETUP_LARK_CALLS" ]; then count=$(grep -c '+chat-list' "$SETUP_LARK_CALLS"); fi
printf '%s\n' "$*" >> "$SETUP_LARK_CALLS"
if [ "$1" = "profile" ] && [ "$2" = "list" ]; then
  printf '[{"name":"%s","appId":"%s","active":true}]\n' "$SETUP_APP_ID" "$SETUP_APP_ID"
elif printf '%s\n' "$*" | grep -q '+chat-list'; then
    if [ "$SETUP_FAIL_BIND_VERIFY" = "1" ] || { [ "$SETUP_FAIL_BIND_VERIFY" = "second" ] && [ "$count" -ge 1 ]; }; then
      printf '%s\n' '{"ok":false,"identity":"bot"}'
      exit 1
    fi
    printf '%s\n' '{"ok":true,"identity":"bot","data":{"chats":[]}}'
else
  printf '%s\n' '{"ok":true}'
fi
`, { mode: 0o755 });
}

function writeRegisterFixture(temp) {
  const fixture = path.join(temp, "register-fixture.mjs");
  fs.writeFileSync(fixture, `import { spawnSync as systemSpawnSync } from "node:child_process";
export async function registerApp() {
  return { client_id: process.env.SETUP_APP_ID, client_secret: "standalone-fixture-secret", user_info: { tenant_brand: "feishu", open_id: "ou_fixture" } };
}
export const qrcode = { generate() {} };
export function spawnSync(command, args, options) {
  if (command === "open" || command === "xdg-open" || command === "cmd") return { status: 0, stdout: "", stderr: "" };
  return systemSpawnSync(command, args, options);
}
`, { mode: 0o600 });
  return fixture;
}

function writeCodexFixture(temp, binDir) {
  const source = path.join(temp, "codex-fixture.mjs");
  const executable = path.join(binDir, "codex");
  fs.writeFileSync(source, `import readline from "node:readline";
if (process.argv.includes("--version")) { console.log("codex-fixture 1.0.0"); process.exit(0); }
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialized") return;
  if (request.method === "initialize") return output({ jsonrpc: "2.0", id: request.id, result: { userAgent: "setup-fixture" } });
  if (request.method === "model/list") return output({ jsonrpc: "2.0", id: request.id, result: { data: [{ id: "codex-fixture", model: "codex-fixture", displayName: "Fixture", hidden: false, isDefault: true, supportedReasoningEfforts: [] }] } });
  if (request.id != null) output({ jsonrpc: "2.0", id: request.id, result: {} });
});
`, { mode: 0o600 });
  checked(spawnSync(process.execPath, ["build", source, "--compile", "--minify", `--outfile=${executable}`], {
    cwd: temp, encoding: "utf8", timeout: 60_000,
  }), "compile Codex setup fixture");
  return executable;
}

test.skipIf(!enabled)("compiled setup-bind executes its internal stage and propagates binding failures", { timeout: 180_000 }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-standalone-setup-"));
  const releaseDir = path.join(temp, "release");
  const configDir = path.join(temp, "config");
  const binDir = path.join(temp, "bin");
  const firstAgent = "cli_setupExistingA1";
  const secondAgent = "cli_setupAddedB2";
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    let artifact = process.env.LARKIN_STANDALONE_ARTIFACT;
    if (!artifact) {
      checked(spawnSync(process.execPath, ["run", "build"], { cwd: ROOT, env: process.env, encoding: "utf8", timeout: 120_000 }), "build production dist");
      checked(spawnSync(process.execPath, ["scripts/release/build.ts", "--target", `${os.platform()}-${os.arch()}`, "--out-dir", releaseDir, "--allow-dirty"], {
        cwd: ROOT, env: process.env, encoding: "utf8", timeout: 120_000,
      }), "compile standalone artifact");
      const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "release-manifest.json"), "utf8"));
      artifact = path.join(releaseDir, manifest.artifacts[0].file);
    }
    assert.equal(fs.statSync(artifact).isFile(), true);
    const configFile = path.join(configDir, "config.json");
    const initial = {
      version: 4, serverId: "server-standalone-setup", mentionPolicy: "require", activeAgent: firstAgent,
      agents: { [firstAgent]: { runtime: "codex", model: "default", createdAt: "2026-07-01T00:00:00.000Z" } },
    };
    fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    writeLarkCli(binDir);
    const baseEnv = {
      HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: configDir,
      PATH: `${binDir}${path.delimiter}/usr/bin:/bin`, SETUP_APP_ID: secondAgent,
      SETUP_LARK_CALLS: path.join(temp, "lark-calls"),
    };

    const added = spawnSync(artifact, ["__internal", "setup-bind", "--profile", secondAgent, "--agent", secondAgent, "--runtime", "codex", "--yes"], {
      cwd: temp, env: baseEnv, encoding: "utf8", timeout: 30_000,
    });
    checked(added, `compiled setup-bind (lark calls: ${fs.existsSync(baseEnv.SETUP_LARK_CALLS) ? fs.readFileSync(baseEnv.SETUP_LARK_CALLS, "utf8").trim() : "none"})`);
    const configured = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(Object.keys(configured.agents), [firstAgent, secondAgent]);
    assert.equal(configured.agents[secondAgent].runtime, "codex");
    assert.equal(configured.activeAgent, firstAgent, "adding an Agent must preserve the existing active selection");
    assert.match(added.stderr + added.stdout, /已写配置/);

    fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    const failed = spawnSync(artifact, ["__internal", "setup-bind", "--profile", secondAgent, "--agent", secondAgent, "--runtime", "codex", "--yes"], {
      cwd: temp, env: { ...baseEnv, SETUP_FAIL_BIND_VERIFY: "1" }, encoding: "utf8", timeout: 30_000,
    });
    assert.notEqual(failed.status, 0, failed.stderr + failed.stdout);
    assert.doesNotMatch(failed.stderr + failed.stdout, /已写配置/);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), initial);

    fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    fs.rmSync(baseEnv.SETUP_LARK_CALLS, { force: true });
    const publicEnv = {
      ...baseEnv,
      LARKIN_TEST_BOT_REGISTER_MODULE: writeRegisterFixture(temp),
      LARKIN_CODEX_COMMAND: writeCodexFixture(temp, binDir),
    };
    fs.mkdirSync(path.join(configDir, "agents", secondAgent), { recursive: true, mode: 0o700 });
    const publicSetup = spawnSync(artifact, ["setup", "--runtime", "codex", "--no-start"], {
      cwd: temp, env: publicEnv, encoding: "utf8", timeout: 30_000,
    });
    checked(publicSetup, "compiled public setup");
    const publicConfigured = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(Object.keys(publicConfigured.agents), [firstAgent, secondAgent]);
    assert.match(publicSetup.stderr + publicSetup.stdout, new RegExp(`Agent ${secondAgent} 已配置`));

    fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    fs.rmSync(baseEnv.SETUP_LARK_CALLS, { force: true });
    const publicFailed = spawnSync(artifact, ["setup", "--runtime", "codex", "--no-start"], {
      cwd: temp, env: { ...publicEnv, SETUP_FAIL_BIND_VERIFY: "second" }, encoding: "utf8", timeout: 30_000,
    });
    assert.notEqual(publicFailed.status, 0, publicFailed.stderr + publicFailed.stdout);
    assert.doesNotMatch(publicFailed.stderr + publicFailed.stdout, new RegExp(`Agent ${secondAgent} 已配置`));
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), initial);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
