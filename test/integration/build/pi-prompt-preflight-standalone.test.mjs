import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const ENABLED = process.env.LARKIN_RUN_PI_PREFLIGHT_STANDALONE === "1";

function checked(command, args, options, label) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.error, undefined, `${label}: ${result.error?.message || "spawn error"}`);
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`);
  return result;
}

async function waitFor(read, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs; let lastError;
  while (Date.now() < deadline) {
    try { const value = read(); if (value) return value; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}: ${lastError?.message || "not ready"}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  if (!await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 8_000))])) {
    child.kill("SIGKILL"); await exited;
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}

function rows(file) {
  try { return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch { return []; }
}

function spans(spoolDir) {
  try {
    return fs.readdirSync(spoolDir).filter((name) => /^span-.*\.json$/.test(name))
      .flatMap((name) => JSON.parse(fs.readFileSync(path.join(spoolDir, name), "utf8")).resourceSpans)
      .flatMap((resource) => resource.scopeSpans).flatMap((scope) => scope.spans);
  } catch { return []; }
}

function writeOfficialLarkCli(mockBin) {
  const packageDir = path.join(path.dirname(mockBin), "official", "node_modules", "@larksuite", "cli");
  const launcher = path.join(packageDir, "scripts", "run.sh");
  fs.mkdirSync(path.dirname(launcher), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@larksuite/cli", version: "1.0.80", bin: { "lark-cli": "scripts/run.sh" },
  }), { mode: 0o600 });
  fs.writeFileSync(launcher, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.0.80\n'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "bind" ] && [ "$3" = "--help" ]; then
  printf '%s\n' 'Usage: config bind --source lark-channel --identity bot-only'; exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "bind" ]; then
  ${JSON.stringify(process.execPath)} --eval 'const fs=require("node:fs"),path=require("node:path"),source=JSON.parse(fs.readFileSync(process.env.LARK_CHANNEL_CONFIG,"utf8")),id=source.accounts.app.id,dir=path.join(process.env.LARKSUITE_CLI_CONFIG_DIR,"lark-channel");fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,"config.json"),JSON.stringify({apps:[{appId:id,appSecret:{source:"keychain",id:"appsecret:"+id},defaultAs:"bot",strictMode:"bot",users:[]}]}),{mode:0o600})'
  exit $?
fi
case "$*" in *+chat-list*) printf '%s\n' '{"ok":true,"identity":"bot","data":{"chats":[]}}' ;; esac
exit 0
`, { mode: 0o755 });
  fs.symlinkSync(launcher, path.join(mockBin, "lark-cli"));
}

const piFixture = `import fs from "node:fs";
import readline from "node:readline";
if (process.argv.includes("--version")) { console.log("0.83.0"); process.exit(0); }
const marker = process.env.PI_PREFLIGHT_MARKER;
const record = (value) => fs.appendFileSync(marker, JSON.stringify(value) + "\\n");
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const model = { provider: "fixture", id: "pi-preflight", reasoning: false, contextWindow: 272000 };
record({ type: "launch", args: process.argv.slice(2) });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "get_state") return output({ id: request.id, type: "response", command: request.type, success: true,
    data: { sessionId: "PRIVATE_STANDALONE_SESSION", model, thinkingLevel: "off", isStreaming: false,
      autoCompactionEnabled: true, compactionCapabilities: { reserveTokens: 40800, keepRecentTokens: 20000,
        events: ["compaction_start", "compaction_end", "agent_end", "agent_settled"] } } });
  if (request.type === "get_available_models") return output({ id: request.id, type: "response", command: request.type, success: true,
    data: { models: [model] } });
  if (request.type !== "prompt") return;
  record({ type: "prompt" });
  setTimeout(() => output({ type: "compaction_start", reason: "threshold" }), 9000);
  setTimeout(() => output({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 50,
    errorMessage: "PRIVATE_STANDALONE_PROVIDER_DETAIL" }), 10050);
  setTimeout(() => output({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
    result: { summary: "PRIVATE_STANDALONE_SUMMARY" } }), 10500);
  setTimeout(() => output({ id: request.id, type: "response", command: request.type, success: true }), 11000);
  setTimeout(() => output({ type: "turn_start", turnIndex: 0 }), 11020);
  setTimeout(() => output({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop" }] }), 13000);
  setTimeout(() => output({ type: "agent_settled" }), 13020);
});
`;

