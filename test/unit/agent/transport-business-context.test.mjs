import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatFeishuError } from "../../../dist/agent/transport-business-context.mjs";
import { TelemetrySpool } from "../../../dist/platform/telemetry-spool.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE = path.join(ROOT, "src/agent/transport-business-context.ts");
const DISPATCHER = path.join(ROOT, "src/agent/agent-transport.ts");
const RUNTIME = path.join(ROOT, "dist/agent/agent-transport.cjs");

test("strict TypeScript owns the Agent API dispatcher and its direct CJS runtime", () => {
  const source = fs.readFileSync(SOURCE, "utf8");
  const dispatcher = fs.readFileSync(DISPATCHER, "utf8");
  const runtime = fs.readFileSync(RUNTIME, "utf8");
  assert.doesNotMatch(source, /\bany\b|@ts-(?:nocheck|ignore|expect-error)/);
  assert.doesNotMatch(dispatcher, /\bany\b|@ts-(?:nocheck|ignore|expect-error)/);
  assert.match(runtime, /createTransportBusinessContext|async function handle/);
  assert.doesNotMatch(runtime, /packages\/larkin-shell|fork\/feishu/);
  assert.match(dispatcher, /createTransportBusinessContext/);
  assert.match(dispatcher, /async function handle\(input: AgentTransportInput\): Promise<AgentTransportResponse>/);
  assert.match(dispatcher, /request: \(input: AgentTransportInput\) => handle\(input\)/);
  assert.match(dispatcher, /requestMultipart: async \(_method: unknown, pathname: unknown, form: MultipartForm \| null \| undefined\)/);
  assert.match(dispatcher, /export const transport = createAgentTransport\(process\.env\);/);
  for (const token of ["/send", "/server", "/events", "/history", "/search", "/integrations", "/resolve", "/reactions", "/reminders"]) {
    assert.notEqual(dispatcher.indexOf(token), -1, token);
  }
  assert.ok(dispatcher.indexOf("/send") < dispatcher.indexOf("/server"));
  assert.ok(dispatcher.indexOf("/server") < dispatcher.indexOf("/events"));
  assert.ok(dispatcher.indexOf("/history") < dispatcher.indexOf("/resolve"));
  assert.ok(dispatcher.indexOf("/resolve") < dispatcher.indexOf("/reactions"));
  assert.ok(dispatcher.indexOf("/reactions") < dispatcher.indexOf("/reminders"));
});

