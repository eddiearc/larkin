import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const enabled = process.env.LARKIN_RUN_STANDALONE_SETUP_WORKFLOW === "1";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForProcessCommand(needle, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ps = spawnSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" });
    if (ps.status === 0) {
      const command = ps.stdout.split("\n").find((line) => line.includes(needle));
      if (command) return command;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for process command containing ${needle}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 8_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

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
    name: "@larksuite/cli", version: "1.0.80", bin: { "lark-cli": "scripts/run.sh" },
  }), { mode: 0o600 });
  fs.writeFileSync(launcher, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.0.80\n'; exit 0; fi
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
    if [ "$SETUP_OVERFLOW_BIND_VERIFY" = "1" ]; then
      head -c 131072 /dev/zero | tr '\\0' x
      exit 0
    fi
    if [ "$SETUP_HANG_BIND_VERIFY" = "1" ]; then
      if [ "$SETUP_IGNORE_TERM_BIND_VERIFY" = "1" ]; then
        exec ${JSON.stringify(process.execPath)} --eval 'const fs=require("node:fs");process.on("SIGTERM",()=>fs.writeFileSync(process.env.SETUP_TERM_MARKER,"term"));fs.writeFileSync(process.env.SETUP_IDENTITY_MARKER,"ready");setTimeout(()=>fs.writeFileSync(process.env.SETUP_LATE_WORKSPACE_MARKER,"late-workspace-write"),3000);setInterval(()=>{},1000)'
      fi
      : > "$SETUP_IDENTITY_MARKER"
      while :; do sleep 1; done
    fi
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

function writePiAuthFixture(temp) {
  const fixture = path.join(temp, "pi-auth-fixture.mjs");
  fs.writeFileSync(fixture, `import fs from "node:fs";
export function configure(runtime) {
  runtime.registerNativeProvider({
    id: "fixture-oauth", name: "Fixture OAuth", baseUrl: "https://fixture.invalid",
    auth: { oauth: {
      name: "Fixture subscription",
      async login(interaction) {
        const observed = [];
        interaction.notify({ type: "info", message: "fixture info", links: [{ label: "docs", url: "https://fixture.invalid/docs?redacted=test" }] });
        interaction.notify({ type: "auth_url", url: "https://fixture.invalid/authorize?state=fixture-state", instructions: "fixture browser" });
        interaction.notify({ type: "device_code", userCode: "FIXTURE-CODE", verificationUri: "https://fixture.invalid/device", intervalSeconds: 1 });
        interaction.notify({ type: "progress", message: "fixture progress" });
        observed.push(["text", (await interaction.prompt({ type: "text", message: "fixture text" })).length]);
        observed.push(["secret", (await interaction.prompt({ type: "secret", message: "fixture secret" })).length]);
        observed.push(["select", await interaction.prompt({ type: "select", message: "fixture select", options: [{ id: "first", label: "First" }, { id: "second", label: "Second" }] })]);
        observed.push(["manual_code", (await interaction.prompt({ type: "manual_code", message: "fixture manual" })).length]);
        fs.writeFileSync(process.env.LARKIN_TEST_PI_AUTH_TRACE, JSON.stringify(observed));
        if (process.env.LARKIN_TEST_PI_AUTH_FAIL === "1") throw new Error("controlled fixture login failure");
        return { type: "oauth", access: "fixture-access-not-output", refresh: "fixture-refresh-not-output", expires: Date.now() + 3600000 };
      },
      async refresh(credential) { return credential; }, async toAuth(credential) { return { apiKey: credential.access }; },
    } },
    getModels() { return [{ provider: "fixture-oauth", id: "fixture-model", name: "Fixture", api: "openai-completions", baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100 }]; },
    stream() { throw new Error("not used"); }, streamSimple() { throw new Error("not used"); },
  });
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
  const instance = `${mode}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const source = path.join(temp, `provider-fixture-${instance}.mjs`);
  const portFile = path.join(temp, `provider-port-${instance}`);
  const requestFile = path.join(temp, `provider-request-${instance}`);
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

test.skipIf(!enabled)("compiled setup-bind and public setup preserve Agent config and propagate lark-channel verification failures", { timeout: 180_000 }, async () => {
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

    const eventFile = path.join(temp, "builtin-events.ndjson");
    fs.writeFileSync(eventFile, "");
    fs.writeFileSync(configFile, `${JSON.stringify({
      ...builtinConfigured,
      activeAgent: secondAgent,
      agents: { [secondAgent]: builtinConfigured.agents[secondAgent] },
    }, null, 2)}\n`, { mode: 0o600 });
    const builtinService = spawn(artifact, ["start", "--dry-run"], {
      cwd: temp,
      env: {
        ...builtinEnv,
        LARKIN_FEISHU_EVENT_FILE: eventFile,
        LARKIN_DASHBOARD_PORT: String(await freePort()),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let builtinServiceOutput = "";
    builtinService.stdout.on("data", (chunk) => { builtinServiceOutput += String(chunk); });
    builtinService.stderr.on("data", (chunk) => { builtinServiceOutput += String(chunk); });
    try {
      const command = await waitForProcessCommand(`${path.basename(artifact)} __internal pi-rpc`)
        .catch((error) => { throw new Error(`${error.message}\n${builtinServiceOutput}`); });
      assert.equal((command.match(/(?:^|\s)--append-system-prompt(?:\s|$)/g) || []).length, 1,
        "standalone builtin Pi must receive exactly one append standing prompt argument");
      assert.doesNotMatch(command, /(?:^|\s)--system-prompt(?:\s|$)/,
        "standalone builtin Pi must not replace the upstream system prompt");
      assert.match(command, /__internal pi-rpc[\s\S]*--mode rpc/,
        "the assertion must observe the formal standalone internal Pi adapter process");
    } finally {
      await stop(builtinService);
    }

    providerFixture.child.kill();
    providerFixture = undefined;
    fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    const oldAuth = `${JSON.stringify({ legacy: { type: "api_key", key: "old-provider-key" } }, null, 2)}\n`;
    const piModels = path.join(path.dirname(piAuth), "models.json");
    const oldModels = fs.readFileSync(piModels, "utf8");
    fs.writeFileSync(piAuth, oldAuth, { mode: 0o600 });

    const managementEnv = { ...builtinEnv, LARKIN_TEST_PI_AUTH_PROVIDER_MODULE: writePiAuthFixture(temp),
      LARKIN_TEST_PI_AUTH_TRACE: path.join(temp, "unused-management-trace.json") };
    const managedAuth = `${JSON.stringify({
      "fixture-oauth": { type: "oauth", access: "managed-access", refresh: "managed-refresh", expires: Date.now() + 3_600_000 },
      legacy: { type: "api_key", key: "old-provider-key" },
    }, null, 2)}\n`;
    const initialConfigBytes = fs.readFileSync(configFile);
    for (const cancellation of ["EOF", "SIGINT", "SIGTERM"]) {
      fs.writeFileSync(piAuth, managedAuth, { mode: 0o600 });
      fs.writeFileSync(piModels, oldModels, { mode: 0o600 });
      fs.writeFileSync(configFile, initialConfigBytes, { mode: 0o600 });
      if (cancellation === "EOF") {
        const cancelled = spawnSync(artifact, ["setup", "--no-start"], {
          cwd: temp, env: managementEnv, input: "1\n2\n7\n1\n", encoding: "utf8", timeout: 30_000,
        });
        assert.notEqual(cancelled.status, 0, "EOF after setup logout must cancel the setup");
      } else {
        const cancelled = spawn(artifact, ["setup", "--no-start"], {
          cwd: temp, env: managementEnv, stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "";
        cancelled.stdout.on("data", (chunk) => { output += String(chunk); });
        cancelled.stderr.on("data", (chunk) => { output += String(chunk); });
        cancelled.stdin.write("1\n2\n7\n1\n");
        const logoutDeadline = Date.now() + 20_000;
        let observedLogout = false;
        while (Date.now() < logoutDeadline) {
          try { observedLogout = JSON.parse(fs.readFileSync(piAuth, "utf8"))["fixture-oauth"] === undefined; } catch { /* atomic replacement */ }
          if (observedLogout) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(observedLogout, true, `${cancellation} test did not observe setup logout: ${output}`);
        cancelled.kill(cancellation);
      }
      const rollbackDeadline = Date.now() + 10_000;
      while (fs.readFileSync(piAuth, "utf8") !== managedAuth && Date.now() < rollbackDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fs.readFileSync(piAuth, "utf8"), managedAuth, `${cancellation} after logout must restore exact auth bytes`);
      assert.equal(fs.readFileSync(piModels, "utf8"), oldModels, `${cancellation} after logout must restore exact model bytes`);
      assert.deepEqual(fs.readFileSync(configFile), initialConfigBytes, `${cancellation} after logout must restore exact config bytes`);
    }

    providerFixture = startProviderFixture(temp);
    for (const downstreamFailure of ["identity", "result-file", "identity-timeout", "identity-overflow"]) {
      fs.writeFileSync(piAuth, oldAuth, { mode: 0o600 });
      fs.writeFileSync(piModels, oldModels, { mode: 0o600 });
      fs.writeFileSync(configFile, initialConfigBytes, { mode: 0o600 });
      fs.rmSync(managementEnv.SETUP_LARK_CALLS, { force: true });
      const transientSecret = `${downstreamFailure}-credential-must-rollback`;
      const args = downstreamFailure === "result-file"
        ? ["__internal", "bot-register", "--auto", "--result-file", path.join(configDir, ".setup-result-777.json")]
        : ["setup", "--no-start"];
      if (downstreamFailure === "result-file") {
        fs.writeFileSync(args.at(-1), "occupied", { mode: 0o600 });
      }
      const failedAfterAuth = spawnSync(artifact, args, {
        cwd: temp,
        env: {
          ...builtinEnv,
          ...(downstreamFailure === "identity" ? { SETUP_FAIL_BIND_VERIFY: "1" } : {}),
          ...(downstreamFailure === "identity-timeout" ? { LARKIN_TEST_ASYNC_IDENTITY: "1", SETUP_HANG_BIND_VERIFY: "1",
            SETUP_IDENTITY_MARKER: path.join(temp, "identity-timeout-marker"), LARKIN_TEST_CHILD_TIMEOUT_MS: "100" } : {}),
          ...(downstreamFailure === "identity-overflow" ? { LARKIN_TEST_ASYNC_IDENTITY: "1", SETUP_OVERFLOW_BIND_VERIFY: "1",
            LARKIN_TEST_CHILD_MAX_OUTPUT_BYTES: "1024" } : {}),
        },
        input: `1\n2\n5\n${providerFixture.baseUrl}\nfixture-model\n${transientSecret}\n`,
        encoding: "utf8", timeout: 60_000,
      });
      assert.notEqual(failedAfterAuth.status, 0, `${downstreamFailure} must fail after provider auth`);
      assert.equal(fs.readFileSync(piAuth, "utf8"), oldAuth, `${downstreamFailure} must restore exact auth bytes`);
      assert.equal(fs.readFileSync(piModels, "utf8"), oldModels, `${downstreamFailure} must restore exact model bytes`);
      assert.doesNotMatch(failedAfterAuth.stdout + failedAfterAuth.stderr, new RegExp(transientSecret));
      const committedConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
      assert.ok(committedConfig.agents[secondAgent], `${downstreamFailure} failed before setup-bind commit:\n${failedAfterAuth.stdout}\n${failedAfterAuth.stderr}`);
      assert.equal(committedConfig.agents[secondAgent].runtime, "pi",
        `${downstreamFailure}: setup-bind canonical config is already committed by its existing contract`);
      assert.equal(committedConfig.agents[secondAgent].piDistribution, "builtin");
      if (downstreamFailure === "result-file") fs.rmSync(args.at(-1), { force: true });
    }
    for (const signal of ["SIGINT", "SIGTERM"]) {
      fs.writeFileSync(piAuth, oldAuth, { mode: 0o600 });
      fs.writeFileSync(piModels, oldModels, { mode: 0o600 });
      fs.writeFileSync(configFile, initialConfigBytes, { mode: 0o600 });
      const identityMarker = path.join(temp, `identity-${signal}`);
      const termMarker = path.join(temp, `identity-${signal}-term`);
      const lateWorkspaceMarker = path.join(temp, `identity-${signal}-late-workspace`);
      const transientSecret = `identity-${signal.toLowerCase()}-credential-must-rollback`;
      const signalled = spawn(artifact, ["__internal", "bot-register", "--auto"], {
        cwd: temp, env: { ...builtinEnv, LARKIN_TEST_ASYNC_IDENTITY: "1", SETUP_HANG_BIND_VERIFY: "1",
          SETUP_IDENTITY_MARKER: identityMarker, SETUP_IGNORE_TERM_BIND_VERIFY: "1", SETUP_TERM_MARKER: termMarker,
          SETUP_LATE_WORKSPACE_MARKER: lateWorkspaceMarker }, stdio: ["pipe", "pipe", "pipe"],
      });
      const signalledExit = new Promise((resolve) => signalled.once("exit", resolve));
      let signalledOutput = "";
      signalled.stdout.on("data", (chunk) => { signalledOutput += String(chunk); });
      signalled.stderr.on("data", (chunk) => { signalledOutput += String(chunk); });
      signalled.stdin.end(`1\n2\n5\n${providerFixture.baseUrl}\nfixture-model\n${transientSecret}\n`);
      const identityDeadline = Date.now() + 20_000;
      while (!fs.existsSync(identityMarker) && Date.now() < identityDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fs.existsSync(identityMarker), true, `${signal} did not reach post-auth identity verification: ${signalledOutput}`);
      assert.equal(JSON.parse(fs.readFileSync(piAuth, "utf8"))["larkin-custom"].key, transientSecret);
      signalled.kill(signal);
      const termDeadline = Date.now() + 3_000;
      while (!fs.existsSync(termMarker) && Date.now() < termDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fs.existsSync(termMarker), true, `${signal}: identity child did not receive graceful SIGTERM`);
      const rollbackDeadline = Date.now() + 10_000;
      while (fs.readFileSync(piAuth, "utf8") !== oldAuth && Date.now() < rollbackDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fs.readFileSync(piAuth, "utf8"), oldAuth, `${signal} during identity must restore exact auth bytes`);
      assert.equal(fs.readFileSync(piModels, "utf8"), oldModels, `${signal} during identity must restore exact model bytes`);
      assert.doesNotMatch(signalledOutput, new RegExp(transientSecret));
      const committedConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
      assert.equal(committedConfig.agents[secondAgent].runtime, "pi", `${signal}: setup-bind config remains committed by contract`);
      const exitCode = await signalledExit;
      assert.equal(exitCode, signal === "SIGINT" ? 130 : 143, `${signal}: parent must exit only after child SIGKILL settles`);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      assert.equal(fs.existsSync(lateWorkspaceMarker), false, `${signal}: killed identity child must not write workspace state later`);
    }
    providerFixture.child.kill();
    providerFixture = undefined;

    fs.writeFileSync(configFile, initialConfigBytes, { mode: 0o600 });
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
    for (const signal of ["SIGTERM", "SIGINT"]) {
      fs.rmSync(providerFixture.requestFile, { force: true });
      const selectionFile = path.join(configDir, `.setup-agent-choice-${process.pid}-${Date.now()}-${signal}.json`);
      fs.writeFileSync(selectionFile, `${JSON.stringify({ runtime: "pi", distribution: "builtin", preset: "custom",
        baseUrl: providerFixture.baseUrl, model: "larkin-custom/fixture-model" })}\n`, { mode: 0o600 });
      const cancelledSetup = spawn(artifact, ["__internal", "setup-bind", "--profile", secondAgent, "--agent", secondAgent,
        "--selection-file", selectionFile, "--yes"], { cwd: temp, env: builtinEnv, stdio: ["pipe", "pipe", "pipe"] });
      let cancelledOutput = "";
      cancelledSetup.stdout.on("data", (chunk) => { cancelledOutput += String(chunk); });
      cancelledSetup.stderr.on("data", (chunk) => { cancelledOutput += String(chunk); });
      const stagedSecret = `cancelled-provider-${signal.toLowerCase()}-secret`;
      cancelledSetup.stdin.end(`${stagedSecret}\n`);
      const requestDeadline = Date.now() + 20_000;
      while (!fs.existsSync(providerFixture.requestFile) && Date.now() < requestDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fs.existsSync(providerFixture.requestFile), true, `${signal} cancel test did not reach provider verification: ${cancelledOutput}`);
      assert.equal(JSON.parse(fs.readFileSync(piAuth, "utf8"))["larkin-custom"].key, stagedSecret,
        `${signal} cancel test must observe the staged credential before signalling`);
      cancelledSetup.kill(signal);
      const rollbackDeadline = Date.now() + 10_000;
      while (fs.readFileSync(piAuth, "utf8") !== oldAuth && Date.now() < rollbackDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fs.readFileSync(piAuth, "utf8"), oldAuth, `${signal} must restore prior auth bytes`);
      assert.equal(fs.readFileSync(piModels, "utf8"), oldModels, `${signal} must restore prior model bytes`);
      assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), initial);
    }

    fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(piAuth, oldAuth, { mode: 0o600 });
    fs.writeFileSync(piModels, oldModels, { mode: 0o600 });
    const oauthSelectionFile = path.join(configDir, `.setup-agent-choice-${process.pid}-${Date.now()}-oauth.json`);
    fs.writeFileSync(oauthSelectionFile, `${JSON.stringify({ runtime: "pi", distribution: "builtin", preset: "official",
      providerId: "fixture-oauth", authType: "oauth", model: "fixture-oauth/fixture-model" })}\n`, { mode: 0o600 });
    const authTrace = path.join(temp, "pi-auth-trace.json");
    const oauthEnv = { ...builtinEnv, LARKIN_TEST_PI_AUTH_PROVIDER_MODULE: writePiAuthFixture(temp),
      LARKIN_TEST_PI_AUTH_TRACE: authTrace, LARKIN_TEST_SKIP_BUILTIN_PI_PROVIDER_TURN: "1" };
    const oauthSetup = spawnSync(artifact, ["__internal", "setup-bind", "--profile", secondAgent, "--agent", secondAgent,
      "--selection-file", oauthSelectionFile, "--yes"], {
      cwd: temp, env: oauthEnv, input: "visible text\noauth-secret-sentinel\n2\nmanual-code-sentinel\n", encoding: "utf8", timeout: 30_000,
    });
    checked(oauthSetup, "compiled official OAuth prompt/event bridge");
    assert.deepEqual(JSON.parse(fs.readFileSync(authTrace, "utf8")), [
      ["text", 12], ["secret", 21], ["select", "second"], ["manual_code", 20],
    ]);
    const oauthOutput = oauthSetup.stdout + oauthSetup.stderr;
    assert.match(oauthOutput, /fixture info[\s\S]*登录地址[\s\S]*FIXTURE-CODE[\s\S]*fixture progress/);
    assert.doesNotMatch(oauthOutput, /oauth-secret-sentinel|manual-code-sentinel|fixture-access-not-output|fixture-refresh-not-output/);
    const oauthAuth = JSON.parse(fs.readFileSync(piAuth, "utf8"));
    assert.equal(oauthAuth["fixture-oauth"].type, "oauth");
    assert.equal(oauthAuth.legacy.key, "old-provider-key");
    assert.doesNotMatch(fs.readFileSync(configFile, "utf8"), /fixture-access-not-output|fixture-refresh-not-output|oauth-secret-sentinel/);

    const oauthLogout = spawnSync(artifact, ["pi-auth", "logout", "fixture-oauth", "--agent", secondAgent], {
      cwd: temp, env: oauthEnv, encoding: "utf8", timeout: 30_000,
    });
    checked(oauthLogout, "compiled official OAuth logout");
    const afterLogout = JSON.parse(fs.readFileSync(piAuth, "utf8"));
    assert.equal(afterLogout["fixture-oauth"], undefined);
    assert.equal(afterLogout.legacy.key, "old-provider-key");

    const beforeFailedAuth = fs.readFileSync(piAuth);
    const beforeFailedModels = fs.readFileSync(piModels);
    const beforeFailedConfig = fs.readFileSync(configFile);
    const modelsStore = path.join(path.dirname(piAuth), "models-store.json");
    const beforeFailedModelsStore = fs.existsSync(modelsStore) ? fs.readFileSync(modelsStore) : null;
    const failedSelectionFile = path.join(configDir, `.setup-agent-choice-${process.pid}-${Date.now()}-login-fail.json`);
    fs.writeFileSync(failedSelectionFile, `${JSON.stringify({ runtime: "pi", distribution: "builtin", preset: "official",
      providerId: "fixture-oauth", authType: "oauth", model: "fixture-oauth/fixture-model" })}\n`, { mode: 0o600 });
    const failedLogin = spawnSync(artifact, ["__internal", "setup-bind", "--profile", secondAgent, "--agent", secondAgent,
      "--selection-file", failedSelectionFile, "--yes"], {
      cwd: temp, env: { ...oauthEnv, LARKIN_TEST_PI_AUTH_FAIL: "1" },
      input: "visible text\nfailed-secret-sentinel\n1\nfailed-manual-sentinel\n", encoding: "utf8", timeout: 30_000,
    });
    assert.notEqual(failedLogin.status, 0);
    assert.deepEqual(fs.readFileSync(piAuth), beforeFailedAuth, "login failure must restore exact auth bytes");
    assert.deepEqual(fs.readFileSync(piModels), beforeFailedModels, "login failure must restore exact model bytes");
    assert.deepEqual(fs.readFileSync(configFile), beforeFailedConfig, "login failure must restore exact config bytes");
    assert.deepEqual(fs.existsSync(modelsStore) ? fs.readFileSync(modelsStore) : null, beforeFailedModelsStore,
      "login failure must restore exact models-store bytes");
    assert.doesNotMatch(failedLogin.stdout + failedLogin.stderr, /failed-secret-sentinel|failed-manual-sentinel/);

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