test.skipIf(!ENABLED)("standalone Pi keeps delayed compaction preflight pending, accepts once, consumes Inbox, and spools safe OTel", {
  timeout: 180_000,
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-preflight-standalone-"));
  const releaseDir = path.join(temp, "release"); const home = path.join(temp, "home");
  const configDir = path.join(temp, "config"); const mockBin = path.join(temp, "bin");
  const spoolDir = path.join(temp, "otel-spool"); const marker = path.join(temp, "pi-protocol.ndjson");
  const eventFile = path.join(configDir, "events.ndjson"); const agentId = "cli_piStandaloneA1";
  const stateDir = path.join(configDir, "state", "agents", agentId);
  const buildEnv = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}` };
  let service; let stdout = ""; let stderr = "";
  try {
    for (const directory of [home, configDir, mockBin, spoolDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(eventFile, ""); fs.writeFileSync(marker, ""); writeOfficialLarkCli(mockBin);
    checked(process.execPath, ["run", "build"], { cwd: ROOT, env: buildEnv, timeout: 120_000 }, "build production dist");
    checked(process.execPath, ["scripts/release/build.ts", "--target", `${os.platform()}-${os.arch()}`,
      "--out-dir", releaseDir, "--allow-dirty"], { cwd: ROOT, env: buildEnv, timeout: 120_000 }, "compile standalone");
    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "release-manifest.json"), "utf8"));
    const artifact = path.join(releaseDir, manifest.artifacts[0].file);
    const piSource = path.join(temp, "fake-pi.mjs"); const piCommand = path.join(mockBin, "pi");
    fs.writeFileSync(piSource, piFixture, { mode: 0o600 });
    checked(process.execPath, ["build", piSource, "--compile", "--minify", `--outfile=${piCommand}`], {
      cwd: temp, env: buildEnv, timeout: 60_000,
    }, "compile fake Pi");
    fs.writeFileSync(path.join(configDir, "config.json"), `${JSON.stringify({
      version: 4, serverId: "pi-preflight-standalone", mentionPolicy: "free", activeAgent: agentId,
      agents: { [agentId]: { runtime: "pi", model: "fixture/pi-preflight", piDistribution: "external" } },
    }, null, 2)}\n`, { mode: 0o600 });
    const botsDir = path.join(configDir, "bots"); fs.mkdirSync(botsDir, { mode: 0o700 });
    fs.writeFileSync(path.join(botsDir, `${agentId}.json`), JSON.stringify({
      appId: agentId, appSecret: "fixture-only-secret", tenant: "feishu",
    }), { mode: 0o600 });
    const env = { PATH: `${mockBin}:/usr/bin:/bin`, HOME: home, TMPDIR: os.tmpdir(), LARKIN_CONFIG_DIR: configDir,
      LARKIN_PI_COMMAND: piCommand, LARKIN_FEISHU_EVENT_FILE: eventFile, LARKIN_DASHBOARD_PORT: String(await freePort()),
      LARKIN_TELEMETRY_SPOOL_DIR: spoolDir, PI_PREFLIGHT_MARKER: marker };
    service = spawn(artifact, ["start", "--dry-run"], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
    service.stdout.on("data", (chunk) => { stdout += chunk; }); service.stderr.on("data", (chunk) => { stderr += chunk; });
    const diagnostics = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
    await waitFor(() => /agent:status .* active/.test(stderr), "standalone Pi ready").catch((error) => {
      throw new Error(`${error.message}\n${diagnostics()}`);
    });
    await waitFor(() => /文件事件源\(测试\)/.test(stderr), "standalone synthetic event source").catch((error) => {
      throw new Error(`${error.message}\n${diagnostics()}`);
    });
    const event = { chat_id: "oc_private", chat_type: "p2p", sender_id: "ou_private", message_id: "om_private_preflight",
      event_id: "evt_private_preflight", content: "PRIVATE_STANDALONE_PROMPT", create_time: "1786000000000", thread_id: null,
      _mentioned_bot: true, _mention_all: false, _sender_is_bot: false };
    fs.appendFileSync(eventFile, `${JSON.stringify(event)}\n`);
    await waitFor(() => rows(marker).some((row) => row.type === "prompt"), "standalone Pi prompt submission");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const deliveryFile = path.join(stateDir, "runtime-deliveries.json");
    const delivery = () => JSON.parse(fs.readFileSync(deliveryFile, "utf8")).records.find((row) => row.messageId === event.message_id);
    assert.equal(delivery()?.status, "submitting", diagnostics());
    await waitFor(() => delivery()?.status === "accepted", "delayed standalone Pi acceptance", 15_000).catch((error) => {
      throw new Error(`${error.message}; delivery=${JSON.stringify(delivery())}\n${diagnostics()}`);
    });
    assert.equal(rows(marker).filter((row) => row.type === "launch" && row.args.includes("--session-dir")).length, 1,
      "no Runtime preflight recreation (catalog probe is separate)");
    assert.equal(rows(marker).filter((row) => row.type === "prompt").length, 1, "one prompt submission");
    const drained = checked(artifact, ["__internal", "agent-cli", "inbox", "poll"], {
      cwd: home, env: { ...env, LARKIN_AGENT_ID: agentId }, timeout: 15_000,
    }, "consume delayed standalone Inbox");
    const poll = JSON.parse(drained.stdout);
    assert.equal(poll.events.filter((row) => row.message_id === event.message_id).length, 1);
    assert.equal(poll.events.filter((row) => String(row.message_id).startsWith("redeliver_")).length, 1,
      "startup unread projection may share the same bounded poll without duplicating the source event");
    assert.equal(poll.consumed_delivery_ids.length, 2);
    await waitFor(() => delivery()?.status === "consumed",
      "standalone Inbox consumption");
    const otel = await waitFor(() => {
      const current = spans(spoolDir); const names = new Set(current.map((span) => span.name));
      return names.has("pi.prompt.wait") && names.has("pi.compaction") && names.has("agent.turn") ? current : null;
    }, "standalone Pi OTel spool", 20_000);
    const wait = otel.find((span) => span.name === "pi.prompt.wait");
    assert.equal(wait.attributes.find((attribute) => attribute.key === "larkin.runtime.distribution")?.value?.stringValue, "external");
    assert.equal(wait.attributes.find((attribute) => attribute.key === "larkin.pi.preflight.outcome")?.value?.stringValue, "accepted");
    for (const name of ["pi.rpc.submit", "pi.rpc.lifecycle", "pi.output.wait", "pi.generation", "pi.tool.wait", "pi.rpc.settle"]) {
      assert.equal(otel.some((span) => span.name === name), false, `external standalone omits ${name}`);
    }
    const serialized = JSON.stringify(otel);
    for (const forbidden of [agentId, event.message_id, event.content, "PRIVATE_STANDALONE_PROVIDER_DETAIL",
      "PRIVATE_STANDALONE_SUMMARY", "PRIVATE_STANDALONE_SESSION", temp]) assert.equal(serialized.includes(forbidden), false, forbidden);
  } finally {
    await stop(service); fs.rmSync(temp, { recursive: true, force: true });
  }
});
