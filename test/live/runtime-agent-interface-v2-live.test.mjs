import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUN = process.env.LARKIN_RUN_RUNTIME_AGENT_INTERFACE_V2_LIVE === "1";
const WRITE = RUN && process.env.LARKIN_LIVE_ALLOW_WRITE === "1";

function run(command, args, env = process.env, timeout = 30_000) {
  return spawnSync(command, args, { cwd: ROOT, env, encoding: "utf8", timeout });
}

function checked(result, label) {
  assert.equal(result.error, undefined, `${label}: process could not start`);
  assert.equal(result.status, 0, `${label}: exit ${result.status}`);
  return result;
}

function parseJson(result, label) {
  try { return JSON.parse(checked(result, label).stdout); }
  catch { throw new Error(`${label}: response was not JSON`); }
}

async function waitFor(read, predicate, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label}: timed out`);
}

function requireWriteEnvironment() {
  const configDir = process.env.LARKIN_LIVE_CONFIG_DIR;
  const agentId = process.env.LARKIN_LIVE_AGENT_ID;
  const chatId = process.env.LARKIN_LIVE_CHAT_ID;
  const manualMarker = process.env.LARKIN_LIVE_MANUAL_TRIGGER_MARKER || "";
  assert.equal(process.env.LARKIN_LIVE_TARGET_IS_DEDICATED, "1",
    "write harness requires LARKIN_LIVE_TARGET_IS_DEDICATED=1");
  assert.match(configDir || "", /^\//, "LARKIN_LIVE_CONFIG_DIR must be an absolute path");
  assert.match(agentId || "", /^cli_[A-Za-z0-9]+$/, "LARKIN_LIVE_AGENT_ID must be an exact Agent App ID");
  assert.match(chatId || "", /^oc_[A-Za-z0-9]+$/, "LARKIN_LIVE_CHAT_ID must be an exact dedicated chat ID");
  const markerMatch = /^\[larkin-runtime-interface-v2:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):manual-update\]$/.exec(manualMarker);
  assert.ok(markerMatch, "LARKIN_LIVE_MANUAL_TRIGGER_MARKER must be the exact generated manual marker");
  const runtimeBin = path.join(configDir, "state", "agents", agentId, "runtime-bin");
  const larkin = path.join(runtimeBin, "larkin");
  const larkCli = path.join(runtimeBin, "lark-cli");
  assert.equal(fs.statSync(larkin).isFile(), true, "running Runtime larkin shim is missing");
  assert.equal(fs.statSync(larkCli).isFile(), true, "running Runtime lark-cli shim is missing");
  return { configDir, agentId, chatId, manualMarker, nonce: markerMatch[1], larkin, larkCli };
}

test.skipIf(!WRITE)("manually triggered dedicated Feishu chat holds a stale Bot send, then polls and sends exactly once", { timeout: 180_000 }, async () => {
  const { configDir, agentId, chatId, manualMarker, nonce, larkin, larkCli } = requireWriteEnvironment();
  const runtimeEnv = { ...process.env, LARKIN_CONFIG_DIR: configDir, LARKIN_AGENT_ID: agentId };
  const staleMarker = `[larkin-runtime-interface-v2:${nonce}:stale-must-not-send]`;
  const currentMarker = `[larkin-runtime-interface-v2:${nonce}:current]`;
  const target = `chat:${chatId}`;
  const history = () => parseJson(run(larkCli, [
    "im", "+chat-messages-list", "--chat-id", chatId, "--page-size", "50", "--json",
  ], runtimeEnv, 60_000), "Runtime Bot read-only message history");
  const markerCount = (payload, marker) => JSON.stringify(payload).split(marker).length - 1;

  await waitFor(
    () => parseJson(run(larkin, ["inbox", "check", "--target", target], runtimeEnv), "Runtime inbox check"),
    (payload) => payload.targets?.some((row) => row.target === target && row.pending_count > 0),
    "manually triggered Runtime callback ingestion",
  );

  const held = parseJson(run(larkCli, [
    "im", "+messages-send", "--chat-id", chatId, "--text", staleMarker,
  ], runtimeEnv, 60_000), "Runtime stale Bot send");
  assert.equal(held.status, "held");
  assert.equal(held.target, target);
  assert.match(held.draft_id || "", /^draft_/);
  assert.equal(markerCount(history(), staleMarker), 0, "held content must not reach Feishu");

  const polled = await waitFor(
    () => parseJson(run(larkin, ["inbox", "poll", "--target", target], runtimeEnv), "Runtime target poll"),
    (payload) => payload.events?.some((event) => String(event.content || "").trim() === manualMarker),
    "exact manual marker poll",
  );
  assert.equal(polled.delivery, "direct_ack");
  assert.equal(polled.at_most_once, true);
  assert.ok(polled.events.some((event) => String(event.content || "").trim() === manualMarker));

  checked(run(larkCli, [
    "im", "+messages-send", "--chat-id", chatId, "--text", currentMarker,
  ], runtimeEnv, 60_000), "Runtime current Bot send");
  const finalHistory = await waitFor(history, (payload) => markerCount(payload, currentMarker) === 1, "current Bot marker delivery");
  assert.equal(markerCount(finalHistory, staleMarker), 0);
  assert.equal(markerCount(finalHistory, currentMarker), 1);
});
