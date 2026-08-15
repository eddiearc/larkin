import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { createChannelTransport } = require(path.join(ROOT, "dist/feishu/channel-transport.cjs"));

function fixture(overrides = {}) {
  const calls = [], remembered = [], invalidated = [], logs = [];
  const service = createChannelTransport({
    dryRun: false,
    selectedAgent: { feishuAppId: "cli_self", createdAt: "2026-07-01T00:00:00.000Z" },
    agentId: "cli_self", agentName: "Configured Agent", agentRuntime: "codex",
    agentModel: "gpt-contract", agentEffort: "high", serverId: "server-contract",
    unknownCreatedAt: "1970-01-01T00:00:00.000Z",
    query: (requestPath, name) => new URL(requestPath, "http://local").searchParams.get(name),
    resolveChatId: (target) => target === "#room" ? "oc_room" : "",
    resolveMemberTo: (_chatId, value) => value === "@bot" ? { type: "app_id", ids: ["cli_other"] } : { type: "user_id", ids: [String(value)] },
    channelContext: (ref) => ({ chat_id: ref === "#room" ? "oc_room" : "", channel_type: "channel", channel_name: "Room" }),
    channelLabel: (ref) => ({ label: "Room topic", chatId: "oc_room", meta: { chat_mode: "topic", chat_type: "group" }, ctx: { thread_id: "omt_topic" }, topicShort: String(ref).includes(":") ? "topic" : "" }),
    chatMeta: () => ({ name: "Room", chat_mode: "group", chat_type: "group" }),
    invalidateChatMeta: (chatId) => invalidated.push(chatId),
    rememberChannel: (...args) => remembered.push(args),
    mappedChannels: () => ({ "#room": "oc_room" }),
    larkJsonOut: (args) => { calls.push(args); return { ok: true, data: {} }; },
    feishuError: (result) => result?.error?.message || null,
    botDisplayName: () => "Feishu Bot",
    feishuAppInfo: () => ({ name: "App Name", description: "Agent description", avatarUrl: "https://example/avatar.png" }),
    log: (...args) => logs.push(args),
    ...overrides,
  });
  const request = (method, requestPath, body = {}) => service.handle({ path: requestPath, pathNoQuery: requestPath.split("?")[0], method, body });
  return { request, calls, remembered, invalidated, logs };
}

test("channel create/update and membership keep exact lark-cli argument contracts", () => {
  const old = process.env.LARKIN_ALLOW_PUBLIC_CHAT;
  delete process.env.LARKIN_ALLOW_PUBLIC_CHAT;
  try {
    const f = fixture({ larkJsonOut(args) { f.calls.push(args); return args.includes("+chat-create") ? { ok: true, data: { chat_id: "oc_new" } } : { ok: true, data: {} }; } });
    const created = f.request("POST", "/channels", { name: "#New Room", description: "desc", visibility: "public" });
    assert.deepEqual(f.calls[0], ["im", "+chat-create", "--name", "New Room", "--chat-mode", "group", "--type", "private", "--json", "--description", "desc"]);
    assert.deepEqual(f.remembered, [["#New Room", "oc_new", { name: "New Room", chat_mode: "group", chat_type: "group" }]]);
    assert.equal(created.data.type, "private");

    f.request("DELETE", "/channels/%23room/members", { agent: "@bot" });
    assert.deepEqual(f.calls[1], ["im", "chat.members", "delete", "--chat-id", "oc_room", "--member-id-type", "app_id", "--data", JSON.stringify({ id_list: ["cli_other"] }), "--json", "--yes"]);

    const updated = f.request("PATCH", "/channels/%23room", { name: "#Renamed", description: "new" });
    assert.deepEqual(f.calls[2], ["im", "+chat-update", "--chat-id", "oc_room", "--json", "--name", "Renamed", "--description", "new"]);
    assert.deepEqual(f.invalidated, ["oc_room"]);
    assert.equal(updated.data.name, "Renamed");
  } finally {
    if (old === undefined) delete process.env.LARKIN_ALLOW_PUBLIC_CHAT;
    else process.env.LARKIN_ALLOW_PUBLIC_CHAT = old;
  }
});

test("member, channel, and profile projections preserve the public response schema", () => {
  const f = fixture({ larkJsonOut(args) {
    f.calls.push(args);
    return { ok: true, data: { bots: [{ name: "Other Bot", app_id: "cli_other" }], users: [{ name: "Lin", member_id: "u_lin" }] } };
  } });
  assert.deepEqual(f.request("GET", "/channel-members?channel=%23room").data, {
    channel: { ref: "#room", type: "channel" },
    agents: [{ name: "Other Bot", status: "active", id: "cli_other" }],
    humans: [{ name: "Lin", description: null, id: "u_lin" }],
  });
  assert.deepEqual(f.calls[0], ["im", "+chat-members-list", "--chat-id", "oc_room", "--member-id-type", "user_id", "--json"]);

  const channel = f.request("GET", "/channels/%23room%3Atopic").data.channel;
  assert.deepEqual(channel, { id: "#room:topic", name: "Room topic", joined: true, chatId: "oc_room", chatMode: "topic", chatType: "group", type: "thread", threadId: "omt_topic" });
  const profile = f.request("GET", "/profile").data;
  assert.equal(profile.name, "Feishu Bot");
  assert.equal(profile.runtime, "codex");
  assert.equal(profile.model, "gpt-contract");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.createdAt, "2026-07-01T00:00:00.000Z");
});

