import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("production grant, transport, and host contain no v2 identity/path/default-chat compatibility", () => {
  const transport = source("dist/agent/agent-transport.cjs");
  assert.doesNotMatch(transport, /SLOCK_|\bLARKIN_CFG\b|DEFAULT_CHAT|defaultChatId|LARKIN_FEISHU_(?:MAP|INBOX|REPLYCTX|DEFAULT_CHAT_ID)|LARKIN_(?:HOME|LARK_CONFIG_DIR|RUNTIME|MODEL|EFFORT|SERVER_ID|SERVER_URL|AGENT_NAME|BOT_OPEN_ID)/);
  assert.doesNotMatch(transport, /00000000-0000-0000-0000-0000000000aa|527d4cd1-cdca-4ea2-8ec4-78095e0a3684|\|\|\s*["'](?:claude|larkin)["']/);
  assert.doesNotMatch(transport, /name:\s*["']larkin["']|computer(?:Name|Hostname):\s*["']larkin["']/);
  const grant = source("src/setup/grant-scopes.ts");
  const grantEntry = source("dist/setup/grant-scopes.mjs");
  assert.doesNotMatch(grant, /version\s*===\s*2|defaultChatId|feishuAppId\s*\|\||feishuProfile\s*\|\||catch\s*\{\s*return\s*\{\}/);
  assert.match(grant, /loadConfig\(process\.env\)/);
  assert.match(grantEntry, /registerApp|spawnSync|TENANT_SCOPES/);
  assert.doesNotMatch(grantEntry, /packages\/larkin-shell|fork\/feishu/);
  const runtimeProcess = source("src/app/runtime-process.ts");
  const hostShell = source("src/feishu/host-shell.ts");
  const hostBusiness = source("src/feishu/host-business-state.ts");
  assert.doesNotMatch(hostShell, /agent\.defaultChatId|process\.env\.LARKIN_SERVER_ID\s*\|\||00000000-0000-0000-0000-000000000000/);
  const reminderBusiness = source("src/agent/host-reminder-orchestrator.ts");
  assert.match(runtimeProcess, /createHostShell/);
  assert.match(hostShell, /new HostReminderOrchestrator/);
  assert.match(reminderBusiness, /import \{ countWakeEnvelopes \}/);
  assert.match(reminderBusiness, /countWakeEnvelopes\(/);
  assert.match(reminderBusiness, /message_id\.startsWith\("redeliver_"\)/,
    "startup wake counting must exclude canonical redelivery envelopes");
  assert.match(reminderBusiness, /redeliveryInFlight/,
    "concurrent startup timers must share one redelivery attempt");
  assert.match(reminderBusiness, /async redeliverUnread/);
  const redeliveryAuthority = reminderBusiness.slice(reminderBusiness.indexOf("private async performRedelivery"));
  const durableAppend = redeliveryAuthority.indexOf('appendNdjson("inbox", envelope)');
  const runtimeDeliver = redeliveryAuthority.indexOf("deliveryTarget.deliver");
  assert.ok(durableAppend >= 0 && runtimeDeliver > durableAppend,
    "canonical Inbox append must remain authoritative and precede Runtime delivery");
  assert.match(hostBusiness, /JSON\.parse\(line\).*\.wake\s*===\s*true/);
  assert.doesNotMatch(reminderBusiness, /channel_type\s*===\s*["']dm["']|sender_type\s*===\s*["']system["']|提及说明/);
});

test("grant-scopes selects only explicit App ID, explicit --agent App ID, or activeAgent and never implicit send target", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-grant-v3-"));
  try {
    const root = path.join(temp, "root");
    const app = "cli_grantA1";
    const other = "cli_grantB2";
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
      version: 3, serverId: "server-grant", activeAgent: app,
      agents: { [app]: { runtime: "codex", model: "gpt" }, [other]: { runtime: "claude", model: "sonnet" } },
    }), { mode: 0o600 });
    const marker = path.join(temp, "register.json");
    const spawnMarker = path.join(temp, "spawn.ndjson");
    const preload = path.join(temp, "preload.cjs");
    fs.writeFileSync(preload, `module.exports={
  registerApp:async(opts)=>{require("node:fs").writeFileSync(process.env.REGISTER_MARKER,JSON.stringify(opts));opts.onQRCodeReady({url:"https://mock.invalid/grant",expireIn:60});return {client_id:opts.appId}},
  qrcode:{generate(){}},
  managedOfficialCli:()=>({command:{command:"/verified/official-lark-cli",argsPrefix:[],version:"1.0.79"},env:{}}),
  spawnSync(command,args){require("node:fs").appendFileSync(process.env.SPAWN_MARKER,JSON.stringify({command,args})+"\\n");return {status:0,stdout:"{}",stderr:""}}
};`);
    const run = (args = [], extra = {}) => spawnSync(process.execPath, [path.join(ROOT, "dist/setup/grant-scopes.mjs"), "--wait-min", "1", ...args], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKSUITE_CLI_CONFIG_DIR: path.join(temp, "lark-cli"), LARKIN_TEST_GRANT_SCOPES_MODULE: preload, REGISTER_MARKER: marker, SPAWN_MARKER: spawnMarker, ...extra },
    });
    let result = run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).appId, app);
    assert.equal(fs.existsSync(spawnMarker), false, "QR callback without --send-to must not spawn lark-cli send");
    fs.rmSync(marker);
    result = run(["--agent", other]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).appId, other);
    assert.equal(fs.existsSync(spawnMarker), false);
    fs.rmSync(marker);
    result = run(["--agent", "cli_unknown"]);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(marker), false);
    result = run(["--app-id", other], { LARKIN_FEISHU_DEFAULT_CHAT_ID: "oc_legacy" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).appId, other);
    assert.equal(fs.existsSync(spawnMarker), false, "legacy default chat env must remain ignored");
    result = run(["--app-id", other, "--send-to", "oc_explicit"]);
    assert.equal(result.status, 0, result.stderr);
    const sends = fs.readFileSync(spawnMarker, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].command, "/verified/official-lark-cli");
    assert.deepEqual(sends[0].args.slice(0, 4), ["im", "+messages-send", "--chat-id", "oc_explicit"]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("transport derives identity and state only from strict hydrated v3 selection", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-transport-v3-"));
  try {
    const root = path.join(temp, "root");
    const app = "cli_transportA1";
    const other = "cli_transportB2";
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
      version: 3, serverId: "server-canonical", activeAgent: app,
      agents: { [app]: { runtime: "codex", model: "gpt-canonical" }, [other]: { runtime: "claude", model: "sonnet-canonical" } },
    }), { mode: 0o600 });
    const canonicalInbox = path.join(root, "state", "agents", app, "feishu-inbox.ndjson");
    fs.mkdirSync(path.dirname(canonicalInbox), { recursive: true });
    fs.writeFileSync(canonicalInbox, "");
    const legacyInbox = path.join(temp, "legacy-inbox.ndjson");
    fs.writeFileSync(legacyInbox, JSON.stringify({ message_id: "legacy" }) + "\n");
    const script = `const cp=require("node:child_process"),original=cp.spawnSync;cp.spawnSync=function(command){return command==="lark-cli"?{status:1,stdout:"",stderr:"mocked"}:original.apply(this,arguments)}; const {transport}=require(${JSON.stringify(path.join(ROOT, "dist/agent/agent-transport.cjs"))}); (async()=>{const s=await transport.request({method:"GET",path:"/server"}); const p=await transport.request({method:"GET",path:"/profile"}); process.stdout.write(JSON.stringify({runtimeContext:s.data.runtimeContext,profile:p.data}));})().catch(e=>{console.error(e);process.exit(1)});`;
    const result = spawnSync(process.execPath, ["--eval", script], { cwd: ROOT, encoding: "utf8", env: {
      ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root,
      LARKIN_HOME: path.join(temp, "legacy-home"), LARKIN_FEISHU_INBOX: legacyInbox, LARKIN_FEISHU_MAP: path.join(temp, "legacy-map"),
      LARKIN_FEISHU_REPLYCTX: path.join(temp, "legacy-reply"), LARKIN_RUNTIME: "legacy", LARKIN_MODEL: "legacy", LARKIN_SERVER_ID: "legacy-server",
      LARKIN_AGENT_NAME: other, LARKIN_FEISHU_DEFAULT_CHAT_ID: "oc_legacy", SLOCK_AGENT_ID: other,
    }});
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed.runtimeContext, { agentId: app, serverId: "server-canonical" });
    assert.equal(observed.profile.id, app);
    assert.equal(observed.profile.name, app);
    assert.equal(observed.profile.runtime, "codex");
    assert.equal(observed.profile.model, "gpt-canonical");
    assert.match(fs.readFileSync(legacyInbox, "utf8"), /legacy/);
    const unknown = spawnSync(process.execPath, [path.join(ROOT, "dist/agent/agent-transport.cjs")], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: "cli_unknown" },
    });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Agent|不存在|unknown/i);

    const otherInbox = path.join(root, "state", "agents", other, "feishu-inbox.ndjson");
    fs.mkdirSync(path.dirname(otherInbox), { recursive: true });
    fs.writeFileSync(otherInbox, JSON.stringify({ message_id: "other-event", seq: 1, sender_name: "user", sender_type: "human", channel_type: "dm", channel_name: "user", content: "hello", timestamp: "2026-07-15T00:00:00.000Z", thread_id: null }) + "\n");
    const otherScript = `const cp=require("node:child_process"),original=cp.spawnSync;cp.spawnSync=function(command){return command==="lark-cli"?{status:1,stdout:"",stderr:"mocked"}:original.apply(this,arguments)}; const {transport}=require(${JSON.stringify(path.join(ROOT, "dist/agent/agent-transport.cjs"))}); (async()=>{const p=await transport.request({method:"GET",path:"/profile"}); const e=await transport.request({method:"GET",path:"/events"}); process.stdout.write(JSON.stringify({profile:p.data,events:e.data.events}));})().catch(e=>{console.error(e);process.exit(1)});`;
    const selectedOther = spawnSync(process.execPath, ["--eval", otherScript], { cwd: ROOT, encoding: "utf8", env: {
      ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: other,
      LARKIN_FEISHU_INBOX: legacyInbox, LARKIN_RUNTIME: "legacy", LARKIN_MODEL: "legacy",
    }});
    assert.equal(selectedOther.status, 0, selectedOther.stderr);
    const otherObserved = JSON.parse(selectedOther.stdout);
    assert.equal(otherObserved.profile.id, other);
    assert.equal(otherObserved.profile.runtime, "claude");
    assert.equal(otherObserved.profile.model, "sonnet-canonical");
    assert.deepEqual(otherObserved.events.map((event) => event.message_id), ["other-event"]);
    assert.equal(fs.readFileSync(otherInbox, "utf8"), "", "selected Agent canonical inbox must be cleared");
    assert.match(fs.readFileSync(legacyInbox, "utf8"), /legacy/, "legacy override inbox must remain untouched");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Larkin-owned agent CLI profile show accepts minimal v3 and preserves explicit createdAt locally", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-profile-v3-"));
  try {
    const root = path.join(temp, "root");
    const bin = path.join(temp, "bin");
    const app = "cli_profileA1";
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    const mockCli = path.join(bin, "lark-cli");
    fs.writeFileSync(mockCli, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const configFile = path.join(root, "config.json");
    const writeConfig = (agent) => fs.writeFileSync(configFile, JSON.stringify({ version: 3, serverId: "server-profile", activeAgent: app, agents: { [app]: agent } }), { mode: 0o600 });
    const run = () => spawnSync(process.execPath, [path.join(ROOT, "dist/app/agent-cli.mjs"), "profile", "show", "--json"], { cwd: ROOT, encoding: "utf8", env: {
      ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root,
      LARKIN_AGENT_ID: app,
    }});
    writeConfig({ runtime: "codex", model: "gpt-minimal" });
    let result = run();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /cli_profileA1/);
    assert.match(result.stdout, /1970-01-01T00:00:00\.000Z/);
    const createdAt = "2026-07-15T01:02:03.000Z";
    writeConfig({ runtime: "codex", model: "gpt-minimal", createdAt });
    result = run();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(createdAt.replaceAll(".", "\\.")));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("runtime ships the generated process-inspect CJS consumer", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "dist/platform/process-inspect.cjs")), true);
});

