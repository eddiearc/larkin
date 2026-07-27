import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const RUN = process.env.LARKIN_RUN_PI_LOCAL_RPC_OAUTH_E2E === "1";
const ROOT = path.resolve(import.meta.dirname, "../..");
const MINIMUM_PI_RPC_VERSION = [0, 82, 0];
const DEFAULT_MODEL = "openai-codex/gpt-5.6-sol";
const MODEL = String(process.env.LARKIN_PI_LOCAL_RPC_MODEL || DEFAULT_MODEL).trim();
const MARKER = String(process.env.LARKIN_PI_LOCAL_RPC_MARKER || "LOCAL_RPC_OK").trim();
const EFFORT = String(process.env.LARKIN_PI_LOCAL_RPC_EFFORT || (MODEL === DEFAULT_MODEL ? "minimal" : "")).trim();
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(MODEL)) throw new Error("LARKIN_PI_LOCAL_RPC_MODEL must be provider/model");
if (!/^[A-Z0-9_]{3,64}$/.test(MARKER)) throw new Error("LARKIN_PI_LOCAL_RPC_MARKER must be a safe uppercase marker");
if (EFFORT && !/^[A-Za-z0-9_-]+$/.test(EFFORT)) throw new Error("LARKIN_PI_LOCAL_RPC_EFFORT is invalid");
if (process.env.LARKIN_PI_LOCAL_RPC_REQUIRE_MODEL_OVERRIDE === "1" && MODEL === DEFAULT_MODEL) {
  throw new Error("provider live entry requires LARKIN_PI_LOCAL_RPC_MODEL override");
}

function compatiblePiVersion(value) {
  const match = String(value).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== MINIMUM_PI_RPC_VERSION[index]) return actual[index] > MINIMUM_PI_RPC_VERSION[index];
  }
  return true;
}

const waitFor = async (read, label, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = read(); if (value) return value; } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
};

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

test.skipIf(!RUN)("release standalone Larkin completes a real local Pi provider turn through fake IM", async () => {
  const pi = process.env.LARKIN_PI_COMMAND || "/opt/homebrew/bin/pi";
  const version = spawnSync(pi, ["--version"], { encoding: "utf8", timeout: 5_000 });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(compatiblePiVersion(version.stdout), true,
    `Pi ${version.stdout.trim()} is older than the local RPC compatibility floor ${MINIMUM_PI_RPC_VERSION.join(".")}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-rpc-live-"));
  let service;
  try {
    const releaseDir = path.join(temp, "release");
    const build = spawnSync(process.execPath, ["scripts/release/build.ts", "--target", `${os.platform()}-${os.arch()}`, "--out-dir", releaseDir, "--allow-dirty"], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ""}` },
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "release-manifest.json"), "utf8"));
    const artifact = path.join(releaseDir, manifest.artifacts[0].file);
    const home = path.join(temp, "home");
    const larkinHome = path.join(home, "larkin");
    const bin = path.join(home, "bin");
    const eventFile = path.join(larkinHome, "events.ndjson");
    const trace = path.join(home, "fake-im.ndjson");
    const agentId = "cli_piRpcLiveA1";
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    fs.mkdirSync(larkinHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(eventFile, "");
    fs.writeFileSync(path.join(bin, "lark-cli"), `#!/bin/sh
case "$*" in
  *+chat-list*) printf '%s\n' '{"ok":true,"identity":"bot","data":{"chats":[]}}' ;;
  *+messages-send*|*+messages-reply*) printf '%s\n' "$*" >> "$LARKIN_FAKE_IM_TRACE"; printf '%s\n' '{"ok":true,"data":{"message_id":"om_fake_local"}}' ;;
esac
exit 0
`, { mode: 0o700 });
    fs.writeFileSync(path.join(larkinHome, "config.json"), `${JSON.stringify({ version: 4, serverId: "pi-rpc-live", mentionPolicy: "free", activeAgent: agentId,
      agents: { [agentId]: { runtime: "pi", model: MODEL, ...(EFFORT ? { effort: EFFORT } : {}) } } }, null, 2)}\n`, { mode: 0o600 });
    fs.mkdirSync(path.join(larkinHome, "bots"), { mode: 0o700 });
    fs.writeFileSync(path.join(larkinHome, "bots", `${agentId}.json`), `${JSON.stringify({ appId: agentId, appSecret: "fixture-only", tenant: "feishu" })}\n`, { mode: 0o600 });
    const inheritedPath = process.env.PATH || "";
    const runtimePath = [bin, ...(path.isAbsolute(pi) ? [path.dirname(pi)] : []), path.dirname(process.execPath), inheritedPath]
      .filter(Boolean).join(path.delimiter);
    const oauthAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    assert.equal(fs.statSync(oauthAgentDir).isDirectory(), true, "real OAuth gate requires the authenticated Pi agent directory");
    const env = { ...process.env, HOME: home, LARKIN_CONFIG_DIR: larkinHome, LARKIN_PI_COMMAND: pi,
      PI_CODING_AGENT_DIR: oauthAgentDir,
      LARKIN_FEISHU_EVENT_FILE: eventFile, LARKIN_DASHBOARD_PORT: String(await freePort()), LARKIN_FAKE_IM_TRACE: trace,
      PATH: runtimePath };
    let stderr = "";
    service = spawn(artifact, ["start", "--dry-run"], { cwd: home, env, stdio: ["ignore", "ignore", "pipe"] });
    service.stderr.on("data", (chunk) => { stderr += String(chunk); });
    await waitFor(() => /agent:status .* active/.test(stderr), "standalone Pi readiness", 30_000);
    fs.appendFileSync(eventFile, `${JSON.stringify({ chat_id: "oc_fake_local", chat_type: "p2p", sender_id: "ou_fake_local",
      message_id: "om_pi_rpc_live", event_id: "evt_pi_rpc_live", content: `Use the Agent CLI to reply exactly ${MARKER}.`,
      create_time: String(Date.now()), thread_id: null, _mentioned_bot: true, _mention_all: false, _sender_is_bot: false })}\n`);
    await waitFor(() => fs.existsSync(trace) && fs.readFileSync(trace, "utf8").includes(MARKER), "fake IM reply");
    const stateRoot = path.join(larkinHome, "state", "agents", agentId);
    const status = JSON.parse(fs.readFileSync(path.join(stateRoot, "status.json"), "utf8"));
    assert.equal(status.session.runtime, "pi");
    assert.equal(status.session.model, MODEL);
    assert.ok(status.session.id);
    const sessionDir = path.join(stateRoot, "runtime", "pi-sessions");
    const sessionFile = fs.readdirSync(sessionDir).map((name) => path.join(sessionDir, name)).find((file) => fs.readFileSync(file, "utf8").includes(`\"id\":\"${status.session.id}\"`));
    assert.ok(sessionFile, "canonical Pi session JSONL must persist the exact sessionId");
    const rows = fs.readFileSync(sessionFile, "utf8").trim().split("\n").map(JSON.parse);
    const assistants = rows.filter((row) => row.message?.role === "assistant");
    assert.ok(assistants.some((row) => Number(row.message?.usage?.totalTokens || row.message?.usage?.input || 0) > 0), "real turn must persist token usage");
    assert.equal(fs.statSync(path.join(stateRoot, "runtime", "pi-standing-prompt.md")).mode & 0o777, 0o600);
  } finally {
    if (service) await stop(service);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}, 240_000);
