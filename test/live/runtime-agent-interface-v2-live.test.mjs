import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  redactedProcessFailureDiagnostic,
  redactedProcessOutputShape,
  runProviderWithLiveHoldReady,
  validateLiveHoldHostReady,
} from "../support/runtime-agent-interface-v2-live-hold-safety.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUN = process.env.LARKIN_RUN_RUNTIME_AGENT_INTERFACE_V2_LIVE === "1";
const WRITE = RUN && process.env.LARKIN_LIVE_ALLOW_WRITE === "1";
const NATIVE_CLI = process.env.LARKIN_LIVE_NATIVE_LARK_CLI || "lark-cli";
const EXPECTED_USER_NAME = process.env.LARKIN_LIVE_EXPECTED_USER_NAME || "";
const EXPECTED_USER_OPEN_ID = process.env.LARKIN_LIVE_EXPECTED_USER_OPEN_ID || "";

function run(command, args, env = process.env, timeout = 30_000) {
  return spawnSync(command, args, { cwd: ROOT, env, encoding: "utf8", timeout });
}

function checked(result, label) {
  if (result.error !== undefined) throw new Error(`${label}: process could not start`);
  if (result.status !== 0) {
    throw new Error(`${label}: exit ${result.status}; redacted failure=${JSON.stringify(redactedProcessFailureDiagnostic(result))}`);
  }
  return result;
}

function parseJson(result, label) {
  const completed = checked(result, label);
  try { return JSON.parse(completed.stdout); }
  catch {
    throw new Error(`${label}: response was not JSON; redacted output shape=${JSON.stringify(redactedProcessOutputShape(completed))}`);
  }
}

function externalUser(args, timeout) {
  return run(NATIVE_CLI, args, process.env, timeout);
}

function messageSendArgs(...args) {
  return ["im", "+messages-send", ...args, "--json"];
}

function requireExpectedUser() {
  assert.ok(EXPECTED_USER_NAME.trim(), "LARKIN_LIVE_EXPECTED_USER_NAME must identify the authorized default user");
  assert.match(EXPECTED_USER_OPEN_ID, /^ou_[A-Za-z0-9]+$/, "LARKIN_LIVE_EXPECTED_USER_OPEN_ID must identify the exact authorized default user");
  const status = parseJson(externalUser(["auth", "status", "--json"], 30_000), "default user auth status");
  assert.equal(status.identities?.user?.status, "ready");
  assert.equal(status.identities?.user?.userName, EXPECTED_USER_NAME);
  assert.equal(status.identities?.user?.openId, EXPECTED_USER_OPEN_ID);
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

test.skipIf(!RUN)("default external user identity and IM list capability are available", { timeout: 60_000 }, () => {
  requireExpectedUser();
  const payload = parseJson(externalUser(["im", "+chat-list", "--as", "user", "--json"], 60_000), "default user read-only chat list");
  assert.equal(payload.ok, true);
  assert.equal(payload.identity, "user");
  assert.ok(Array.isArray(payload.data?.items) || Array.isArray(payload.data?.chats) || Array.isArray(payload.data));
});

test.skipIf(!WRITE)("dedicated Feishu chat holds a stale Bot send, then polls and sends exactly once", { timeout: 180_000 }, async () => {
  requireExpectedUser();
  const { configDir, agentId, chatId, larkin, larkCli } = requireWriteEnvironment();
  const runtimeEnv = { ...process.env, LARKIN_CONFIG_DIR: configDir, LARKIN_AGENT_ID: agentId };
  const nonce = crypto.randomUUID();
  const updateMarker = `[larkin-runtime-interface-v2:${nonce}:update]`;
  const staleMarker = `[larkin-runtime-interface-v2:${nonce}:stale-must-not-send]`;
  const currentMarker = `[larkin-runtime-interface-v2:${nonce}:current]`;
  const target = `chat:${chatId}`;
  const history = () => {
    const payload = parseJson(externalUser([
      "im", "+chat-messages-list", "--chat-id", chatId, "--page-size", "50", "--as", "user", "--json",
    ], 60_000), "default user read-only message history");
    assert.equal(payload.ok, true, "default user message-history capability must succeed");
    assert.equal(payload.identity, "user", "message-history capability must use the authorized user");
    return payload;
  };
  const markerCount = (payload, marker) => JSON.stringify(payload).split(marker).length - 1;
  const provider = (stage, operation) => runProviderWithLiveHoldReady(
    configDir, agentId, operation, { stage },
  );

  // Fail before poll/drain or either external send when message-history scopes
  // are unavailable. This keeps an authorization failure at zero writes.
  history();
  validateLiveHoldHostReady(configDir, agentId);

  await waitFor(
    () => parseJson(run(larkin, ["inbox", "poll", "--target", target], runtimeEnv), "Runtime target pre-drain"),
    (payload) => Array.isArray(payload.events) && payload.events.length === 0,
    "empty dedicated target before controlled update",
  );
  const emptyCheck = parseJson(run(larkin, ["inbox", "check", "--target", target], runtimeEnv), "Runtime empty target check");
  assert.equal(emptyCheck.pending_total, 0);

  const update = parseJson(provider("controlled user send", () => externalUser(messageSendArgs(
    "--chat-id", chatId, "--text", updateMarker, "--as", "user",
    "--idempotency-key", `larkin-live-update-${nonce}`,
  ), 60_000)), "default user controlled update send");
  const updateMessageId = update.data?.message_id || update.data?.message?.message_id || update.message_id;
  assert.match(updateMessageId || "", /^om_[A-Za-z0-9]+$/, "controlled update must return its exact message ID");

  await waitFor(
    () => parseJson(run(larkin, ["inbox", "check", "--target", target], runtimeEnv), "Runtime inbox check"),
    (payload) => payload.targets?.some((row) => row.target === target && row.pending_count > 0
      && row.first_message_id === updateMessageId),
    "controlled Runtime callback ingestion",
  );

  const held = parseJson(provider("stale Runtime Bot send", () => run(larkCli, messageSendArgs(
    "--chat-id", chatId, "--text", staleMarker,
  ), runtimeEnv, 60_000)), "Runtime stale Bot send");
  assert.equal(held.status, "held");
  assert.equal(held.target, target);
  assert.match(held.draft_id || "", /^draft_/);
  assert.equal(markerCount(history(), staleMarker), 0, "held content must not reach Feishu");

  const polled = await waitFor(
    () => parseJson(run(larkin, ["inbox", "poll", "--target", target], runtimeEnv), "Runtime target poll"),
    (payload) => payload.events?.some((event) => String(event.content || "").trim() === updateMarker),
    "exact controlled marker poll",
  );
  assert.equal(polled.delivery, "direct_ack");
  assert.equal(polled.at_most_once, true);
  assert.ok(polled.events.some((event) => String(event.content || "").trim() === updateMarker));

  checked(provider("current Runtime Bot send", () => run(larkCli, messageSendArgs(
    "--chat-id", chatId, "--text", currentMarker,
  ), runtimeEnv, 60_000)), "Runtime current Bot send");
  const finalHistory = await waitFor(history, (payload) => markerCount(payload, currentMarker) === 1, "current Bot marker delivery");
  assert.equal(markerCount(finalHistory, staleMarker), 0);
  assert.equal(markerCount(finalHistory, currentMarker), 1);
});