test("strict TypeScript host shell owns authored process inspection", () => {
  const runtimeProcess = source("src/app/runtime-process.ts");
  const shell = source("src/feishu/host-shell.ts");
  assert.match(runtimeProcess, /from ["']\.\.\/feishu\/host-shell\.js["']/);
  assert.match(shell, /from ["']\.\.\/platform\/process-inspect\.cjs["']/);
});

test("process-state is compiled directly from the authored TypeScript artifact", () => {
  const runtime = source("dist/platform/process-state.mjs");
  assert.match(runtime, /acquireProcessLock|readProcessState|process-inspect\.cjs/);
  assert.doesNotMatch(runtime, /packages\/larkin-shell|fork\/feishu/);
  const authored = source("src/platform/process-state.ts");
  assert.match(authored, /import processInspectImport from ["']\.\/process-inspect\.cjs["']/);
  assert.doesNotMatch(authored, /createRequire|\brequire\(/);
});

test("WorkspaceService import ownership is host-only", () => {
  const shell = source("src/feishu/host-shell.ts");
  assert.match(shell, /from ["']\.\.\/platform\/workspace-service\.js["']/);
  for (const rel of ["dist/app/setup.mjs", "dist/app/run.mjs"]) {
    assert.doesNotMatch(source(rel), /packages\/larkin-shell\/dist\/workspace-service\.(?:mjs|cjs)/, rel);
  }
});

test("setup has no previous-ID mapping or daemon inference fallback", () => {
  const setup = source("src/app/setup.ts");
  assert.doesNotMatch(setup, /\bpreviousAgentId\b|\binferRunningAgents\b|\bkeyByAgentId\b/);
});

test("setup-bind has no previous-ID workspace bridge", () => {
  const bind = source("src/setup/setup-bind.ts");
  const entry = source("dist/setup/setup-bind.mjs");
  assert.doesNotMatch(bind, /\bpreviousAgentId\b|\bensureWorkspaceBridge\b/);
  assert.match(entry, /spawnSync|writeConfigAtomic/);
  assert.doesNotMatch(entry, /\bpreviousAgentId\b|\bensureWorkspaceBridge\b|packages\/larkin-shell|fork\/feishu/);
});

test("bot-register has no known-Agent alias scan or previous ID result", () => {
  const register = source("src/setup/bot-register.ts");
  const entry = source("dist/setup/bot-register.mjs");
  assert.doesNotMatch(register, /\bknownAgent\b|\bpreviousAgentId\b|findAgentBindingByAppId/);
  assert.match(entry, /registerApp|spawnSync|client_secret|ensureSecureBotsDir/);
  assert.doesNotMatch(entry, /\bknownAgent\b|\bpreviousAgentId\b|findAgentBindingByAppId|packages\/larkin-shell|fork\/feishu/);
});

test("host has no state-file environment or /tmp compatibility fallbacks", () => {
  const shell = source("src/feishu/host-shell.ts");
  const layout = source("src/platform/root-layout.ts");
  assert.doesNotMatch(shell, /LARKIN_FEISHU_(?:MAP|INBOX|REPLYCTX)|LARKIN_AGENT_STATE/);
  assert.doesNotMatch(shell, /\/tmp\/larkin-/);
  assert.doesNotMatch(shell, /agent\.stateDir\s*\?|const\s+dir\s*=\s*agent\.stateDir\s*\|\|/);
  assert.match(shell, /from ["']\.\.\/agent\/agent-state-store\.js["']/);
  assert.match(shell, /from ["']\.\/host-business-state\.js["']/);
  assert.match(shell, /new HostReminderOrchestrator\([\s\S]*stateStore/);
  for (const name of [
    "agent-state.json",
    "feishu-map.json",
    "feishu-inbox.ndjson",
    "feishu-replyctx.json",
    "bot-identity.json",
    "feishu-read.json",
    "feishu-pending-react.json",
    "reminders.json",
    "sender-profiles.json",
    "status.json",
    "conversation.ndjson",
  ]) {
    assert.match(layout, new RegExp(`path\\.join\\(root, ["']${name.replace(".", "\\.")}["']\\)`), name);
  }
});

test("host has no runtime or model compatibility defaults", () => {
  const shell = source("src/feishu/host-shell.ts");
  assert.doesNotMatch(shell, /agent\??\.(?:runtime|model)\s*\|\|/);
  assert.doesNotMatch(shell, /gpt-5\.5|sonnet/);
});

test("runtime process directly composes strict TypeScript HostShell", () => {
  const runtimeProcess = source("src/app/runtime-process.ts");
  const shell = source("src/feishu/host-shell.ts");
  assert.match(runtimeProcess, /createRuntimeHost/);
  assert.match(runtimeProcess, /createHostShell\(\{[\s\S]*env,[\s\S]*runtimeHost,[\s\S]*onOrderedShutdownComplete:[\s\S]*process\.exit/);
  assert.doesNotMatch(runtimeProcess, /WebSocket|agent:deliver|wsFactory/);
  assert.match(shell, /createLarkChannel/);
  assert.match(shell, /from ["']node:fs["']/);
  assert.match(shell, /from ["']node:child_process["']/);
  assert.match(shell, /process\.once\(["']SIGINT["']/);
});

test("real host child observes only canonical single-root state files", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-statefiles-"));
  try {
    const root = path.join(temp, "root");
    const stateDir = path.join(root, "state", "agents", "cli_statefiles1");
    const marker = path.join(temp, "reads.ndjson");
    fs.mkdirSync(root, { recursive: true });
    const preload = path.join(temp, "preload.cjs");
    fs.writeFileSync(preload, `
const fs = require("node:fs");
const Module = require("node:module");
const originalRead = fs.readFileSync;
const originalOpen = fs.openSync;
const originalLoad = Module._load;
function recordStateFile(file) {
  if (process.env.STATEFILE_MARKER && /(?:agent-state|feishu-map|feishu-inbox|feishu-replyctx|bot-identity|feishu-read|feishu-pending-react|reminders|sender-profiles|status|conversation)\\.(?:json|ndjson)$/.test(String(file))) {
    fs.appendFileSync(process.env.STATEFILE_MARKER, JSON.stringify(String(file)) + "\\n");
  }
}
fs.readFileSync = function(file, ...args) {
  recordStateFile(file);
  return originalRead.call(this, file, ...args);
};
fs.openSync = function(file, ...args) {
  recordStateFile(file);
  return originalOpen.call(this, file, ...args);
};
Module._load = function(request, parent, isMain) {
  if (String(request).includes("dist/platform/workspace-service.cjs")) return { reconcileAgentWorkspace() { return { changed: [] }; } };
  return originalLoad.call(this, request, parent, isMain);
};
module.exports={reconcileAgentWorkspaceImpl(){return {changed:[]}}};
`);
    const app = "cli_statefiles1";
    const agent = {
      name: app,
      agentId: app,
      feishuAppId: app,
      feishuProfile: app,
      runtime: "codex",
      model: "test",
      workspaceDir: path.join(root, "agents", app),
      stateDir,
      larkConfigDir: path.join(root, "lark-cli-config"),
    };
    const result = spawnSync(process.execPath, ["--eval", `require(${JSON.stringify(path.join(ROOT, "test/support/host-shell-test-harness.cjs"))})`], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: path.join(temp, "isolated-home"),
        LARKIN_HOME: root,
        LARKIN_CONFIG_DIR: root,
        LARKIN_SERVER_ID: "server-statefiles",
        LARKIN_AGENTS_CONFIG: JSON.stringify([agent]),
        LARKIN_AGENT_STATE: path.join(temp, "legacy-agent-state.json"),
        LARKIN_FEISHU_MAP: path.join(temp, "legacy-map.json"),
        LARKIN_FEISHU_INBOX: path.join(temp, "legacy-inbox.ndjson"),
        LARKIN_FEISHU_REPLYCTX: path.join(temp, "legacy-replyctx.json"),
        LARKIN_FEISHU_EVENT_FILE: path.join(temp, "events.ndjson"),
        LARKIN_FEISHU_DRYRUN: "1",
        STATEFILE_MARKER: marker,
        LARKIN_TEST_HOST_MODULE: preload,
      },
      encoding: "utf8",
      timeout: 3_000,
    });
    assert.ok(!result.error || result.error.code === "ETIMEDOUT", result.error?.message || result.stderr);
    assert.equal(fs.existsSync(marker), true, result.stderr || result.stdout || "host recorded no canonical state access");
    const observed = fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.ok(observed.length >= 4, `expected startup state reads, got ${JSON.stringify(observed)}`);
    assert.ok(observed.every((file) => file.startsWith(stateDir + path.sep)), JSON.stringify(observed));
    assert.equal(fs.existsSync(path.join(stateDir, "agent-state.json")), true);
    assert.equal(fs.existsSync(path.join(temp, "legacy-agent-state.json")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
