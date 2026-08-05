import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  const packageDir = path.join(path.dirname(binDir), "official", "node_modules", "@larksuite", "cli");
  const launcher = path.join(packageDir, "scripts", "run.sh");
  fs.mkdirSync(path.dirname(launcher), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@larksuite/cli", version: "1.0.79", bin: { "lark-cli": "scripts/run.sh" },
  }), { mode: 0o600 });
  fs.writeFileSync(launcher, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.0.79\n'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "bind" ] && [ "$3" = "--help" ]; then printf '%s\n' 'Usage: config bind --source lark-channel --identity bot-only'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "bind" ]; then
  ${JSON.stringify(process.execPath)} --eval 'const fs=require("node:fs"),path=require("node:path"),source=JSON.parse(fs.readFileSync(process.env.LARK_CHANNEL_CONFIG,"utf8")),id=source.accounts.app.id,dir=path.join(process.env.LARKSUITE_CLI_CONFIG_DIR,"lark-channel");fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,"config.json"),JSON.stringify({apps:[{appId:id,appSecret:{source:"keychain",id:"appsecret:"+id},defaultAs:"bot",strictMode:"bot",users:[]}]}),{mode:0o600})'
  exit $?
fi
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
  fs.symlinkSync(launcher, path.join(binDir, "lark-cli"));
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

function startProviderFixture(temp, mode = "success") {
  const source = path.join(temp, `provider-fixture-${mode}.mjs`);
  const portFile = path.join(temp, `provider-port-${mode}`);
  const requestFile = path.join(temp, `provider-request-${mode}`);
  fs.writeFileSync(source, `import fs from "node:fs";
import http from "node:http";
const server = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    fs.writeFileSync(process.env.PROVIDER_REQUEST_FILE, "requested");
    if (process.env.PROVIDER_MODE === "hang") return;
    if (process.env.PROVIDER_MODE === "unauthorized") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":{"message":"invalid fixture key"}}');
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"LARKIN_READY"},"finish_reason":null}]}\\n\\n');
    response.write('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\\n\\n');
    response.end("data: [DONE]\\n\\n");
  });
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(process.env.PROVIDER_PORT_FILE, String(server.address().port)));
`, { mode: 0o600 });
  const child = spawn(process.execPath, [source], { cwd: temp, env: {
    ...process.env, PROVIDER_PORT_FILE: portFile, PROVIDER_REQUEST_FILE: requestFile, PROVIDER_MODE: mode,
  }, stdio: "ignore" });
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(portFile) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 20);
  assert.equal(fs.existsSync(portFile), true, "local provider fixture did not become ready");
  return { child, requestFile, baseUrl: `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").trim()}/v1` };
}

