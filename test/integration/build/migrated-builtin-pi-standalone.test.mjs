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
const AGENT = "cli_migratedBuiltinA1";

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
  const config = path.join(temp, "config"); const bin = path.join(temp, "bin"); const events = path.join(config, "events.ndjson");
  const release = path.join(temp, "release"); fs.mkdirSync(config, { mode: 0o700 }); fs.mkdirSync(bin, { mode: 0o700 }); fs.writeFileSync(events, ""); writeOfficialLarkCli(temp, bin);
  let requests = 0; const provider = http.createServer((req, res) => { req.resume(); req.on("end", () => { requests += 1; res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"MIGRATED_READY"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n'); }); });
  await new Promise((r, j) => { provider.once("error", j); provider.listen(0, "127.0.0.1", r); });
  try {
    checked(spawnSync(process.execPath, ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 }), "build dist");
    checked(spawnSync(process.execPath, ["scripts/release/build.ts", "--target", `${os.platform()}-${os.arch()}`, "--out-dir", release, "--allow-dirty"], { cwd: ROOT, encoding: "utf8", timeout: 150_000 }), "build standalone");
    const manifest = JSON.parse(fs.readFileSync(path.join(release, "release-manifest.json"), "utf8")); const artifact = path.join(release, manifest.artifacts[0].file);
    fs.mkdirSync(path.join(config, "bots"), { mode: 0o700 });
    fs.writeFileSync(path.join(config, "config.json"), `${JSON.stringify({ version: 4, serverId: "migrated-standalone", mentionPolicy: "free", activeAgent: AGENT, agents: { [AGENT]: { runtime: "pi", model: "larkin-custom/fixture-model", piDistribution: "external" } } })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(config, "bots", `${AGENT}.json`), JSON.stringify({ appId: AGENT, appSecret: "fixture-secret", tenant: "feishu" }), { mode: 0o600 });
    const external = path.join(temp, "external", "agent"); fs.mkdirSync(external, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(external, "auth.json"), JSON.stringify({ "larkin-custom": { type: "api_key", key: "fixture-key" } }) + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(external, "models.json"), JSON.stringify({ providers: { "larkin-custom": { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", models: [{ id: "fixture-model", contextWindow: 272000, reasoning: false, input: ["text"] }] } } }) + "\n", { mode: 0o644 });
    fs.writeFileSync(path.join(external, "settings.json"), JSON.stringify({ theme: "dark", compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 2 } }) + "\n", { mode: 0o644 });
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nconsole.log("0.84.2")\n`, { mode: 0o700 });
    const baseEnv = { ...process.env, HOME: temp, PATH: `${bin}:/usr/bin:/bin`, LARKIN_CONFIG_DIR: config, LARKIN_HOME: config, PI_CODING_AGENT_DIR: external, LARKIN_FEISHU_EVENT_FILE: events, LARKIN_DASHBOARD_PORT: String(await freePort()), PI_TELEMETRY: "0" };
    const imported = spawnSync(process.execPath, [path.join(ROOT, "dist/app/agent-config.mjs"), "pi-distribution", "builtin", "--agent", AGENT, "--snapshot", path.join(config, "migration.snapshot.json"), "--import-external-profile"], { cwd: ROOT, env: baseEnv, encoding: "utf8", timeout: 30_000 });
    checked(imported, "import external Pi profile");
    const env = baseEnv;
    const statusFile = path.join(config, "state", "agents", AGENT, "status.json");
    const deliveryFile = path.join(config, "state", "agents", AGENT, "runtime-deliveries.json");
    let logs = "";
    const start = () => { const child = spawn(artifact, ["start", "--dry-run"], { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"] }); child.stdout.on("data", (chunk) => { logs += String(chunk); }); child.stderr.on("data", (chunk) => { logs += String(chunk); }); return child; };
    let service = start();
    const first = await waitFor(() => { const s = JSON.parse(fs.readFileSync(statusFile, "utf8")); return s.runtimeReadiness?.state === "ready" && s.runtimeReadiness.version === "official-pi 0.84.2 (bundled)" && s.session?.id ? s : null; }, "first bundled Pi RPC get_state handshake");
    const providerDir = path.join(config, "providers", "pi", AGENT);
    const models = JSON.parse(fs.readFileSync(path.join(providerDir, "models.json"), "utf8")); const settings = JSON.parse(fs.readFileSync(path.join(providerDir, "settings.json"), "utf8"));
    assert.equal(models.providers["larkin-custom"].models[0].contextWindow, 272000);
    assert.equal(settings.theme, "dark");
    assert.deepEqual(settings.compaction, { enabled: true, reserveTokens: 40800, keepRecentTokens: 20000 });
    fs.appendFileSync(events, `${JSON.stringify({ chat_id: "oc_fixture", chat_type: "p2p", sender_id: "ou_fixture", message_id: "om_migrated_1", event_id: "evt_migrated_1", content: "local fixture turn", create_time: "1787000000000", thread_id: null, _mentioned_bot: true, _mention_all: false, _sender_is_bot: false })}\n`);
    await waitFor(() => requests >= 1 && JSON.parse(fs.readFileSync(deliveryFile, "utf8")).records.some((r) => r.messageId === "om_migrated_1" && ["accepted", "submitting", "pending"].includes(r.status)), "first local provider turn").catch((error) => { throw new Error(`${error.message}\nrequests=${requests}\nlogs=${logs.slice(-2000)}`); });
    await stop(service); service = start();
    const resumed = await waitFor(() => { const s = JSON.parse(fs.readFileSync(statusFile, "utf8")); return s.runtimeReadiness?.state === "ready" && s.session?.id ? s : null; }, "resumed bundled Pi RPC get_state handshake");
    assert.equal(resumed.session.id, first.session.id, "standalone Pi must resume the persisted session");
    fs.appendFileSync(events, `${JSON.stringify({ chat_id: "oc_fixture", chat_type: "p2p", sender_id: "ou_fixture", message_id: "om_migrated_2", event_id: "evt_migrated_2", content: "local fixture resumed turn", create_time: "1787000000001", thread_id: null, _mentioned_bot: true, _mention_all: false, _sender_is_bot: false })}\n`);
    await waitFor(() => requests >= 2 && JSON.parse(fs.readFileSync(deliveryFile, "utf8")).records.some((r) => r.messageId === "om_migrated_2" && ["accepted", "submitting", "pending"].includes(r.status)), "resumed local provider turn");
    await stop(service);
  } finally { await new Promise((r) => provider.close(r)); fs.rmSync(temp, { recursive: true, force: true }); }
}

test.skipIf(!ENABLED)("migrated external Pi profile runs the actual standalone bundled Pi through RPC, local turns, and session resume", { timeout: 300_000 }, run);
