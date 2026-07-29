import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "bun:test";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const ENABLED = process.env.LARKIN_RUN_STANDALONE_BINARY_ACCEPTANCE === "1";
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const CHROME = process.env.LARKIN_CHROMIUM_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function checked(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message || "spawn error"}`);
  assert.equal(result.status, 0, `${label} failed\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`);
  return result;
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitFor(read, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}: ${lastError?.message || "not ready"}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGINT");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 8_000)),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

test.skipIf(!ENABLED)("standalone binary preserves CLI, Agent, local-control, Dashboard API, and browser contracts", {
  timeout: 240_000,
}, async () => {
  const tempBase = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const temp = fs.mkdtempSync(path.join(tempBase, "larkin-standalone-acceptance-"));
  const releaseDir = path.join(temp, "release");
  const home = path.join(temp, "home");
  const configDir = path.join(temp, "config");
  const mockBin = path.join(temp, "bin");
  const appId = "cli_standaloneA1";
  const otherAgentId = "cli_standaloneB2";
  const configFile = path.join(configDir, "config.json");
  const canonicalState = path.join(configDir, "state", "agents", appId);
  let service;
  let browser;
  try {
    for (const directory of [home, configDir, mockBin]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(configDir, 0o700);
    checked(spawnSync(process.execPath, ["run", "build"], {
      cwd: ROOT, env: process.env, encoding: "utf8", timeout: 120_000,
    }), "build production dist");
    checked(spawnSync(process.execPath, [
      "scripts/release/build.ts", "--target", `${os.platform()}-${os.arch()}`,
      "--out-dir", releaseDir, "--allow-dirty",
    ], { cwd: ROOT, env: process.env, encoding: "utf8", timeout: 120_000 }), "compile standalone artifact");
    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "release-manifest.json"), "utf8"));
    assert.equal(manifest.artifacts.length, 1);
    const artifact = path.join(releaseDir, manifest.artifacts[0].file);
    assert.equal(fs.statSync(artifact).isFile(), true);

    fs.writeFileSync(configFile, `${JSON.stringify({
      version: 4,
      serverId: "server-standalone-acceptance",
      mentionPolicy: "require",
      activeAgent: appId,
      agents: {
        [appId]: { runtime: "codex", model: "gpt-5.6-sol" },
        [otherAgentId]: { runtime: "codex", model: "gpt-5.6-sol" },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    fs.mkdirSync(path.join(configDir, "agents", appId), { recursive: true });
    fs.mkdirSync(path.join(configDir, "agents", otherAgentId), { recursive: true });

    const larkMarker = path.join(temp, "lark-cli.calls");
    const officialPackage = path.join(temp, "official", "node_modules", "@larksuite", "cli");
    const officialLauncher = path.join(officialPackage, "scripts", "run.sh");
    fs.mkdirSync(path.dirname(officialLauncher), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(officialPackage, "package.json"), JSON.stringify({
      name: "@larksuite/cli", version: "1.0.79", bin: { "lark-cli": "scripts/run.sh" },
    }), { mode: 0o600 });
    fs.writeFileSync(officialLauncher, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'lark-cli version 1.0.79\n'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "bind" ] && [ "$3" = "--help" ]; then printf '%s\n' 'Usage: config bind --source lark-channel --identity bot-only'; exit 0; fi
printf '%s\n' "$*" >> "$STANDALONE_LARK_MARKER"
if [ "$1" = "config" ] && [ "$2" = "bind" ]; then
  ${JSON.stringify(process.execPath)} --eval 'const fs=require("node:fs"),path=require("node:path"),source=JSON.parse(fs.readFileSync(process.env.LARK_CHANNEL_CONFIG,"utf8")),id=source.accounts.app.id,dir=path.join(process.env.LARKSUITE_CLI_CONFIG_DIR,"lark-channel");fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,"config.json"),JSON.stringify({apps:[{appId:id,appSecret:{source:"keychain",id:"appsecret:"+id},defaultAs:"bot",strictMode:"bot",users:[]}]}),{mode:0o600})'
  exit $?
fi
case "$*" in
  *--help*) printf '%s\n' 'Usage: lark-cli im +messages-send' ;;
  *+chat-list*) printf '%s\n' '{"ok":true,"identity":"bot","data":{"chats":[]}}' ;;
  *) printf '%s\n' '{"ok":true,"data":{"standalone":true}}' ;;
esac
`, { mode: 0o755 });
    fs.symlinkSync(officialLauncher, path.join(mockBin, "lark-cli"));
    fs.writeFileSync(path.join(home, ".bash_profile"), `export PATH=${JSON.stringify(mockBin)}:/usr/bin:/bin\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(home, ".zprofile"), `export PATH=${JSON.stringify(mockBin)}:/usr/bin:/bin\n`, { mode: 0o600 });
    const codexSource = path.join(temp, "fake-codex.mjs");
    fs.writeFileSync(codexSource, `import readline from "node:readline";
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialized") return;
  if (request.method === "initialize") return output({ jsonrpc: "2.0", id: request.id, result: { userAgent: "standalone-fixture" } });
  if (request.method === "model/list") return output({ jsonrpc: "2.0", id: request.id, result: { data: [{
    id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", hidden: false, isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
  }] } });
  if (request.method === "thread/start" || request.method === "thread/resume") return output({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-standalone" } } });
  if (request.method === "turn/start") return output({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-standalone" } } });
  if (request.id != null) output({ jsonrpc: "2.0", id: request.id, result: {} });
});
`);
    checked(spawnSync(process.execPath, ["build", codexSource, "--compile", "--minify", `--outfile=${path.join(mockBin, "codex")}`], {
      cwd: temp, encoding: "utf8", timeout: 60_000,
    }), "compile Codex fixture");

    const baseEnv = {
      HOME: home,
      SHELL: "/bin/zsh",
      BASH_ENV: path.join(home, ".bash_profile"),
      ZDOTDIR: home,
      LARKIN_CONFIG_DIR: configDir,
      PATH: `${mockBin}${path.delimiter}/usr/bin:/bin`,
      STANDALONE_LARK_MARKER: larkMarker,
      LARKIN_CODEX_COMMAND: path.join(mockBin, "codex"),
      TMPDIR: os.tmpdir(),
    };
    const runCli = (args, extraEnv = {}) => spawnSync(artifact, args, {
      cwd: temp, env: { ...baseEnv, ...extraEnv }, encoding: "utf8", timeout: 15_000,
    });
    assert.match(checked(runCli(["--help"]), "standalone help").stdout, /Usage:\s*larkin <command>/);
    assert.equal(checked(runCli(["--version"]), "standalone version").stdout.trim(), `larkin ${PACKAGE.version}`);
    const configHelp = checked(runCli(["help", "config"]), "standalone config help").stdout;
    for (const token of ["config runtime", "config model", "config effort", "config mention global", "config mention agent", "config mention chat", "config apply", "--agent", "--chat"]) {
      assert.match(configHelp, new RegExp(token), `config help missing ${token}`);
    }
    assert.equal(JSON.parse(checked(runCli(["config", "show", "--agent", appId, "--json"]), "config show").stdout).agents[0].agentId, appId);
    checked(runCli(["config", "mention", "global", "free"]), "global mention mutation");
    checked(runCli(["config", "mention", "agent", "require", "--agent", appId]), "Agent mention mutation");
    checked(runCli(["config", "mention", "chat", "oc_standalone", "free", "--agent", appId]), "chat mention mutation");
    checked(runCli(["config", "model", "gpt-5.6-sol", "--agent", appId]), "model mutation");
    checked(runCli(["config", "effort", "high", "--agent", appId]), "effort mutation");
    const mutated = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(mutated.mentionPolicy, "free");
    assert.equal(mutated.agents[appId].mentionPolicy, "require");
    assert.equal(mutated.agents[appId].chatMentionPolicies.oc_standalone, "free");
    assert.deepEqual({ model: mutated.agents[appId].model, effort: mutated.agents[appId].effort }, { model: "gpt-5.6-sol", effort: "high" });

    const runAgentCli = (args, extraEnv = {}) => spawnSync(artifact, ["__internal", "agent-cli", ...args], {
      cwd: temp,
      env: { ...baseEnv, LARKIN_AGENT_ID: appId, ...extraEnv },
      encoding: "utf8",
      timeout: 15_000,
    });
    const capabilities = JSON.parse(checked(runAgentCli(["--help"]), "Agent capabilities").stdout).capabilities;
    assert.deepEqual(Object.keys(capabilities.commands), ["inbox", "reminder", "interaction", "profile", "config"]);
    assert.equal(capabilities.commands.config.includes("apply"), true);
    assert.equal("removed" in capabilities, false);
    assert.equal(JSON.parse(checked(runAgentCli(["config", "--help"]), "Agent config help").stdout).usage.some((line) => line.includes("config apply")), true);
    fs.rmSync(larkMarker, { force: true });
    const identityEscape = runAgentCli(["im", "+chat-list", "--agent", otherAgentId]);
    assert.equal(identityEscape.status, 2);
    assert.match(identityEscape.stderr, /larkin im|迁移/);
    assert.equal(fs.existsSync(larkMarker), false, "identity rejection must precede lark-cli spawn");
    const removedIm = runAgentCli(["im", "+chat-list"]);
    assert.equal(removedIm.status, 2);
    assert.match(removedIm.stderr, /larkin im|迁移/);
    assert.equal(fs.existsSync(larkMarker), false, "removed Agent IM shim must not spawn ambient lark-cli");
    assert.match(checked(runAgentCli(["profile", "show", "--json"]), "local profile show").stdout, new RegExp(appId));
    assert.equal(fs.existsSync(larkMarker), false, "profile show must remain local");

    const botsDir = path.join(configDir, "bots");
    fs.mkdirSync(botsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(botsDir, `${appId}.json`), JSON.stringify({ appId, appSecret: "standalone-secret", tenant: "feishu" }), { mode: 0o600 });
    fs.writeFileSync(path.join(botsDir, `${otherAgentId}.json`), JSON.stringify({ appId: otherAgentId, appSecret: "standalone-other-secret", tenant: "feishu" }), { mode: 0o600 });
    for (const [agentId, secret] of [[appId, "standalone-secret"], [otherAgentId, "standalone-other-secret"]]) {
      const profileDir = path.join(configDir, "state", "agents", agentId, "lark-cli-config");
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(profileDir, "config.json"), JSON.stringify({ apps: [{
        appId: agentId, name: agentId, appSecret: secret, brand: "feishu", defaultAs: "bot", strictMode: "bot", users: [],
      }] }), { mode: 0o600 });
    }
    const channelModule = path.join(temp, "fake-channel.mjs");
    fs.writeFileSync(channelModule, `export function createLarkChannel(options) {
  return {
    botIdentity: { openId: "ou_" + options.appId, name: options.appId },
    rawClient: { async request() { return { bot: { open_id: "ou_" + options.appId, app_name: options.appId } }; } },
    dispatcher: { register() {} }, on() {}, async connect() {}, async disconnect() {}, async updateCard() {},
  };
}
`);
    const servicePort = await freePort();
    const serviceEnv = {
      ...baseEnv,
      LARKIN_DASHBOARD_PORT: String(servicePort),
      LARKIN_FEISHU_DRYRUN: "1",
      LARKIN_TEST_CHANNEL_MODULE: channelModule,
    };
    let stdout = "", stderr = "";
    service = spawn(artifact, ["start", "--dry-run"], { cwd: temp, env: serviceEnv, stdio: ["ignore", "pipe", "pipe"] });
    service.stdout.on("data", (chunk) => { stdout += chunk; });
    service.stderr.on("data", (chunk) => { stderr += chunk; });
    const output = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
    const dashboardStatus = await waitFor(() => {
      const value = JSON.parse(fs.readFileSync(path.join(configDir, "dashboard-status.json"), "utf8"));
      return value.url ? value : null;
    }, "Dashboard status").catch((error) => { throw new Error(`${error.message}\n${output()}`); });
    await waitFor(async () => {
      const response = await fetch(`${dashboardStatus.url}/api/status`);
      const value = response.ok ? await response.json() : null;
      return value?.daemon?.running ? value : null;
    }, "daemon readiness").catch((error) => { throw new Error(`${error.message}\n${output()}`); });
    await waitFor(() => new RegExp(`bot 身份就绪\\(channel\\).*${appId}`).test(stderr), "Agent control-plane readiness")
      .catch((error) => { throw new Error(`${error.message}\n${output()}`); });

    const runtimeBin = path.join(configDir, "state", "agents", appId, "runtime-bin");
    const runtimeLarkCliPath = path.join(runtimeBin, "lark-cli");
    const runtimeLarkCli = path.join(runtimeBin, "larkin");
    assert.equal(fs.statSync(runtimeLarkCli).mode & 0o077, 0, "standalone Runtime larkin shim must remain private");
    assert.equal(fs.existsSync(runtimeLarkCliPath), false, "standalone must not create a lark-cli shim");
    const nativeVersion = checked(spawnSync(officialLauncher, ["--version"], {
      cwd: temp, env: { ...serviceEnv, LARKIN_AGENT_ID: appId }, encoding: "utf8", timeout: 15_000,
    }), "standalone Runtime pinned lark-cli version");
    assert.match(nativeVersion.stdout, /lark-cli version 1\.0\.79/);
    const evaluatorHelpArgv = ["im", "+messages-send", "--as", "user", "--chat-id", "a", "--chat-id=b", "--help"];
    const standaloneInboxState = path.join(canonicalState, "inbox-state.json");
    const beforeHelpConfig = fs.readFileSync(configFile);
    const beforeHelpProfile = fs.readFileSync(path.join(canonicalState, "lark-cli-config", "config.json"));
    const beforeHelpState = fs.existsSync(standaloneInboxState) ? fs.readFileSync(standaloneInboxState) : null;
    const nativeHelp = checked(spawnSync(runtimeLarkCli, evaluatorHelpArgv, {
      cwd: temp, env: { ...serviceEnv, LARKIN_AGENT_ID: appId }, encoding: "utf8", timeout: 15_000,
    }), "standalone Runtime pinned lark-cli help");
    assert.match(nativeHelp.stdout, /Send a message|Usage|messages-send/i);
    assert.deepEqual(fs.readFileSync(configFile), beforeHelpConfig);
    assert.deepEqual(fs.readFileSync(path.join(canonicalState, "lark-cli-config", "config.json")), beforeHelpProfile);
    assert.deepEqual(fs.existsSync(standaloneInboxState) ? fs.readFileSync(standaloneInboxState) : null, beforeHelpState);
    const boundedHistory = checked(spawnSync(runtimeLarkCli, [
      "im", "+chat-messages-list", "--chat-id", "oc_standalone_window", "--dry-run", "--json",
    ], {
      cwd: temp, env: { ...serviceEnv, LARKIN_AGENT_ID: appId }, encoding: "utf8", timeout: 15_000,
    }), "standalone Runtime history shortcut with Larkin default window");
    assert.match(fs.readFileSync(larkMarker, "utf8"), /\+chat-messages-list[^\n]*--page-size 20/,
      "standalone Runtime wrapper must inject the bounded history window before official delegation");
    const runtimeIdentityEscape = spawnSync(runtimeLarkCli, ["im", "+chat-list", "--profile", otherAgentId], {
      cwd: temp, env: { ...serviceEnv, LARKIN_AGENT_ID: appId }, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(runtimeIdentityEscape.status, 2);
    assert.match(runtimeIdentityEscape.stderr, /身份边界|--profile/);
    fs.appendFileSync(path.join(canonicalState, "feishu-inbox.ndjson"), `${JSON.stringify({
      envelope_version: 2, target: "chat:oc_standalone_guard", target_seq: 1,
      message_id: "om_standalone_guard", chat_id: "oc_standalone_guard", content: "unseen standalone context",
    })}\n`, { mode: 0o600 });
    for (const guardedArgv of [
      ["--chat-id", "oc_standalone_guard", "im", "+messages-send", "--text", "stale prefix", "--dry-run"],
      ["im", "--chat-id", "oc_standalone_guard", "+messages-send", "--text", "stale middle", "--dry-run"],
    ]) {
      const held = checked(spawnSync(runtimeLarkCli, guardedArgv, {
        cwd: temp, env: { ...serviceEnv, LARKIN_AGENT_ID: appId }, encoding: "utf8", timeout: 15_000,
      }), "standalone normalized target hold");
      assert.notEqual(JSON.parse(held.stdout).status, "held", "native dry-run is observational and does not enter the write gate");
    }
    const genericBypass = spawnSync(runtimeLarkCli, ["--as", "bot", "api", "POST", "/open-apis/im/v1/messages"], {
      cwd: temp, env: { ...serviceEnv, LARKIN_AGENT_ID: appId }, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(genericBypass.status, 2);
    assert.match(genericBypass.stderr, /generic API/);
    const threadForward = spawnSync(runtimeLarkCli, ["im", "threads", "forward", "--message-id", "om_standalone_guard"], {
      cwd: temp, env: { ...serviceEnv, LARKIN_AGENT_ID: appId }, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(threadForward.status, 2);
    assert.match(threadForward.stderr, /target freshness/);
    assert.equal(fs.existsSync(larkMarker), true, "standalone Runtime must delegate to the verified host official CLI");
    const nativeProfile = JSON.parse(fs.readFileSync(path.join(configDir, "state", "agents", appId, "lark-cli-config", "config.json"), "utf8"));
    assert.deepEqual(nativeProfile.apps.map((entry) => ({
      appId: entry.appId, name: entry.name, defaultAs: entry.defaultAs, strictMode: entry.strictMode, users: entry.users,
    })), [{ appId, name: appId, defaultAs: "bot", strictMode: "bot", users: [] }]);

    checked(runCli(["config", "model", "default", "--agent", appId], serviceEnv), "save pending config");
    assert.match(checked(runCli(["config", "apply", "--agent", appId], serviceEnv), "authenticated public apply").stdout, /"applyState": "applied"/);
    assert.equal(JSON.parse(checked(runAgentCli(["config", "apply"], serviceEnv), "authenticated Agent apply").stdout).applyState, "applied");

    const html = await (await fetch(dashboardStatus.url)).text();
    const csrf = html.match(/"csrfCapability":"([A-Za-z0-9_-]+)"/)?.[1];
    assert.equal(typeof csrf, "string");
    const configResponse = await fetch(`${dashboardStatus.url}/api/config`, { headers: { "X-Larkin-CSRF": csrf } });
    const dashboardConfig = await configResponse.json();
    assert.equal(configResponse.status, 200);
    assert.equal(dashboardConfig.agents[0].agentId, appId);
    assert.equal("serverId" in dashboardConfig, false);
    const patchResponse = await fetch(`${dashboardStatus.url}/api/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Larkin-CSRF": csrf, Origin: dashboardStatus.url },
      body: JSON.stringify({ operation: "set-agent-mention", agentId: appId, value: "free" }),
    });
    assert.equal(patchResponse.status, 200, await patchResponse.text());
    assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).agents[appId].mentionPolicy, "free");
    const applyResponse = await fetch(`${dashboardStatus.url}/api/config/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Larkin-CSRF": csrf, Origin: dashboardStatus.url },
      body: JSON.stringify({ agentId: appId }),
    });
    assert.equal(applyResponse.status, 200, await applyResponse.text());

    assert.equal(fs.existsSync(CHROME), true, `Chromium executable missing: ${CHROME}`);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const browserProblems = [];
    page.on("console", (message) => { if (["error", "warning"].includes(message.type())) browserProblems.push(`${message.type()}: ${message.text()}`); });
    page.on("pageerror", (error) => browserProblems.push(`pageerror: ${error.message}`));
    await page.goto(`${dashboardStatus.url}/?agent=${appId}&tab=configuration`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 5_000 });
    assert.match(await page.locator(".brand").innerText(), new RegExp(`^Larkin\\s+v${PACKAGE.version.replaceAll(".", "\\.")}$`));
    await page.getByText(/这里只提供常用微调/).waitFor();
    await page.getByText("larkin config --help", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Runtime").inputValue(), "codex");
    assert.equal(await page.getByLabel("Model").inputValue(), "default");
    await page.getByLabel("群消息策略").selectOption("require");
    await page.getByRole("button", { name: "保存 Agent 配置" }).click();
    await page.getByText(/配置已保存/).waitFor();
    const chatEditor = page.locator(".chat-add");
    await chatEditor.getByPlaceholder("oc_QAConfigChat1").fill("oc_browser_acceptance");
    await chatEditor.getByLabel("消息策略").selectOption("free");
    await chatEditor.getByRole("button", { name: "保存群策略" }).click();
    const chatRow = page.getByRole("row").filter({ hasText: "oc_browser_acceptance" });
    await chatRow.waitFor();
    await chatRow.getByRole("button", { name: "移除特别配置" }).click();
    await chatRow.waitFor({ state: "detached" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle" });
    const overflow = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(overflow.scrollWidth <= overflow.width, `mobile overflow: ${JSON.stringify(overflow)}`);
    await page.getByRole("button", { name: "打开 Agent 导航" }).click();
    await page.getByRole("dialog").waitFor();
    assert.deepEqual(browserProblems, []);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stop(service);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
