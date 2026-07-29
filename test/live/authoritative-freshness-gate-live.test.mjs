import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";

const RUN = process.env.LARKIN_RUN_AUTHORITATIVE_FRESHNESS_LIVE === "1";
const WRITE = RUN && process.env.LARKIN_LIVE_ALLOW_WRITE === "1"
  && process.env.LARKIN_LIVE_TARGET_IS_DEDICATED === "1";

function commandTemplate(name) {
  const value = JSON.parse(process.env[name] || "null");
  assert.ok(Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string"),
    `${name} must be an authorized command argv JSON array`);
  return value;
}

function substitute(command, values) {
  return command.map((part) => Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value), part,
  ));
}

function run(command, argv, env = process.env) {
  return spawnSync(command, argv, { encoding: "utf8", timeout: 60_000, env });
}

function checked(result, label) {
  assert.equal(result.status, 0, `${label} failed (exit=${result.status}; stdout-bytes=${result.stdout?.length || 0}; stderr-bytes=${result.stderr?.length || 0})`);
  return result;
}

function json(result, label) {
  const completed = checked(result, label);
  try { return JSON.parse(completed.stdout); } catch { throw new Error(`${label} did not return JSON`); }
}

async function waitFor(read, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out`);
}

function messages(payload) {
  const rows = payload?.data?.messages ?? payload?.data?.items;
  assert.ok(Array.isArray(rows), "observer history payload must contain data.messages/items");
  return rows;
}

function markerCount(payload, marker) {
  return JSON.stringify(messages(payload)).split(marker).length - 1;
}

function fixture() {
  const configDir = process.env.LARKIN_LIVE_CONFIG_DIR || "";
  const agentId = process.env.LARKIN_LIVE_AGENT_ID || "";
  const chatId = process.env.LARKIN_LIVE_CHAT_ID || "";
  assert.match(configDir, /^\//);
  assert.match(agentId, /^cli_[A-Za-z0-9]+$/);
  assert.match(chatId, /^oc_[A-Za-z0-9]+$/);
  const runtimeEnv = { ...process.env, LARKIN_CONFIG_DIR: configDir, LARKIN_AGENT_ID: agentId };
  const larkin = process.env.LARKIN_LIVE_LARKIN_PATH || "";
  const expectedLarkinHash = process.env.LARKIN_LIVE_EXPECTED_LARKIN_SHA256 || "";
  assert.match(larkin, /^\//, "explicit current-worktree larkin path is required");
  assert.match(expectedLarkinHash, /^[0-9a-f]{64}$/, "explicit tested larkin SHA-256 is required");
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(larkin)).digest("hex"), expectedLarkinHash,
    "live harness must execute the explicitly hashed current-worktree Agent CLI");
  return {
    configDir, agentId, chatId, runtimeEnv,
    larkin,
    otherBot: commandTemplate("LARKIN_LIVE_OTHER_BOT_COMMAND_JSON"),
    observer: commandTemplate("LARKIN_LIVE_OBSERVER_HISTORY_COMMAND_JSON"),
  };
}

function external(command, values, label) {
  const rendered = substitute(command, values);
  return checked(run(rendered[0], rendered.slice(1)), label);
}

test.skipIf(!WRITE)("dedicated group proves Inbox absence, authoritative conflict, no stale write, and one revised write", { timeout: 240_000 }, async () => {
  const f = fixture();
  const nonce = crypto.randomUUID();
  const updateMarker = `[larkin-authoritative-live:${nonce}:other-bot]`;
  const staleMarker = `[larkin-authoritative-live:${nonce}:stale-must-not-send]`;
  const revisedMarker = `[larkin-authoritative-live:${nonce}:revised]`;
  const target = `chat:${f.chatId}`;
  checked(run(f.larkin, ["inbox", "poll", "--target", target], f.runtimeEnv), "pre-drain exact chat Inbox");
  external(f.otherBot, { chat_id: f.chatId, text: updateMarker }, "different Bot controlled group update");
  const history = () => json(external(f.observer, { chat_id: f.chatId, text: "" }, "observer group history"), "observer group history");
  await waitFor(history, (payload) => markerCount(payload, updateMarker) === 1, "different Bot marker in provider history");
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const check = json(run(f.larkin, ["inbox", "check", "--target", target], f.runtimeEnv), "exact chat Inbox absence check");
  assert.equal(check.pending_total, 0, "different Bot marker must be absent from this Agent Inbox");

  const stale = run(f.larkin, ["im", "+messages-send", "--chat-id", f.chatId, "--text", staleMarker], f.runtimeEnv);
  assert.notEqual(stale.status, 0);
  const conflict = JSON.parse(stale.stderr);
  assert.equal(conflict.error.subtype, "freshness_conflict");
  assert.equal(conflict.target, `feishu.im/chat/${f.chatId}`);
  assert.equal(JSON.stringify(conflict.unseen_messages).includes(updateMarker), true);
  assert.equal(markerCount(history(), staleMarker), 0, "conflicting stale body must not reach Feishu");

  checked(run(f.larkin, ["im", "+messages-send", "--chat-id", f.chatId, "--text", revisedMarker], f.runtimeEnv), "revised group send");
  const finalHistory = await waitFor(history, (payload) => markerCount(payload, revisedMarker) === 1, "one revised group marker");
  assert.equal(markerCount(finalHistory, staleMarker), 0);
  assert.equal(markerCount(finalHistory, revisedMarker), 1);
});

test.skipIf(!WRITE || !process.env.LARKIN_LIVE_THREAD_MESSAGE_ID || !process.env.LARKIN_LIVE_THREAD_ID
  || !process.env.LARKIN_LIVE_ISOLATION_THREAD_MESSAGE_ID || !process.env.LARKIN_LIVE_ISOLATION_THREAD_ID)(
  "dedicated threads prove Inbox absence, exact target conflict, target isolation, no stale reply, and one revised reply",
  { timeout: 240_000 }, async () => {
    const f = fixture();
    const messageId = process.env.LARKIN_LIVE_THREAD_MESSAGE_ID || "";
    const threadId = process.env.LARKIN_LIVE_THREAD_ID || "";
    const isolationMessageId = process.env.LARKIN_LIVE_ISOLATION_THREAD_MESSAGE_ID || "";
    const isolationThreadId = process.env.LARKIN_LIVE_ISOLATION_THREAD_ID || "";
    assert.match(messageId, /^om_[A-Za-z0-9]+$/);
    assert.match(threadId, /^(?:om|omt)_[A-Za-z0-9]+$/);
    assert.match(isolationMessageId, /^om_[A-Za-z0-9]+$/);
    assert.match(isolationThreadId, /^(?:om|omt)_[A-Za-z0-9]+$/);
    assert.notEqual(isolationThreadId, threadId);
    const otherBotThread = commandTemplate("LARKIN_LIVE_OTHER_BOT_THREAD_COMMAND_JSON");
    const observerThread = commandTemplate("LARKIN_LIVE_OBSERVER_THREAD_HISTORY_COMMAND_JSON");
    assert.equal(["{chat_id}", "{thread_id}", "{message_id}", "{text}"].every((placeholder) => JSON.stringify(otherBotThread).includes(placeholder)), true,
      "controlled other-Bot thread update must bind the exact known root/thread and marker");
    assert.equal(["{chat_id}", "{thread_id}", "{message_id}"].every((placeholder) => JSON.stringify(observerThread).includes(placeholder)), true,
      "observer thread history must bind the same exact target");
    const nonce = crypto.randomUUID();
    const updateMarker = `[larkin-authoritative-thread:${nonce}:other-bot]`;
    const staleMarker = `[larkin-authoritative-thread:${nonce}:stale-must-not-send]`;
    const revisedMarker = `[larkin-authoritative-thread:${nonce}:revised]`;
    const isolationMarker = `[larkin-authoritative-thread:${nonce}:isolated-thread]`;
    const target = `thread:${f.chatId}:${threadId}`;
    checked(run(f.larkin, ["inbox", "poll", "--target", target], f.runtimeEnv), "pre-drain exact thread Inbox");
    external(otherBotThread, { chat_id: f.chatId, thread_id: threadId, message_id: messageId, text: updateMarker }, "different Bot controlled thread update");
    const history = () => json(external(observerThread,
      { chat_id: f.chatId, thread_id: threadId, message_id: messageId, text: "" }, "observer exact thread history"), "observer exact thread history");
    await waitFor(history, (payload) => markerCount(payload, updateMarker) === 1, "different Bot marker in exact thread history");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const check = json(run(f.larkin, ["inbox", "check", "--target", target], f.runtimeEnv), "exact thread Inbox absence check");
    assert.equal(check.pending_total, 0, "different Bot thread marker must be absent from this Agent Inbox");

    const stale = run(f.larkin, ["im", "+messages-reply", "--message-id", messageId, "--reply-in-thread", "--text", staleMarker], f.runtimeEnv);
    assert.notEqual(stale.status, 0);
    const conflict = JSON.parse(stale.stderr);
    assert.equal(conflict.error.subtype, "freshness_conflict");
    assert.equal(conflict.target, `feishu.im/thread/${f.chatId}/${threadId}`);
    assert.equal(JSON.stringify(conflict.unseen_messages).includes(updateMarker), true);
    assert.equal(markerCount(history(), staleMarker), 0, "conflicting stale thread body must not reach Feishu");

    checked(run(f.larkin, ["im", "+threads-messages-list", "--thread", isolationThreadId, "--order", "desc", "--json"], f.runtimeEnv),
      "observe isolation thread head");
    checked(run(f.larkin, ["im", "+messages-reply", "--message-id", isolationMessageId, "--reply-in-thread", "--text", isolationMarker], f.runtimeEnv),
      "write to independently current isolation thread");
    const isolationHistory = () => json(external(observerThread,
      { chat_id: f.chatId, thread_id: isolationThreadId, message_id: isolationMessageId, text: "" }, "observer isolation thread history"),
    "observer isolation thread history");
    const isolated = await waitFor(isolationHistory, (payload) => markerCount(payload, isolationMarker) === 1, "one isolated thread marker");
    assert.equal(markerCount(isolated, isolationMarker), 1, "conflict in one thread must not block another current thread");

    checked(run(f.larkin, ["im", "+messages-reply", "--message-id", messageId, "--reply-in-thread", "--text", revisedMarker], f.runtimeEnv), "revised thread reply");
    const finalHistory = await waitFor(history, (payload) => markerCount(payload, revisedMarker) === 1, "one revised thread marker");
    assert.equal(markerCount(finalHistory, staleMarker), 0);
    assert.equal(markerCount(finalHistory, revisedMarker), 1);
  },
);
