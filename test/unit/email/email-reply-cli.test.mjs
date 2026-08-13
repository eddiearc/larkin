import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const launcher = await import(pathToFileURL(path.join(ROOT, "dist/app/lark-cli.mjs")).href);
const stateModule = await import(pathToFileURL(path.join(ROOT, "dist/agent/agent-state-store.mjs")).href);

const BOT = "bot@example.com";
const EMAIL_CONFIG = {
  address: BOT,
  imap: { host: "imap.example.com", port: 993, tls: true, user: BOT, password: "x" },
  smtp: { host: "smtp.example.com", port: 465, tls: true, user: BOT, password: "x" },
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-email-reply-"));
  const agentId = "cli_emailA1";
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-email", mentionPolicy: "require", activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "default", email: EMAIL_CONFIG } },
  })}\n`, { mode: 0o600 });
  const stateDir = path.join(root, "state", "agents", agentId);
  const larkConfigDir = path.join(stateDir, "lark-cli-config");
  const sourceDir = path.join(stateDir, "lark-channel-source");
  const channelDir = path.join(larkConfigDir, "lark-channel");
  fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(channelDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sourceDir, "config.json"), JSON.stringify({
    accounts: { app: { id: agentId, secret: { source: "exec", provider: "larkin-bot-credential", id: agentId } } },
    secrets: { providers: { "larkin-bot-credential": { source: "exec", command: "/larkin/bot-credential", args: [],
      env: { LARKIN_AGENT_ID: agentId, LARKIN_SECRET_PROVIDER_CONTEXT: "bind" } } } },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(channelDir, "config.json"), JSON.stringify({
    apps: [{ appId: agentId, defaultAs: "bot", strictMode: "bot",
      appSecret: { source: "keychain", id: `appsecret:${agentId}` }, users: {} }],
  }), { mode: 0o600 });
  const store = stateModule.createAgentStateStore(root, agentId);
  const sent = [];
  const transport = { async sendMail(options) { sent.push(options); return {}; }, close() {} };
  const output = { stdout: "", stderr: "" };
  const io = { stdout(text) { output.stdout += text; }, stderr(text) { output.stderr += text; } };
  const agent = { agentId, name: agentId, email: EMAIL_CONFIG };
  const run = (argv) => launcher.runLarkCliProcess(argv, {
    LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId,
  }, {
    smtpTransportFactory: () => transport, io,
  });
  return { root, store, sent, transport, run, reset() { output.stdout = ""; output.stderr = ""; }, output };
}

function seedInbox(store, { messageId = "em_" + "a".repeat(32), emailMessageId = "m1@example.com", sender = "alice@example.com" } = {}) {
  store.appendNdjson("inbox", {
    kind: "email",
    target: `email:${BOT}`,
    message_id: messageId,
    thread_id: emailMessageId,
    sender_id: sender,
    sender_name: "Alice",
    content: "hi",
    create_time: "2026-08-14T00:00:00.000Z",
    email_message_id: emailMessageId,
    email_references: [emailMessageId],
    subject: "hello",
    to_addresses: [BOT],
    seq: 1,
  });
  // inbox state: 目标已 poll（model_seen == latest_received）
  fs.writeFileSync(path.join(store.paths.root, "inbox-state.json"), JSON.stringify({
    version: 2,
    targets: { [`email:${BOT}`]: { latest_received_seq: 1, model_seen_seq: 1 } },
    messages: { [messageId]: { target: `email:${BOT}`, seq: 1 } },
  }), { mode: 0o600 });
}

test("email reply sends once, threads the reply, and dedups identical retries", async () => {
  const f = fixture();
  try {
    const messageId = "em_" + "a".repeat(32);
    seedInbox(f.store, { messageId });
    const argv = ["email", "reply", "--message-id", messageId, "--text", "got it"];
    const first = await f.run(argv);
    assert.equal(first, 0, f.output.stderr);
    const firstJson = JSON.parse(f.output.stdout);
    assert.equal(firstJson.ok, true);
    assert.equal(firstJson.committed, true);
    assert.equal(firstJson.duplicate, false);
    assert.match(firstJson.email_message_id, /^[0-9a-f]{24}@example\.com$/);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].to, "alice@example.com");
    assert.equal(f.sent[0].subject, "Re: hello");
    assert.equal(f.sent[0].headers["In-Reply-To"], "<m1@example.com>");
    assert.equal(f.sent[0].headers.References, "<m1@example.com>");

    f.reset();
    const duplicate = await f.run(argv);
    assert.equal(duplicate, 0, f.output.stderr);
    const duplicateJson = JSON.parse(f.output.stdout);
    assert.equal(duplicateJson.duplicate, true);
    assert.equal(duplicateJson.email_message_id, firstJson.email_message_id);
    assert.equal(f.sent.length, 1, "同正文重试不得再次 SMTP 发送");

    f.reset();
    const changed = await f.run(["email", "reply", "--message-id", messageId, "--text", "different answer"]);
    assert.equal(changed, 2);
    assert.match(f.output.stderr, /不同正文/);
    assert.equal(f.sent.length, 1, "改正文必须被拒绝");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("email reply requires a polled email Inbox message and rejects cross-kind ids", async () => {
  const f = fixture();
  try {
    const unknown = await f.run(["email", "reply", "--message-id", "em_" + "b".repeat(32), "--text", "hi"]);
    assert.equal(unknown, 2);
    assert.match(f.output.stderr, /先 poll/);
    assert.equal(f.sent.length, 0);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("classify keeps email reply protected and everything else denied", () => {
  assert.equal(launcher.classifyLarkCliCommand(["email", "reply", "--message-id", "em_" + "c".repeat(32), "--text", "x"]).kind, "email-reply");
  assert.equal(launcher.classifyLarkCliCommand(["email", "send", "--to", "x@y.com"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["email", "--help"]).kind, "passthrough");
});