test("scope failures and unsupported channel operations remain explicit", () => {
  const scoped = fixture({
    larkJsonOut: () => ({ ok: false, error: { code: 99991672, message: "missing scope" } }),
    feishuError: () => "missing scope",
  });
  assert.deepEqual(scoped.request("GET", "/channel-members?channel=%23room"), { ok: false, status: 403, error: "missing scope" });
  assert.equal(scoped.request("POST", "/channels/%23room/join").status, 400);
  assert.equal(scoped.request("GET", "/attachments/att_1").status, 501);
  assert.equal(scoped.request("PATCH", "/channels/%23room", { visibility: "private" }).status, 400);
});

test("production transport delegates channel authority and preserves remote member projection", () => {
  const runtime = fs.readFileSync(path.join(ROOT, "dist/agent/agent-transport.cjs"), "utf8");
  const source = fs.readFileSync(path.join(ROOT, "src/agent/agent-transport.ts"), "utf8");
  const context = fs.readFileSync(path.join(ROOT, "src/agent/transport-business-context.ts"), "utf8");
  assert.match(runtime, /createTransportBusinessContext/);
  assert.doesNotMatch(runtime, /packages\/larkin-shell|fork\/feishu/);
  assert.match(context, /from ["']\.\.\/feishu\/channel-transport\.js["']/);
  assert.match(source, /channelTransport\.handle/);
  assert.doesNotMatch(source, /\/\\\/channels\$\/\.test\(pathNoQ\)/);
  assert.doesNotMatch(source, /p\.includes\(["']\/channel-members["']\)/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-channel-production-"));
  try {
    const agentId = "cli_channelA1";
    const stateDir = path.join(temp, "state", "agents", agentId);
    const binDir = path.join(temp, "bin");
    const packageDir = path.join(temp, "node_modules", "@larksuite", "cli");
    const official = path.join(packageDir, "scripts", "run.mjs");
    const loginShell = path.join(temp, "login-shell.sh");
    const sink = path.join(temp, "lark-calls.ndjson");
    fs.mkdirSync(stateDir, { recursive: true }); fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({ version: 3, serverId: "server-channel", activeAgent: agentId, agents: { [agentId]: { runtime: "codex", model: "gpt-contract" } } }), { mode: 0o600 });
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
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@larksuite/cli", version: "1.0.80", bin: { "lark-cli": "scripts/run.mjs" } }));
    fs.writeFileSync(official, `#!/usr/bin/env bun
const args=process.argv.slice(2);
if(args[0]==="--version") { process.stdout.write("1.0.80\\n"); process.exit(0); }
if(args[0]==="config"&&args[1]==="bind"&&args[2]==="--help") { process.stdout.write("--source lark-channel --identity bot-only\\n"); process.exit(0); }
require("node:fs").appendFileSync(process.env.LARK_CALL_SINK, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+"\\n");
process.stdout.write(JSON.stringify({ok:true,data:{bots:[{name:"Remote Bot",app_id:"cli_remote"}],users:[{name:"Remote Human",member_id:"u_remote"}]}}));
`, { mode: 0o755 });
    fs.symlinkSync(official, path.join(binDir, "lark-cli"));
    fs.writeFileSync(loginShell, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(official)}\n`, { mode: 0o755 });
    const script = `const {transport}=require(${JSON.stringify(path.join(ROOT, "dist/agent/agent-transport.cjs"))});
transport.request({method:"GET",path:"/channel-members?channel=%23room"}).then(result=>process.stdout.write("RESULT="+JSON.stringify(result))).catch(error=>{console.error(error);process.exit(1)});`;
    const result = spawnSync(process.execPath, ["--eval", script], { cwd: ROOT, encoding: "utf8", env: { ...process.env,
      SHELL: loginShell, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`, LARKIN_CONFIG_DIR: temp,
      LARKIN_AGENT_ID: agentId, LARK_CALL_SINK: sink } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const observed = JSON.parse(result.stdout.slice(result.stdout.indexOf("RESULT=") + 7));
    assert.equal(observed.ok, true);
    assert.deepEqual(observed.data.agents, [{ name: "Remote Bot", status: "active", id: "cli_remote" }]);
    assert.deepEqual(observed.data.humans, [{ name: "Remote Human", description: null, id: "u_remote" }]);
    const calls = fs.readFileSync(sink, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.map((call) => call.args), [["im", "+chat-members-list", "--chat-id", "oc_room", "--member-id-type", "user_id", "--json"]]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