test.skipIf(!enabled)("compiled setup-bind and public setup preserve Agent config and propagate lark-channel verification failures", { timeout: 180_000 }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-standalone-setup-"));
  const releaseDir = path.join(temp, "release");
  const configDir = path.join(temp, "config");
  const binDir = path.join(temp, "bin");
  const firstAgent = "cli_setupExistingA1";
  const secondAgent = "cli_setupAddedB2";
  let providerFixture;
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
    const fixtureHome = path.join(temp, "home");
    fs.mkdirSync(fixtureHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(fixtureHome, ".bash_profile"), `export PATH=${JSON.stringify(binDir)}:/usr/bin:/bin\n`, { mode: 0o600 });
    const baseEnv = {
      HOME: fixtureHome, SHELL: "/bin/bash", LARKIN_CONFIG_DIR: configDir,
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
    const builtinBin = path.join(temp, "builtin-bin");
    fs.mkdirSync(builtinBin, { mode: 0o700 });
    writeLarkCli(builtinBin);
    const builtinEnv = {
      ...baseEnv,
      PATH: `${builtinBin}${path.delimiter}/usr/bin:/bin`,
      SETUP_LARK_CALLS: path.join(temp, "builtin-lark-calls"),
      LARKIN_TEST_BOT_REGISTER_MODULE: writeRegisterFixture(temp),
      LARKIN_PI_COMMAND: path.join(temp, "definitely-not-installed-pi"),
      LARKIN_CODEX_COMMAND: path.join(temp, "definitely-not-installed-codex"),
      LARKIN_CLAUDE_COMMAND: path.join(temp, "definitely-not-installed-claude"),
      LARKIN_TEST_ENABLE_AGENT_CHOICE: "1",
    };
    providerFixture = startProviderFixture(temp);
    const builtinSetup = spawnSync(artifact, ["setup", "--no-start"], {
      cwd: temp, env: builtinEnv, input: `1\n2\n5\n${providerFixture.baseUrl}\nfixture-model\nstandalone-provider-secret\n`, encoding: "utf8", timeout: 60_000,
    });
    checked(builtinSetup, "compiled public setup with bundled official Pi and no external Agent CLI");
    const builtinConfigured = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(builtinConfigured.agents[secondAgent].runtime, "pi");
    assert.equal(builtinConfigured.agents[secondAgent].piDistribution, "builtin");
    assert.equal(builtinConfigured.agents[secondAgent].model, "larkin-custom/fixture-model");
    assert.doesNotMatch(fs.readFileSync(configFile, "utf8"), /standalone-provider-secret/);
    assert.doesNotMatch(builtinSetup.stdout + builtinSetup.stderr, /standalone-provider-secret/);
    const piAuth = path.join(configDir, "providers", "pi", secondAgent, "auth.json");
    assert.equal(fs.statSync(path.dirname(piAuth)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(piAuth).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(piAuth, "utf8"))["larkin-custom"].key, "standalone-provider-secret");

    providerFixture.child.kill();
    providerFixture = undefined;
    fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    const oldAuth = `${JSON.stringify({ legacy: { type: "api_key", key: "old-provider-key" } }, null, 2)}\n`;
    const piModels = path.join(path.dirname(piAuth), "models.json");
    const oldModels = fs.readFileSync(piModels, "utf8");
    fs.writeFileSync(piAuth, oldAuth, { mode: 0o600 });
    providerFixture = startProviderFixture(temp, "unauthorized");
    const rejectedSetup = spawnSync(artifact, ["setup", "--no-start"], {
      cwd: temp, env: builtinEnv,
      input: `1\n2\n5\n${providerFixture.baseUrl}\nfixture-model\nrejected-provider-secret\n`,
      encoding: "utf8", timeout: 60_000,
    });
    assert.notEqual(rejectedSetup.status, 0, rejectedSetup.stdout + rejectedSetup.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), initial);
    assert.equal(fs.readFileSync(piAuth, "utf8"), oldAuth, "401 must restore prior auth bytes");
    assert.equal(fs.readFileSync(piModels, "utf8"), oldModels, "401 must restore prior model bytes");
    assert.doesNotMatch(rejectedSetup.stdout + rejectedSetup.stderr, /rejected-provider-secret/);

    providerFixture.child.kill();
    providerFixture = startProviderFixture(temp, "hang");
    const selectionFile = path.join(configDir, `.setup-agent-choice-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(selectionFile, `${JSON.stringify({ runtime: "pi", distribution: "builtin", preset: "custom",
      baseUrl: providerFixture.baseUrl, model: "larkin-custom/fixture-model", apiKey: "cancelled-provider-secret" })}\n`, { mode: 0o600 });
    const cancelledSetup = spawn(artifact, ["__internal", "setup-bind", "--profile", secondAgent, "--agent", secondAgent,
      "--selection-file", selectionFile, "--yes"], { cwd: temp, env: builtinEnv, stdio: "ignore" });
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const requestDeadline = Date.now() + 20_000;
    while (!fs.existsSync(providerFixture.requestFile) && Date.now() < requestDeadline) Atomics.wait(sleeper, 0, 0, 20);
    assert.equal(fs.existsSync(providerFixture.requestFile), true, "cancel test did not reach provider verification");
    assert.equal(JSON.parse(fs.readFileSync(piAuth, "utf8"))["larkin-custom"].key, "cancelled-provider-secret",
      "cancel test must observe the staged credential before signalling");
    cancelledSetup.kill("SIGTERM");
    const rollbackDeadline = Date.now() + 10_000;
    while (fs.readFileSync(piAuth, "utf8") !== oldAuth && Date.now() < rollbackDeadline) Atomics.wait(sleeper, 0, 0, 20);
    assert.equal(fs.readFileSync(piAuth, "utf8"), oldAuth, "SIGTERM must restore prior auth bytes");
    assert.equal(fs.readFileSync(piModels, "utf8"), oldModels, "SIGTERM must restore prior model bytes");
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), initial);

    providerFixture.child.kill();
    providerFixture = undefined;

    fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    fs.rmSync(baseEnv.SETUP_LARK_CALLS, { force: true });
    const publicFailed = spawnSync(artifact, ["setup", "--runtime", "codex", "--no-start"], {
      cwd: temp, env: { ...publicEnv, SETUP_FAIL_BIND_VERIFY: "1" }, encoding: "utf8", timeout: 30_000,
    });
    assert.notEqual(publicFailed.status, 0, publicFailed.stderr + publicFailed.stdout);
    assert.doesNotMatch(publicFailed.stderr + publicFailed.stdout, new RegExp(`Agent ${secondAgent} 已配置`));
    const recoverable = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(Object.keys(recoverable.agents), [firstAgent, secondAgent]);
    assert.equal(recoverable.activeAgent, firstAgent);
    assert.equal(fs.existsSync(path.join(configDir, "bots", `${secondAgent}.json`)), true,
      "verification failure must preserve the authoritative credential for recovery");
    assert.equal(fs.existsSync(path.join(configDir, "state", "agents", secondAgent, "lark-cli-config", "lark-channel", "config.json")), true,
      "verification failure must preserve the successful official workspace binding");
  } finally {
    providerFixture?.child.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
