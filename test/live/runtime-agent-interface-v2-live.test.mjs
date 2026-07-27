import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUN = process.env.LARKIN_RUN_RUNTIME_AGENT_INTERFACE_V2_LIVE === "1";
const WRITE = RUN && process.env.LARKIN_LIVE_ALLOW_WRITE === "1";
const IDAN_PROFILE = process.env.LARKIN_LIVE_IDAN_PROFILE || "";
const NATIVE_CLI = process.env.LARKIN_LIVE_NATIVE_LARK_CLI || "lark-cli";

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

function idan(args, timeout) {
  assert.match(IDAN_PROFILE, /^cli_[A-Za-z0-9]+$/, "LARKIN_LIVE_IDAN_PROFILE must resolve the authorized idan user profile");
  return run(NATIVE_CLI, ["--profile", IDAN_PROFILE, ...args], process.env, timeout);
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
  assert.equal(process.env.LARKIN_LIVE_TARGET_IS_DEDICATED, "1",
    "write harness requires LARKIN_LIVE_TARGET_IS_DEDICATED=1");
  assert.match(configDir || "", /^\//, "LARKIN_LIVE_CONFIG_DIR must be an absolute path");
  assert.match(agentId || "", /^cli_[A-Za-z0-9]+$/, "LARKIN_LIVE_AGENT_ID must be an exact Agent App ID");
  assert.match(chatId || "", /^oc_[A-Za-z0-9]+$/, "LARKIN_LIVE_CHAT_ID must be an exact dedicated chat ID");
  const runtimeBin = path.join(configDir, "state", "agents", agentId, "runtime-bin");
  const larkin = path.join(runtimeBin, "larkin");
  const larkCli = path.join(runtimeBin, "lark-cli");
  assert.equal(fs.statSync(larkin).isFile(), true, "running Runtime larkin shim is missing");
  assert.equal(fs.statSync(larkCli).isFile(), true, "running Runtime lark-cli shim is missing");
  return { configDir, agentId, chatId, larkin, larkCli };
}

test.skipIf(!RUN)("idan read-only identity and IM list capability are available", { timeout: 60_000 }, () => {
  const payload = parseJson(idan(["im", "+chat-list", "--as", "user", "--json"], 60_000), "idan read-only chat list");
  assert.equal(payload.ok, true);
  assert.equal(payload.identity, "user");
  assert.ok(Array.isArray(payload.data?.items) || Array.isArray(payload.data?.chats) || Array.isArray(payload.data));
});

test.skipIf(!WRITE)("dedicated Feishu chat holds a stale Bot send, then polls and sends exactly once", { timeout: 180_000 }, async () => {
  const { configDir, agentId, chatId, larkin, larkCli } = requireWriteEnvironment();
  const runtimeEnv = { ...process.env, LARKIN_CONFIG_DIR: configDir, LARKIN_AGENT_ID: agentId };
  const nonce = crypto.randomUUID();
  const updateMarker = `[larkin-runtime-interface-v2:${nonce}:update]`;
  const staleMarker = `[larkin-runtime-interface-v2:${nonce}:stale-must-not-send]`;
  const currentMarker = `[larkin-runtime-interface-v2:${nonce}:current]`;
  const target = `chat:${chatId}`;
  const history = () => parseJson(idan([
    "im", "+chat-messages-list", "--chat-id", chatId, "--page-size", "50", "--as", "user", "--json",
  ], 60_000), "idan read-only message history");
  const markerCount = (payload, marker) => JSON.stringify(payload).split(marker).length - 1;

  checked(idan([
    "im", "+messages-send", "--chat-id", chatId, "--text", updateMarker, "--as", "user",
    "--idempotency-key", `larkin-live-update-${nonce}`,
  ], 60_000), "idan controlled update send");

  await waitFor(
    () => parseJson(run(larkin, ["inbox", "check", "--target", target], runtimeEnv), "Runtime inbox check"),
    (payload) => payload.targets?.some((row) => row.target === target && row.pending_count > 0),
    "Runtime callback ingestion",
  );

  const held = parseJson(run(larkCli, [
    "im", "+messages-send", "--chat-id", chatId, "--text", staleMarker,
  ], runtimeEnv, 60_000), "Runtime stale Bot send");
  assert.equal(held.status, "held");
  assert.equal(held.target, target);
  assert.match(held.draft_id || "", /^draft_/);
  assert.equal(markerCount(history(), staleMarker), 0, "held content must not reach Feishu");

  const polled = parseJson(run(larkin, ["inbox", "poll", "--target", target], runtimeEnv), "Runtime target poll");
  assert.equal(polled.delivery, "direct_ack");
  assert.equal(polled.at_most_once, true);
  assert.ok(polled.events.some((event) => String(event.content || "").includes(updateMarker)));

  checked(run(larkCli, [
    "im", "+messages-send", "--chat-id", chatId, "--text", currentMarker,
  ], runtimeEnv, 60_000), "Runtime current Bot send");
  const finalHistory = await waitFor(history, (payload) => markerCount(payload, currentMarker) === 1, "current Bot marker delivery");
  assert.equal(markerCount(finalHistory, staleMarker), 0);
  assert.equal(markerCount(finalHistory, currentMarker), 1);
});