test("business context uses canonical AgentStateStore paths and centralizes local transport children", () => {
  const source = fs.readFileSync(SOURCE, "utf8");
  for (const key of ["paths.map", "paths.replyctx", "paths.botIdentity", "paths.senderProfiles", "paths.conversation", "paths.inbox", "paths.reminders"]) {
    assert.match(source, new RegExp(key.replace(".", "\\.")));
  }
  assert.match(source, /path\.join\(paths\.root, ["']attachments["']\)/);
  assert.match(source, /path\.join\(paths\.root, ["']attachments\.json["']\)/);
  assert.match(source, /path\.join\(paths\.root, ["']transport\.log["']\)/);
  assert.match(fs.readFileSync(RUNTIME, "utf8"), /transport-business-context\.cjs/);
});

test("230027 is target membership guidance, not OAuth scope guidance", () => {
  const formatted = formatFeishuError({ code: 230027, message: "target denied", missing_scopes: ["im:message"] }, "https://grant.invalid");
  assert.match(formatted, /membership/);
  assert.match(formatted, /target authorization/);
  assert.doesNotMatch(formatted, /授权链接|grant\.invalid|补充.*scope/);
});

test("production context renders a display-name mention and preserves exact lark-cli ordering", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-context-production-"));
  try {
    const agentId = "cli_contextA1";
    const stateDir = path.join(temp, "state", "agents", agentId);
    const binDir = path.join(temp, "bin");
    const packageDir = path.join(temp, "node_modules", "@larksuite", "cli");
    const official = path.join(packageDir, "scripts", "run.mjs");
    const loginShell = path.join(temp, "login-shell.sh");
    const sink = path.join(temp, "calls.ndjson");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({ version: 3, serverId: "server-context", activeAgent: agentId, agents: { [agentId]: { runtime: "codex", model: "gpt-contract" } } }), { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, "feishu-map.json"), JSON.stringify({ "#room": "oc_room" }));
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
const fs=require("node:fs"); const args=process.argv.slice(2);
if(args[0]==="--version") { process.stdout.write("1.0.79\\n"); process.exit(0); }
if(args[0]==="config"&&args[1]==="bind"&&args[2]==="--help") { process.stdout.write("--source lark-channel --identity bot-only\\n"); process.exit(0); }
fs.appendFileSync(process.env.CALL_SINK,JSON.stringify(args)+"\\n");
if(args.includes("+chat-members-list")) process.stdout.write(JSON.stringify({ok:true,data:{users:[{name:"林一丹",member_id:"ou_lin"}],bots:[]}}));
else process.stdout.write(JSON.stringify({data:{message_id:"om_sent"}}));
`, { mode: 0o755 });
    fs.symlinkSync(official, path.join(binDir, "lark-cli"));
    fs.writeFileSync(loginShell, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(official)}\n`, { mode: 0o755 });
    const generation = "fixture-generation"; const traceId = "a".repeat(32); const parentSpanId = "b".repeat(16);
    const script = `const fs=require("node:fs");const path=require("node:path");const state=${JSON.stringify(stateDir)};const expiresAt=Date.now()+60000;
fs.writeFileSync(path.join(state,"telemetry-runtime-generation.json"),JSON.stringify({version:1,generation:${JSON.stringify(generation)},pid:process.pid,expiresAt}));
fs.writeFileSync(path.join(state,"telemetry-active-context.json"),JSON.stringify({version:2,generation:${JSON.stringify(generation)},traceId:${JSON.stringify(traceId)},spanId:${JSON.stringify(parentSpanId)},traceFlags:1,expiresAt}));
const {transport}=require(${JSON.stringify(RUNTIME)}); transport.request({method:"POST",path:"/messages/send",body:{target:"#room",content:"@林一丹 你好",idempotencyKey:"fixed"}}).then(r=>process.stdout.write("RESULT="+JSON.stringify(r))).catch(e=>{console.error(e);process.exit(1)});`;
    const telemetrySpool = path.join(temp, "telemetry", "spool");
    const result = spawnSync(process.execPath, ["--eval", script], { cwd: ROOT, encoding: "utf8", env: { ...process.env,
      SHELL: loginShell, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`, LARKIN_CONFIG_DIR: temp, LARKIN_AGENT_ID: agentId, CALL_SINK: sink,
      LARKIN_TELEMETRY_ENABLED: "1", LARKIN_TELEMETRY_SPOOL_DIR: telemetrySpool } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const observed = JSON.parse(result.stdout.slice(result.stdout.indexOf("RESULT=") + 7));
    assert.equal(observed.data.messageId, "om_sent");
    const calls = fs.readFileSync(sink, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls[0], ["im", "+chat-members-list", "--chat-id", "oc_room", "--json"]);
    assert.deepEqual(calls[1], ["im", "+chat-members-list", "--chat-id", "oc_room", "--member-id-type", "user_id", "--json"]);
    assert.deepEqual(calls[2], ["im", "+messages-send", "--chat-id", "oc_room", "--markdown", '<at id="ou_lin"></at> 你好', "--json", "--idempotency-key", "fixed"]);
    const spans = new TelemetrySpool({ spoolDir: telemetrySpool, maxBytes: 1024 * 1024, maxFiles: 100, maxAgeMs: 60_000 }).list()
      .flatMap(({ payload }) => payload.resourceSpans).flatMap((resource) => resource.scopeSpans).flatMap((scope) => scope.spans);
    const sent = spans.find((span) => span.name === "feishu.send");
    assert.equal(sent.traceId, traceId); assert.equal(sent.parentSpanId, parentSpanId); assert.equal(sent.kind, 3);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
