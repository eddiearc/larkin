import assert from "node:assert/strict";
import { test } from "bun:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const imapSource = await import(pathToFileURL(path.join(ROOT, "dist/email/imap-source.mjs")).href);

function rawMail(messageId, subject, text) {
  return [
    "From: Alice <alice@example.com>",
    "To: bot@example.com",
    `Subject: ${subject}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    "",
  ].join("\r\n");
}

function fakeClient({ messages }) {
  const listeners = new Map();
  const client = {
    usable: false,
    connected: false,
    async connect() { this.connected = true; this.usable = true; },
    async mailboxOpen() { return { uidValidity: "777", uidNext: messages.length + 1 }; },
    async getMailboxLock() {
      return { release() {}, mailbox: { uidValidity: "777", uidNext: messages.length + 1 } };
    },
    async *fetch(range, query, options) {
      const match = /^(\d+):/.exec(String(range));
      const fromUid = match ? Number(match[1]) : 1;
      for (let uid = fromUid; uid <= messages.length; uid += 1) {
        yield { uid, source: Buffer.from(messages[uid - 1]) };
      }
    },
    on(event, listener) { listeners.set(event, listener); },
    removeAllListeners(event) { listeners.delete(event); },
    emit(event, data) { listeners.get(event)?.(data); },
    async logout() { this.usable = false; },
  };
  return client;
}

test("imap source delivers new messages and persists UID progress", async () => {
  const delivered = [];
  let state = { uidValidity: null, lastUid: 0 };
  const client = fakeClient({ messages: [rawMail("m1@example.com", "s1", "body1"), rawMail("m2@example.com", "s2", "body2")] });
  const source = imapSource.createImapSource({
    account: {
      address: "bot@example.com",
      imap: { host: "imap.example.com", port: 993, tls: true, user: "bot@example.com", password: "x" },
      smtp: { host: "smtp.example.com", port: 465, tls: true, user: "bot@example.com", password: "x" },
    },
    store: { read: () => state, write: (value) => { state = value; } },
    onMessage: (event) => { delivered.push(event); },
    idlePollFallbackMs: 60_000,
    createClient: () => client,
  });
  await source.start();
  assert.equal(delivered.length, 2, "start 的初次循环即拉取新信");
  assert.equal(delivered[0].messageId, "m1@example.com");
  assert.equal(delivered[1].messageId, "m2@example.com");
  assert.deepEqual(state, { uidValidity: "777", lastUid: 2 });
  // 再轮询不重复投递
  const again = await source.pollOnce();
  assert.equal(again, 0);
  assert.equal(delivered.length, 2);
  await source.stop();
});

test("imap source resets UID on UIDVALIDITY change", async () => {
  const delivered = [];
  let state = { uidValidity: "old", lastUid: 5 };
  const client = fakeClient({ messages: [rawMail("m9@example.com", "s9", "b9")] });
  const source = imapSource.createImapSource({
    account: {
      address: "bot@example.com",
      imap: { host: "imap.example.com", port: 993, tls: true, user: "bot@example.com", password: "x" },
      smtp: { host: "smtp.example.com", port: 465, tls: true, user: "bot@example.com", password: "x" },
    },
    store: { read: () => state, write: (value) => { state = value; } },
    onMessage: (event) => { delivered.push(event); },
    idlePollFallbackMs: 60_000,
    createClient: () => client,
  });
  await source.start();
  assert.equal(delivered.length, 1, "start 的初次循环在 UIDVALIDITY 重置后拉取新信");
  assert.equal(delivered[0].messageId, "m9@example.com");
  assert.equal(state.uidValidity, "777");
  assert.equal(state.lastUid, 1);
  await source.stop();
});

test("imap source keeps running on initial connect failure and polls later", async () => {
  const delivered = [];
  let failConnect = true;
  const client = fakeClient({ messages: [rawMail("m3@example.com", "s3", "b3")] });
  const originalConnect = client.connect.bind(client);
  client.connect = async () => {
    if (failConnect) throw new Error("connection refused");
    return originalConnect();
  };
  const errors = [];
  const source = imapSource.createImapSource({
    account: {
      address: "bot@example.com",
      imap: { host: "imap.example.com", port: 993, tls: true, user: "bot@example.com", password: "x" },
      smtp: { host: "smtp.example.com", port: 465, tls: true, user: "bot@example.com", password: "x" },
    },
    store: {
      read: () => ({ uidValidity: null, lastUid: 0 }),
      write: () => {},
    },
    onMessage: (event) => { delivered.push(event); },
    onError: (error) => { errors.push(error); },
    idlePollFallbackMs: 60_000,
    createClient: () => client,
  });
  await source.start();
  assert.equal(errors.length, 1, "初始连接失败应上报一次错误而非崩溃");
  failConnect = false;
  const count = await source.pollOnce();
  assert.equal(count, 1);
  assert.equal(delivered[0].messageId, "m3@example.com");
  await source.stop();
});
