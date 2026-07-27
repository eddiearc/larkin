import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

test("production context renders a display-name mention and preserves exact lark-cli ordering", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-context-production-"));
  try {
    const agentId = "cli_contextA1";
    const stateDir = path.join(temp, "state", "agents", agentId);
    const binDir = path.join(temp, "bin");
    const sink = path.join(temp, "calls.ndjson");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({ version: 3, serverId: "server-context", activeAgent: agentId, agents: { [agentId]: { runtime: "codex", model: "gpt-contract" } } }), { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, "feishu-map.json"), JSON.stringify({ "#room": "oc_room" }));
    fs.writeFileSync(path.join(binDir, "lark-cli"), `#!/usr/bin/env bun
const fs=require("node:fs"); const args=process.argv.slice(2); fs.appendFileSync(process.env.CALL_SINK,JSON.stringify(args)+"\\n");
if(args.includes("+chat-members-list")) process.stdout.write(JSON.stringify({ok:true,data:{users:[{name:"林一丹",member_id:"ou_lin"}],bots:[]}}));
else process.stdout.write(JSON.stringify({data:{message_id:"om_sent"}}));
`, { mode: 0o755 });
    const script = `const {transport}=require(${JSON.stringify(RUNTIME)}); transport.request({method:"POST",path:"/messages/send",body:{target:"#room",content:"@林一丹 你好",idempotencyKey:"fixed"}}).then(r=>process.stdout.write("RESULT="+JSON.stringify(r))).catch(e=>{console.error(e);process.exit(1)});`;
    const result = spawnSync(process.execPath, ["--eval", script], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`, LARKIN_CONFIG_DIR: temp, LARKIN_AGENT_ID: agentId, CALL_SINK: sink } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const observed = JSON.parse(result.stdout.slice(result.stdout.indexOf("RESULT=") + 7));
    assert.equal(observed.data.messageId, "om_sent");
    const calls = fs.readFileSync(sink, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls[0], ["--profile", agentId, "im", "+chat-members-list", "--chat-id", "oc_room", "--json"]);
    assert.deepEqual(calls[1], ["--profile", agentId, "im", "+chat-members-list", "--chat-id", "oc_room", "--member-id-type", "user_id", "--json"]);
    assert.deepEqual(calls[2], ["--profile", agentId, "im", "+messages-send", "--chat-id", "oc_room", "--markdown", '<at id="ou_lin"></at> 你好', "--json", "--idempotency-key", "fixed"]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
