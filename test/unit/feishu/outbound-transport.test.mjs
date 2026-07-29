import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { createOutboundTransport } = require(path.join(ROOT, "dist/feishu/outbound-transport.cjs"));

function fixture(temp, overrides = {}) {
  const calls = [], conversations = [], logs = [];
  const service = createOutboundTransport({
    attachmentDir: path.join(temp, "attachments"), attachmentIndexFile: path.join(temp, "attachments.json"),
    resolveChatId: (target) => target ? "oc_chat" : "",
    replyContextFor: (key) => key === "#room:topic123" ? { in_topic: true, reply_to: "om_anchor" } : null,
    sendText: (...args) => { calls.push(["send", ...args]); return { code: 0, stdout: '{"data":{"message_id":"om_text"}}', stderr: "" }; },
    replyText: (...args) => { calls.push(["reply", ...args]); return { code: 0, stdout: '{"data":{"message_id":"om_reply"}}', stderr: "" }; },
    sendMedia: (...args) => { calls.push(["media", ...args]); return { code: 0, stdout: '{"data":{"message_id":"om_media"}}', stderr: "" }; },
    appendConversation: (item) => conversations.push(item), botDisplayName: () => "Contract Bot",
    agentName: "cli_contract", dryRun: false, log: (...args) => logs.push(args), ...overrides,
  });
  return { service, calls, conversations, logs };
}

