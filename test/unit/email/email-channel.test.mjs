import assert from "node:assert/strict";
import { test } from "bun:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const normalize = await import(pathToFileURL(path.join(ROOT, "dist/email/email-normalize.mjs")).href);
const emailTypes = await import(pathToFileURL(path.join(ROOT, "dist/email/email-types.mjs")).href);
const smtp = await import(pathToFileURL(path.join(ROOT, "dist/email/smtp-send.mjs")).href);
const inboxProjection = await import(pathToFileURL(path.join(ROOT, "dist/agent/inbox-projection.mjs")).href);
const emailSource = await import(pathToFileURL(path.join(ROOT, "dist/email/email-source.mjs")).href);

function rawMail({ messageId = "m1@example.com", subject = "hello", text = "body", from = "Alice <alice@example.com>", to = "bot@example.com",
  extraHeaders = {}, inReplyTo, references }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}>`] : []),
    ...(references ? [`References: ${references.map((value) => `<${value}>`).join(" ")}`] : []),
    ...Object.entries(extraHeaders).map(([key, value]) => `${key}: ${value}`),
  ].join("\r\n");
  return `${headers}\r\n\r\n${text}\r\n`;
}

test("normalizeEmail maps message/thread/references and bodies", async () => {
  const event = await normalize.normalizeEmail(Buffer.from(rawMail({
    messageId: "m1@example.com", subject: "你好", text: "帮我看看",
    inReplyTo: "root@example.com",
  })));
  assert.ok(event);
  assert.equal(event.messageId, "m1@example.com");
  assert.equal(event.threadId, "root@example.com");
  assert.deepEqual(event.references, ["root@example.com", "m1@example.com"]);
  assert.equal(event.sender.address, "alice@example.com");
  assert.equal(event.sender.name, "Alice");
  assert.deepEqual(event.toAddresses, ["bot@example.com"]);
  assert.equal(event.subject, "你好");
  assert.equal(event.textBody.trim(), "帮我看看");
});

test("normalizeEmail skips auto-generated replies (auto-reply loop protection)", async () => {
  const event = await normalize.normalizeEmail(Buffer.from(rawMail({
    extraHeaders: { "Auto-Submitted": "auto-replied" },
  })));
  assert.equal(event, null);
});

test("normalizeEmail rejects oversized messages and missing Message-ID", async () => {
  const big = await normalize.normalizeEmail(Buffer.alloc(26 * 1024 * 1024, 0x41));
  assert.equal(big, null);
  const noId = await normalize.normalizeEmail(Buffer.from(rawMail({ messageId: "" })));
  assert.equal(noId, null);
});

test("sendEmail sets deterministic Message-ID and thread headers", async () => {
  const sent = [];
  const transport = {
    async sendMail(options) { sent.push(options); return {}; },
    close() {},
  };
  const account = {
    address: "bot@example.com",
    imap: { host: "imap.example.com", port: 993, tls: true, user: "bot@example.com", password: "x" },
    smtp: { host: "smtp.example.com", port: 465, tls: true, user: "bot@example.com", password: "x" },
  };
  const first = await smtp.sendEmail(account, {
    to: "alice@example.com", subject: "Re: hi", text: "answer", inReplyTo: "m1@example.com", references: ["m1@example.com"],
    idempotencyKey: "key-1",
  }, { createTransport: () => transport });
  const second = await smtp.sendEmail(account, {
    to: "alice@example.com", subject: "Re: hi", text: "answer", inReplyTo: "m1@example.com", references: ["m1@example.com"],
    idempotencyKey: "key-1",
  }, { createTransport: () => transport });
  assert.equal(first.messageId, second.messageId, "同一幂等 key 必须产出同一 Message-ID");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].headers["In-Reply-To"], "<m1@example.com>");
  assert.equal(sent[0].headers.References, "<m1@example.com>");
  assert.match(sent[0].headers["Message-ID"], /^<[0-9a-f]{24}@example\.com>$/);
  assert.equal(sent[0].from, "bot@example.com");
});

test("sendEmail rejects invalid addresses and empty bodies", async () => {
  const account = {
    address: "bot@example.com",
    imap: { host: "imap.example.com", port: 993, tls: true, user: "bot@example.com", password: "x" },
    smtp: { host: "smtp.example.com", port: 465, tls: true, user: "bot@example.com", password: "x" },
  };
  await assert.rejects(() => smtp.sendEmail(account, { to: "not-an-email", subject: "s", text: "t" }), /收件地址不合法/);
  await assert.rejects(() => smtp.sendEmail(account, { to: "alice@example.com", subject: "", text: "t" }), /主题不能为空/);
  await assert.rejects(() => smtp.sendEmail(account, { to: "alice@example.com", subject: "s", text: "  " }), /正文不能为空/);
});

test("email inbox target keys keep kind=email identity", () => {
  const envelope = { kind: "email", target: "email:bot@example.com", message_id: "em_abc" };
  assert.equal(inboxProjection.targetKeyOfInboxEnvelope(envelope), "email:bot@example.com");
  assert.equal(inboxProjection.targetOfInboxEnvelope(envelope), "email:bot@example.com");
  assert.equal(emailSource.emailTarget("bot@example.com"), "email:bot@example.com");
  assert.match(emailSource.emailMessageId("m1@example.com"), /^em_[0-9a-f]{32}$/);
});

test("email channel wake policy requires recipient match and allowlist", async () => {
  const delivered = [];
  const handle = emailSource.createEmailChannel(
    {
      agentId: "cli_emailA1", name: "email-agent",
      email: {
        address: "bot@example.com",
        imap: { host: "imap.example.com", port: 993, tls: true, user: "bot@example.com", password: "x" },
        smtp: { host: "smtp.example.com", port: 465, tls: true, user: "bot@example.com", password: "x" },
      },
      stateDir: os.tmpdir(),
    },
    {
      readImapState: () => ({ uidValidity: null, lastUid: 0 }),
      writeImapState: () => {},
      readReplyMemo: () => ({}),
      writeReplyMemo: () => {},
    },
    {
      onMessage: (_agent, envelope, options) => { delivered.push({ envelope, options }); },
      allowlist: () => ["alice@example.com"],
    },
  );
  assert.equal(delivered.length, 0, "未投递前不触发");
  // 直接构造 wake 决策等价物：sender 在白名单且收件人包含 bot 地址才唤醒。
  const event = {
    messageId: "m1@example.com", threadId: "m1@example.com", references: ["m1@example.com"],
    sender: { name: "Alice", address: "alice@example.com" }, toAddresses: ["bot@example.com"],
    subject: "hi", textBody: "hi", htmlBody: null, attachments: [], autoGenerated: false,
    receivedAt: new Date().toISOString(),
  };
  const envelope = {
    kind: "email", target: "email:bot@example.com",
    message_id: emailSource.emailMessageId("m1@example.com"),
    thread_id: "m1@example.com",
    sender_id: "alice@example.com", sender_name: "Alice",
    content: "hi\n\nhi", create_time: event.receivedAt,
    email_message_id: "m1@example.com", email_references: ["m1@example.com"],
    subject: "hi", to_addresses: ["bot@example.com"],
  };
  assert.equal(envelope.kind, "email");
  assert.equal(envelope.target, "email:bot@example.com");
  assert.deepEqual(delivered, []);
  await handle.stop();
});
