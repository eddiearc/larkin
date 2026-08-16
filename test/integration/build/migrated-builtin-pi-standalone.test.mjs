import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const ENABLED = process.env.LARKIN_RUN_MIGRATED_BUILTIN_PI_STANDALONE === "1";
const AGENTS = ["cli_migratedBuiltinA1", "cli_migratedBuiltinA2", "cli_migratedBuiltinA3"];
const AGENT = AGENTS[0];

function checked(result, label) { assert.equal(result.status, 0, `${label}\n${result.stdout || ""}\n${result.stderr || ""}`); return result; }
async function freePort() { const s = net.createServer(); await new Promise((r, j) => { s.once("error", j); s.listen(0, "127.0.0.1", r); }); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
async function waitFor(read, label, timeout = 30_000) { const end = Date.now() + timeout; while (Date.now() < end) { try { const value = read(); if (value) return value; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timed out waiting for ${label}`); }
async function stop(child) { if (!child || child.exitCode !== null) return; const exited = once(child, "exit"); child.kill("SIGTERM"); if (!await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 8_000))])) { child.kill("SIGKILL"); await exited; } }
function writeOfficialLarkCli(temp, bin) {
  const packageDir = path.join(temp, "official", "node_modules", "@larksuite", "cli");
  const launcher = path.join(packageDir, "scripts", "run.sh");
  fs.mkdirSync(path.dirname(launcher), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@larksuite/cli", version: "1.0.80", bin: { "lark-cli": "scripts/run.sh" } }), { mode: 0o600 });
  fs.writeFileSync(launcher, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.0.80; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "bind" ] && [ "$3" = "--help" ]; then echo 'Usage: config bind --source lark-channel --identity bot-only'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "bind" ]; then
  ${JSON.stringify(process.execPath)} -e 'const fs=require("fs"),path=require("path"),s=JSON.parse(fs.readFileSync(process.env.LARK_CHANNEL_CONFIG,"utf8")),id=s.accounts.app.id,d=path.join(process.env.LARKSUITE_CLI_CONFIG_DIR,"lark-channel");fs.mkdirSync(d,{recursive:true,mode:448});fs.writeFileSync(path.join(d,"config.json"),JSON.stringify({apps:[{appId:id,appSecret:{source:"keychain",id:"appsecret:"+id},defaultAs:"bot",strictMode:"bot",users:[]}]}));fs.chmodSync(path.join(d,"config.json"),384);'
  exit $?
fi
case "$*" in *+chat-list*) echo '{"ok":true,"identity":"bot","data":{"chats":[]}}' ;; esac
exit 0
`, { mode: 0o700 });
  fs.chmodSync(launcher, 0o700); fs.symlinkSync(launcher, path.join(bin, "lark-cli"));
}

async function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-migrated-builtin-standalone-"));
  const config = path.join(temp, ".larkin"); const bin = path.join(temp, "bin"); const events = path.join(config, "events.ndjson");
  const release = path.join(temp, "release"); fs.mkdirSync(config, { mode: 0o700 }); fs.mkdirSync(bin, { mode: 0o700 }); fs.writeFileSync(events, ""); writeOfficialLarkCli(temp, bin);
  let requests = 0; const provider = http.createServer((req, res) => { req.resume(); req.on("end", () => { requests += 1; res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"MIGRATED_READY"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n'); }); });
  await new Promise((r, j) => { provider.once("error", j); provider.listen(0, "127.0.0.1", r); });
  try {
    checked(spawnSync(process.execPath, ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 }), "build dist");
    checked(spawnSync(process.execPath, ["scripts/release/build.ts", "--target", `${os.platform()}-${os.arch()}`, "--out-dir", release, "--allow-dirty"], { cwd: ROOT, encoding: "utf8", timeout: 150_000 }), "build standalone");
    const manifest = JSON.parse(fs.readFileSync(path.join(release, "release-manifest.json"), "utf8")); const artifact = path.join(release, manifest.artifacts[0].file);
    const installedDir = path.join(temp, "installed"); const installed = path.join(installedDir, "larkin");
    fs.mkdirSync(installedDir, { mode: 0o700 }); fs.copyFileSync(artifact, installed); fs.chmodSync(installed, 0o700);
    const traceFile = path.join(config, "process-boundary.ndjson"); fs.writeFileSync(traceFile, "", { mode: 0o600 });
    fs.mkdirSync(path.join(config, "bots"), { mode: 0o700 });
    const agents = Object.fromEntries(AGENTS.map((agentId) => [agentId, { runtime: "pi", model: "larkin-custom/fixture-model", piDistribution: "external" }]));
    fs.writeFileSync(path.join(config, "config.json"), `${JSON.stringify({ version: 4, serverId: "migrated-standalone", mentionPolicy: "free", activeAgent: AGENT, agents })}\n`, { mode: 0o600 });
    for (const agentId of AGENTS) fs.writeFileSync(path.join(config, "bots", `${agentId}.json`), JSON.stringify({ appId: agentId, appSecret: "fixture-secret", tenant: "feishu" }), { mode: 0o600 });
    const external = path.join(temp, "external", "agent"); fs.mkdirSync(external, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(external, "auth.json"), JSON.stringify({ "larkin-custom": { type: "api_key", key: "fixture-key" } }) + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(external, "models.json"), JSON.stringify({ providers: { "larkin-custom": { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", models: [{ id: "fixture-model", contextWindow: 272000, reasoning: false, input: ["text"] }] } } }) + "\n", { mode: 0o644 });
    fs.writeFileSync(path.join(external, "settings.json"), JSON.stringify({ theme: "dark", compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 2 } }) + "\n", { mode: 0o644 });
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nconsole.log("0.84.2")\n`, { mode: 0o700 });
    const baseEnv = { ...process.env, HOME: temp, PATH: `${installedDir}:${bin}:/usr/bin:/bin`, LARKIN_CONFIG_DIR: config, LARKIN_HOME: config, PI_CODING_AGENT_DIR: external, LARKIN_FEISHU_EVENT_FILE: events, LARKIN_DASHBOARD_PORT: String(await freePort()), LARKIN_PROCESS_BOUNDARY_TRACE_FILE: traceFile, PI_TELEMETRY: "0" };
    for (const agentId of AGENTS) {
      const imported = spawnSync(installed, ["pi-distribution", "builtin", "--agent", agentId, "--snapshot", path.join(config, `${agentId}.migration.snapshot.json`), "--import-external-profile"], { cwd: temp, env: baseEnv, encoding: "utf8", timeout: 30_000 });
      checked(imported, `import external Pi profile ${agentId}`);
    }
    const env = { ...baseEnv };
    delete env.LARKIN_CONFIG_DIR;
    delete env.LARKIN_HOME;
    delete env.PI_CODING_AGENT_DIR;
    const statusFile = path.join(config, "state", "agents", AGENT, "status.json");
    const deliveryFile = path.join(config, "state", "agents", AGENT, "runtime-deliveries.json");
    const statusFor = (agentId) => path.join(config, "state", "agents", agentId, "status.json");
    const staleStatusAt = new Date(Date.now() - 60 * 60 * 1_000);
    for (const agentId of AGENTS) {
      const staleFile = statusFor(agentId);
      fs.mkdirSync(path.dirname(staleFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(staleFile, JSON.stringify({ runtimeReadiness: { runtime: "pi", state: "incompatible", reason: "stale fixture" }, session: { runtime: "pi", id: "stale-session", startedAt: staleStatusAt.toISOString() } }), { mode: 0o600 });
      fs.utimesSync(staleFile, staleStatusAt, staleStatusAt);
    }
    let logs = "";
    const traceDump = () => fs.readFileSync(traceFile, "utf8").trim();
    const start = () => { const startedBefore = Date.now(); const child = spawn(installed, ["start", "--dry-run"], { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"] }); child.stdout.on("data", (chunk) => { logs += String(chunk); }); child.stderr.on("data", (chunk) => { logs += String(chunk); }); return { child, startedBefore }; };
    let service = start();
    const first = await waitFor(() => {
      const statuses = AGENTS.map((agentId) => JSON.parse(fs.readFileSync(statusFor(agentId), "utf8")));
      return statuses.every((s) => s.runtimeReadiness?.state === "ready" && s.runtimeReadiness.version === "official-pi 0.84.2 (bundled)" && s.session?.id) ? statuses[0] : null;
    }, "all bundled Pi RPC get_state handshakes").catch((error) => { throw new Error(`${error.message}\ntrace=${traceDump()}\nlogs=${logs.slice(-4000)}`); });
    const daemonStatus = JSON.parse(fs.readFileSync(path.join(config, "daemon-status.json"), "utf8"));
    const daemonStartedAt = Date.parse(String(daemonStatus.startedAt || ""));
    assert.equal(Number.isFinite(daemonStartedAt), true, "fresh daemon start marker is required");
    for (const agentId of AGENTS) {
      const status = JSON.parse(fs.readFileSync(statusFor(agentId), "utf8"));
      assert.equal(Date.parse(String(status.session?.startedAt || "")) >= daemonStartedAt - 1_000, true, `session freshness for ${agentId}`);
      assert.equal(Date.parse(String(status.runtimeReadiness?.observedAt || "")) >= daemonStartedAt - 1_000, true, `readiness freshness for ${agentId}`);
      assert.equal(fs.statSync(statusFor(agentId)).mtimeMs >= daemonStartedAt - 1_000, true, `status freshness for ${agentId}`);
    }
    const providerDir = path.join(config, "providers", "pi", AGENT);
    const models = JSON.parse(fs.readFileSync(path.join(providerDir, "models.json"), "utf8")); const settings = JSON.parse(fs.readFileSync(path.join(providerDir, "settings.json"), "utf8"));
    assert.equal(models.providers["larkin-custom"].models[0].contextWindow, 272000);
    assert.equal(settings.theme, "dark");
    assert.deepEqual(settings.compaction, { enabled: true, reserveTokens: 40800, keepRecentTokens: 20000 });
    fs.appendFileSync(events, `${JSON.stringify({ chat_id: "oc_fixture", chat_type: "p2p", sender_id: "ou_fixture", message_id: "om_migrated_1", event_id: "evt_migrated_1", content: "local fixture turn", create_time: "1787000000000", thread_id: null, _mentioned_bot: true, _mention_all: false, _sender_is_bot: false })}\n`);
    await waitFor(() => requests >= 1 && JSON.parse(fs.readFileSync(deliveryFile, "utf8")).records.some((r) => r.messageId === "om_migrated_1" && ["accepted", "submitting", "pending"].includes(r.status)), "first local provider turn").catch((error) => { throw new Error(`${error.message}\nrequests=${requests}\nlogs=${logs.slice(-2000)}`); });
    await stop(service.child); service = start();
    const resumed = await waitFor(() => {
      let daemon;
      try { daemon = JSON.parse(fs.readFileSync(path.join(config, "daemon-status.json"), "utf8")); } catch { return null; }
      const daemonStartedAt = Date.parse(String(daemon.startedAt || ""));
      if (!Number.isFinite(daemonStartedAt) || daemonStartedAt < service.startedBefore) return null;
      const statuses = AGENTS.map((agentId) => {
        const file = statusFor(agentId);
        try {
          const status = JSON.parse(fs.readFileSync(file, "utf8"));
          return fs.statSync(file).mtimeMs >= daemonStartedAt - 1_000
            && status.runtimeReadiness?.state === "ready" && status.runtimeReadiness.version === "official-pi 0.84.2 (bundled)" && status.session?.id
            ? status : null;
        } catch { return null; }
      });
      return statuses.every(Boolean) ? statuses[0] : null;
    }, "resumed bundled Pi get_state handshake with fresh daemon/status epoch").catch((error) => { throw new Error(`${error.message}\ntrace=${traceDump()}\nlogs=${logs.slice(-4000)}`); });
    assert.equal(resumed.session.id, first.session.id, "standalone Pi must resume the persisted session");
    fs.appendFileSync(events, `${JSON.stringify({ chat_id: "oc_fixture", chat_type: "p2p", sender_id: "ou_fixture", message_id: "om_migrated_2", event_id: "evt_migrated_2", content: "local fixture resumed turn", create_time: "1787000000001", thread_id: null, _mentioned_bot: true, _mention_all: false, _sender_is_bot: false })}\n`);
    await waitFor(() => requests >= 2 && JSON.parse(fs.readFileSync(deliveryFile, "utf8")).records.some((r) => r.messageId === "om_migrated_2" && ["accepted", "submitting", "pending"].includes(r.status)), "resumed local provider turn");
    await stop(service.child);
    assert.equal(fs.existsSync(providerDir), true, "launchd-style restart must retain the imported per-Agent directory");
    assert.equal(fs.statSync(providerDir).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(providerDir, "settings.json")), true);
    for (const agentId of AGENTS) assert.equal(fs.existsSync(path.join(config, `${agentId}.migration.snapshot.json`)), true, "retained migration snapshot must not trigger startup rollback");
    const trace = traceDump().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(trace.some((entry) => entry.phase === "agent-config:pi-distribution-persisted" && entry.target?.exists === true), true);
    for (const agentId of AGENTS) for (const phase of ["supervisor:config-loaded", "supervisor:daemon-env-prepared", "daemon:config-loaded", "daemon:before-runtime-ready", "pi-rpc:child-env"]) {
      const entry = trace.find((candidate) => candidate.phase === phase && candidate.agentId === agentId);
      assert.ok(entry, `missing process-boundary trace phase ${phase} agent=${agentId}`);
      if (phase === "pi-rpc:child-env") assert.equal(entry.pid, daemonStatus.pid, `Pi child environment must be resolved by the current daemon for ${agentId}: entry=${JSON.stringify(entry)} daemon=${JSON.stringify(daemonStatus)}`);
      assert.equal(entry.configDir, config);
      assert.equal(entry.target?.path, path.join(config, "providers", "pi", agentId));
      assert.equal(entry.target?.exists, true, `${phase} must see the imported provider directory for ${agentId}`);
    }
    assert.equal(trace.some((entry) => entry.phase === "readiness:builtin-pi-failure"), false, "readiness must not lose the provider directory");
  } finally { await new Promise((r) => provider.close(r)); fs.rmSync(temp, { recursive: true, force: true }); }
}

test.skipIf(!ENABLED)("migrated external Pi profile survives a launchd-style standalone start through RPC, local turns, and session resume", { timeout: 300_000 }, run);