test("outbound transport stages deterministic safe attachment files", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-outbound-upload-"));
  try {
    const { service } = fixture(temp);
    const bytes = Buffer.from("attachment-body");
    const form = { get(name) { return name === "file" ? { name: "../报告 image.png", type: "image/png", arrayBuffer: async () => bytes } : null; } };
    const result = await service.stageUpload(form);
    const expectedId = `att_${crypto.createHash("sha256").update(bytes).update("../报告 image.png").digest("hex").slice(0, 20)}`;
    assert.equal(result.ok, true); assert.equal(result.data.id, expectedId); assert.equal(result.data.mimeType, "image/png");
    const index = JSON.parse(fs.readFileSync(path.join(temp, "attachments.json"), "utf8"));
    assert.equal(index[expectedId].file, `${expectedId}__.._image.png`);
    const stored = path.join(temp, "attachments", index[expectedId].file);
    assert.equal(fs.readFileSync(stored, "utf8"), "attachment-body");
    assert.equal(fs.statSync(path.join(temp, "attachments")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(temp, "attachments.json")).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(temp).filter((name) => name.includes(".tmp") || name.endsWith(".lock")), []);
    assert.equal((await service.stageUpload({ get() { return null; } })).status, 400);

    const outside = path.join(temp, "outside");
    fs.mkdirSync(outside);
    fs.rmSync(path.join(temp, "attachments"), { recursive: true });
    fs.symlinkSync(outside, path.join(temp, "attachments"), "dir");
    const rejected = await service.stageUpload(form);
    assert.equal(rejected.status, 500);
    assert.match(rejected.error, /不安全|symlink/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("topic send preserves text-before-attachments order and per-item idempotency keys", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-outbound-topic-"));
  try {
    const f = fixture(temp);
    const staged = await f.service.stageUpload({ get(name) { return name === "file" ? { name: "note.txt", type: "text/plain", arrayBuffer: async () => Buffer.from("note") } : null; } });
    f.calls.length = 0;
    const result = f.service.handleSend({ target: "#room:topic123", content: "hello\n\n", attachmentIds: [staged.data.id], idempotencyKey: "idem-fixed" });
    assert.deepEqual(f.calls.map((call) => call[0]), ["reply", "media"]);
    assert.deepEqual(f.calls[0].slice(1), ["om_anchor", "hello", "idem-fixed", "oc_chat"]);
    assert.equal(f.calls[1][1], "oc_chat"); assert.deepEqual(f.calls[1][2], { in_topic: true, reply_to: "om_anchor" }); assert.equal(f.calls[1][4], "idem-fixed:a0");
    assert.deepEqual(result, { ok: true, status: 200, data: { ok: true, state: "sent", messageId: "om_media", messageSeq: 1 } });
    assert.equal(f.conversations.length, 1); assert.equal(f.conversations[0].text, "hello"); assert.equal(f.conversations[0].from, "Contract Bot");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("plain, attachment-only, unknown-target, and failure behavior remains fail-closed", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-outbound-edges-"));
  try {
    const plain = fixture(temp);
    const expectedHash = crypto.createHash("sha256").update("#room\0plain").digest("hex").slice(0, 32);
    assert.equal(plain.service.handleSend({ target: "#room", content: "plain" }).ok, true);
    assert.deepEqual(plain.calls[0], ["send", "oc_chat", "plain", expectedHash]);
    const staged = await plain.service.stageUpload({ get(name) { return name === "file" ? { name: "only.bin", arrayBuffer: async () => Buffer.from("only") } : null; } });
    plain.calls.length = 0; plain.service.handleSend({ target: "#room", content: "", attachmentIds: [staged.data.id] });
    assert.deepEqual(plain.calls.map((call) => call[0]), ["media"]);
    const unknown = fixture(temp, { resolveChatId: () => "" });
    const missing = unknown.service.handleSend({ target: "#unknown", content: "no" });
    assert.equal(missing.status, 400); assert.match(missing.error, /不会兜底发往默认群/); assert.equal(unknown.calls.length, 0);
    const failed = fixture(temp, { sendText: () => ({ code: 1, stdout: "", stderr: "first error\nmore" }) });
    assert.deepEqual(failed.service.handleSend({ target: "#room", content: "fail" }), { ok: false, status: 502, error: "lark-cli send failed: first error" });
    assert.equal(failed.conversations.length, 0);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("production transport delegates send and multipart authority to authored TypeScript", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/agent/agent-transport.ts"), "utf8");
  const context = fs.readFileSync(path.join(ROOT, "src/agent/transport-business-context.ts"), "utf8");
  assert.match(source, /from ["']\.\/transport-business-context\.js["']/);
  assert.match(context, /from ["']\.\.\/feishu\/outbound-transport\.js["']/);
  assert.match(source, /return outbound\.handleSend\(body\)/); assert.match(source, /return outbound\.stageUpload\(form\)/);
  assert.doesNotMatch(source, /crypto\.createHash|function\s+stageUpload|function\s+loadAttachIdx/);
});

test("production transport preserves topic reply then attachment lark-cli side-effect order", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-outbound-production-"));
  try {
    const agentId = "cli_outboundA1";
    const stateDir = path.join(temp, "state", "agents", agentId);
    const binDir = path.join(temp, "bin");
    const packageDir = path.join(temp, "node_modules", "@larksuite", "cli");
    const official = path.join(packageDir, "scripts", "run.mjs");
    const loginShell = path.join(temp, "login-shell.sh");
    const sink = path.join(temp, "lark-calls.ndjson");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({
      version: 3, serverId: "server-outbound", activeAgent: agentId,
      agents: { [agentId]: { runtime: "codex", model: "gpt-contract" } },
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, "feishu-map.json"), JSON.stringify({ "#room:topic123": "oc_chat" }));
    fs.writeFileSync(path.join(stateDir, "feishu-replyctx.json"), JSON.stringify({ "#room:topic123": { chat_id: "oc_chat", reply_to: "om_anchor", thread_id: "omt_topic", in_topic: true } }));
    const larkConfigDir = path.join(stateDir, "lark-cli-config");
    const sourceDir = path.join(stateDir, "lark-channel-source");
    fs.mkdirSync(path.join(larkConfigDir, "lark-channel"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(sourceDir, "config.json"), JSON.stringify({ accounts: { app: { id: agentId,
      secret: { source: "exec", provider: "larkin-bot-credential", id: agentId } } }, secrets: { providers: {
      "larkin-bot-credential": { source: "exec", command: process.execPath, args: [], env: {
        LARKIN_AGENT_ID: agentId, LARKIN_SECRET_PROVIDER_CONTEXT: "bind",
      } },
    } } }), { mode: 0o600 });
    fs.writeFileSync(path.join(larkConfigDir, "lark-channel", "config.json"), JSON.stringify({ apps: [{ appId: agentId,
      appSecret: { source: "keychain", id: `appsecret:${agentId}` }, defaultAs: "bot", strictMode: "bot", users: [],
    }] }), { mode: 0o600 });
    fs.mkdirSync(path.dirname(official), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@larksuite/cli", version: "1.0.79", bin: { "lark-cli": "scripts/run.mjs" } }));
    fs.writeFileSync(official, `#!/usr/bin/env bun
const args=process.argv.slice(2);
if(args[0]==="--version") { process.stdout.write("1.0.79\\n"); process.exit(0); }
if(args[0]==="config"&&args[1]==="bind"&&args[2]==="--help") { process.stdout.write("--source lark-channel --identity bot-only\\n"); process.exit(0); }
require("node:fs").appendFileSync(process.env.LARK_CALL_SINK, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+"\\n");
process.stdout.write(JSON.stringify({data:{message_id:process.argv.includes("--image")?"om_image":"om_text"}}));
`, { mode: 0o755 });
    fs.symlinkSync(official, path.join(binDir, "lark-cli"));
    fs.writeFileSync(loginShell, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(official)}\n`, { mode: 0o755 });
    const script = `
const {transport}=require(${JSON.stringify(path.join(ROOT, "dist/agent/agent-transport.cjs"))});
(async()=>{
  const form=new FormData(); form.set("file",new File([Buffer.from("png")],"pic.png",{type:"image/png"}));
  const upload=await transport.requestMultipart("POST","/attachments/upload",form);
  const sent=await transport.request({method:"POST",path:"/messages/send",body:{target:"#room:topic123",content:"hello",attachmentIds:[upload.data.id],idempotencyKey:"fixed-idem"}});
  process.stdout.write("\\nRESULT="+JSON.stringify({upload,sent}));
})().catch(e=>{console.error(e);process.exit(1)});`;
    const result = spawnSync(process.execPath, ["--eval", script], {
      cwd: ROOT, encoding: "utf8",
      env: { ...process.env, SHELL: loginShell, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
        LARKIN_CONFIG_DIR: temp, LARKIN_AGENT_ID: agentId, LARK_CALL_SINK: sink },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const observed = JSON.parse(result.stdout.slice(result.stdout.indexOf("RESULT=") + 7));
    assert.equal(observed.upload.ok, true); assert.equal(observed.sent.data.messageId, "om_image");
    const calls = fs.readFileSync(sink, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 3, JSON.stringify(calls));
    assert.deepEqual(calls[0].args, ["im", "+chat-members-list", "--chat-id", "oc_chat", "--member-id-type", "user_id", "--json"]);
    assert.deepEqual(calls[1].args, ["im", "+messages-reply", "--message-id", "om_anchor", "--reply-in-thread", "--text", "hello", "--json", "--idempotency-key", "fixed-idem"]);
    assert.deepEqual(calls[2].args.slice(0, 7), ["im", "+messages-reply", "--message-id", "om_anchor", "--reply-in-thread", "--image", calls[2].args[6]]);
    assert.match(calls[2].args[6], /^att_[0-9a-f]{20}__pic\.png$/);
    assert.deepEqual(calls[2].args.slice(7), ["--json", "--idempotency-key", "fixed-idem:a0"]);
    assert.equal(calls[2].cwd, fs.realpathSync(path.join(stateDir, "attachments")));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
