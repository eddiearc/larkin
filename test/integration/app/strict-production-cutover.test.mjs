import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP = "cli_strictA1";
const TRANSIENT_VERIFY_CHILD_TIMEOUT_MS = 10_000;
const TRANSIENT_VERIFY_TEST_TIMEOUT_MS = 15_000;

function storedConfig() {
  return { version: 3, serverId: "server-strict", activeAgent: APP, agents: { [APP]: { runtime: "codex", model: "gpt-5.5" } } };
}

function writeConfig(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(path.join(root, "agents", APP), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(storedConfig()), { mode: 0o600 });
}

function writeCredential(root, value, mode = 0o600) {
  const file = path.join(root, "bots", `${APP}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  fs.writeFileSync(file, value, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function successfulRunPreload(temp) {
  const preload = path.join(temp, "successful-run.cjs");
  fs.writeFileSync(preload, `const cp=require("node:child_process"),fs=require("node:fs"),original=cp.spawnSync,originalLstat=fs.lstatSync,{EventEmitter}=require("node:events"); fs.lstatSync=function(file,...args){const stat=originalLstat.call(this,file,...args);if(process.env.FAKE_UID_PATH&&String(file)===process.env.FAKE_UID_PATH)return new Proxy(stat,{get(target,prop){if(prop==="uid")return target.uid+1;const value=Reflect.get(target,prop,target);return typeof value==="function"?value.bind(target):value}});return stat};cp.spawnSync=(command,args,options)=>{if(command!=="lark-cli")return original(command,args,options);if(args.includes("+chat-list"))return {status:0,stdout:JSON.stringify({ok:true,identity:"bot"}),stderr:""};return {status:0,stdout:"",stderr:""}};cp.spawn=()=>{fs.writeFileSync(process.env.SPAWN_MARKER,"yes");const child=new EventEmitter();child.pid=process.pid+1000;child.kill=()=>true;queueMicrotask(()=>child.emit("exit",0));return child};require("node:module").syncBuiltinESMExports();`);
  return preload;
}

test("effort is unsupported when the selected model has no declared supportedReasoningEfforts", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-effort-"));
  try {
    const root = path.join(temp, "root");
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    const codex = path.join(bin, "codex");
    fs.writeFileSync(codex, `#!/usr/bin/env bun
if(process.argv.slice(2).join(" ")!=="app-server --stdio")process.exit(2);let input="";process.stdin.on("data",c=>{input+=c;for(;;){const i=input.indexOf("\\n");if(i<0)break;const request=JSON.parse(input.slice(0,i));input=input.slice(i+1);if(request.method==="model/list")process.stdout.write(JSON.stringify({id:request.id,result:{data:[{id:"gpt-5.5",model:"gpt-5.5",displayName:"GPT-5.5",hidden:false,isDefault:true,supportedReasoningEfforts:[]}]}})+"\\n")}});`);
    fs.chmodSync(codex, 0o755);
    writeConfig(root);
    const before = fs.readFileSync(path.join(root, "config.json"), "utf8");
    const result = spawnSync(process.execPath, [path.join(ROOT, "dist/app/agent-config.mjs"), "effort", "high"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), PATH: `${bin}:${process.env.PATH || ""}`, LARKIN_CONFIG_DIR: root },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /不支持|未声明|不能设置|不消费 effort/i);
    assert.equal(fs.readFileSync(path.join(root, "config.json"), "utf8"), before);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("bot credential verification pins lark-cli identity explicitly to bot", () => {
  const register = fs.readFileSync(path.join(ROOT, "src/setup/bot-register.ts"), "utf8");
  const bind = fs.readFileSync(path.join(ROOT, "src/setup/setup-bind.ts"), "utf8");
  assert.match(register, /\[\.\.\.official\.argsPrefix, "im", "\+chat-list", "--as", "bot"\]/);
  assert.match(register, /synchronizeAgentProfile\(agent/);
  assert.match(bind, /\["--profile", profile\.name, "im", "\+chat-list", "--as", "bot", "--json"\]/);
  assert.match(bind, /profile\.name !== profile\.appId/);
});

test("run fails closed for missing or malformed App-ID bot credentials before daemon spawn", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-run-creds-"));
  try {
    const preload = path.join(temp, "no-daemon-spawn.cjs");
    const marker = path.join(temp, "spawned");
    fs.writeFileSync(preload, `
const cp = require("node:child_process"); const {EventEmitter}=require("node:events"); const fs=require("node:fs");
cp.spawn = function(){ fs.writeFileSync(process.env.SPAWN_MARKER,"spawned"); const c=new EventEmitter(); c.pid=424242; c.kill=()=>{}; process.nextTick(()=>c.emit("exit",0)); return c; };
cp.spawnSync = function(command,args){ if(command==="lark-cli" && args.includes("+chat-list")) return {status:0,stdout:JSON.stringify({ok:true,identity:"bot"}),stderr:""}; return {status:0,stdout:"",stderr:""}; };
require("node:module").syncBuiltinESMExports();
module.exports={
  channelPackage:{createLarkChannel(){ return {on(){},dispatcher:{register(){}},connect(){return Promise.reject(new Error("unauthorized secret"));},disconnect(){return new Promise(()=>{});},rawClient:null,botIdentity:null}; }},
  execFileImpl(_c,_a,_o,cb){cb(new Error("mocked"),"","");},
};
`);
    const cases = [
      ["missing", null],
      ["invalid-json", "{"],
      ["wrong-app", JSON.stringify({ appId: "cli_otherA1", appSecret: "secret-value", tenant: "feishu" })],
      ["empty-secret", JSON.stringify({ appId: APP, appSecret: "", tenant: "feishu" })],
      ["invalid-tenant", JSON.stringify({ appId: APP, appSecret: "secret-value", tenant: "other" })],
      ["unknown-field", JSON.stringify({ appId: APP, appSecret: "secret-value", tenant: "feishu", legacy: true })],
      ["bad-owner", JSON.stringify({ appId: APP, appSecret: "secret-value", tenant: "feishu", ownerOpenId: 42 })],
      ["bad-date", JSON.stringify({ appId: APP, appSecret: "secret-value", tenant: "feishu", updatedAt: "not-a-date" })],
    ];
    for (const [name, credential] of cases) {
      const root = path.join(temp, name);
      writeConfig(root);
      if (credential !== null) writeCredential(root, credential);
      fs.rmSync(marker, { force: true });
      const result = spawnSync(process.execPath, [path.join(ROOT, "dist/app/run.mjs")], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, SPAWN_MARKER: marker, BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" ") },
      });
      assert.equal(result.status, 1, `${name}: ${result.stderr || result.stdout}`);
      assert.equal(fs.existsSync(marker), false, `${name} must fail before daemon spawn`);
      assert.doesNotMatch(result.stderr + result.stdout, /secret-value/);
    }

    const valid = JSON.stringify({ appId: APP, appSecret: "secret-value", tenant: "feishu" });
    for (const kind of ["mode-0644", "directory", "symlink"]) {
      const root = path.join(temp, kind);
      writeConfig(root);
      const file = path.join(root, "bots", `${APP}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.dirname(file), 0o700);
      if (kind === "mode-0644") writeCredential(root, valid, 0o644);
      else if (kind === "directory") fs.mkdirSync(file);
      else {
        const target = path.join(temp, "symlink-target.json");
        fs.writeFileSync(target, valid, { mode: 0o600 });
        fs.symlinkSync(target, file);
      }
      fs.rmSync(marker, { force: true });
      const result = spawnSync(process.execPath, [path.join(ROOT, "dist/app/run.mjs")], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, SPAWN_MARKER: marker, BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" ") },
      });
      assert.equal(result.status, 1, `${kind}: ${result.stderr || result.stdout}`);
      assert.equal(fs.existsSync(marker), false);
      assert.doesNotMatch(result.stderr + result.stdout, /secret-value/);
    }
    for (const kind of ["bots-mode", "bots-file", "bots-symlink"]) {
      const root = path.join(temp, kind);
      writeConfig(root);
      const bots = path.join(root, "bots");
      if (kind === "bots-file") fs.writeFileSync(bots, "not-a-directory");
      else if (kind === "bots-symlink") {
        const target = path.join(temp, `${kind}-target`);
        fs.mkdirSync(target, { mode: 0o700 });
        fs.writeFileSync(path.join(target, `${APP}.json`), valid, { mode: 0o600 });
        fs.symlinkSync(target, bots);
      } else {
        writeCredential(root, valid);
        fs.chmodSync(bots, 0o755);
      }
      fs.rmSync(marker, { force: true });
      const result = spawnSync(process.execPath, [path.join(ROOT, "dist/app/run.mjs")], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, SPAWN_MARKER: marker, BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" ") },
      });
      assert.equal(result.status, 1, `${kind}: ${result.stderr || result.stdout}`);
      assert.equal(fs.existsSync(marker), false);
    }
    for (const kind of ["lark-mode", "lark-symlink"]) {
      const root = path.join(temp, kind);
      writeConfig(root);
      writeCredential(root, valid);
      const larkDir = path.join(root, "lark-cli-config");
      const outside = path.join(temp, `${kind}-outside`);
      fs.mkdirSync(outside, { mode: 0o700 });
      fs.writeFileSync(path.join(outside, "user-profile"), "unchanged");
      if (kind === "lark-symlink") fs.symlinkSync(outside, larkDir);
      else { fs.mkdirSync(larkDir, { mode: 0o755 }); fs.chmodSync(larkDir, 0o755); }
      fs.rmSync(marker, { force: true });
      const result = spawnSync(process.execPath, [path.join(ROOT, "dist/app/run.mjs")], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME:path.join(temp,"home"), LARKIN_CONFIG_DIR:root, SPAWN_MARKER:marker, BUN_OPTIONS:[process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" ") },
      });
      assert.equal(result.status, 1, `${kind}: ${result.stderr || result.stdout}`);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.readFileSync(path.join(outside, "user-profile"), "utf8"), "unchanged");
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("persisted effort is rejected when it is outside the runtime safety enum", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-persisted-effort-"));
  try {
    const root = path.join(temp, "root");
    const stored = storedConfig();
    stored.agents[APP].effort = "off";
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(stored), { mode: 0o600 });
    writeCredential(root, JSON.stringify({ appId: APP, appSecret: "secret-value", tenant: "feishu" }));
    const marker = path.join(temp, "spawned");
    const preload = path.join(temp, "spawn.cjs");
    fs.writeFileSync(preload, `const cp=require("node:child_process"); const fs=require("node:fs"); cp.spawn=()=>{fs.writeFileSync(process.env.SPAWN_MARKER,"yes"); throw new Error("spawn reached");}; require("node:module").syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, [path.join(ROOT, "dist/app/run.mjs")], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, SPAWN_MARKER: marker, BUN_OPTIONS: `--preload=${preload}` },
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(fs.existsSync(marker), false);
    assert.doesNotMatch(result.stderr + result.stdout, /secret-value/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("run and hot attach bind only the selected Agent lark-channel workspace without quarantine rebuilds", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/app/runtime-agent-config.ts"), "utf8");
  const runSource = fs.readFileSync(path.join(ROOT, "src/app/run.ts"), "utf8");
  const runtimeSource = fs.readFileSync(path.join(ROOT, "src/app/runtime-process.ts"), "utf8");
  assert.match(source, /"config", "bind", "--source", "lark-channel", "--identity", "bot-only"/);
  assert.doesNotMatch(source, /"config", "init"/);
  assert.doesNotMatch(source + runSource + runtimeSource, /\.lark-cli-config\.quarantine-|renameSync\([^)]*lark-cli-config/);
});

function registerPreload(temp, mode, returnedId = APP, returnedSecret = "canary-secret") {
  const preload = path.join(temp, `register-${mode}.cjs`);
  const channelMock = path.join(temp, `channel-${mode}.mjs`);
  const qrcodeMock = path.join(temp, `qrcode-${mode}.mjs`);
  const loader = path.join(temp, `loader-${mode}.mjs`);
  fs.writeFileSync(channelMock, `export async function registerApp(){ return {client_id:${JSON.stringify(returnedId)},client_secret:${JSON.stringify(returnedSecret)},user_info:{tenant_brand:"feishu",open_id:"ou_owner"}}; }`);
  fs.writeFileSync(qrcodeMock, `export default {generate(){}};`);
  fs.writeFileSync(preload, `
const cp=require("node:child_process"); const fs=require("node:fs"),path=require("node:path"); let verifyCalls=0;
cp.spawnSync=function(command,args,options={}){
  fs.appendFileSync(process.env.CALL_MARKER,JSON.stringify({command,args,larkConfigDir:options.env?.LARKSUITE_CLI_CONFIG_DIR,hasHermesHome:Object.hasOwn(options.env||{},"HERMES_HOME"),hasOpenClawHome:Object.hasOwn(options.env||{},"OPENCLAW_HOME"),hasLarkChannel:Object.keys(options.env||{}).some(key=>key==="LARK_CHANNEL"||key.startsWith("LARK_CHANNEL_")),secretViaStdin:options.input==="canary-secret"})+"\\n");
  if(command==="lark-cli" && args.includes("+chat-list")) { verifyCalls++; if((${JSON.stringify(mode)}==="sync-transient"&&verifyCalls<3)||${JSON.stringify(mode)}==="sync-transient-exhaust")return {status:3,stdout:"",stderr:JSON.stringify({ok:false,error:{subtype:"invalid_client",code:20048,message:"canary-secret must never be printed"}})};if(${JSON.stringify(mode)}==="sync-network"&&verifyCalls<2)return {status:1,stdout:"",stderr:"TypeError: fetch failed; cause: EAI_AGAIN canary-secret"};if(${JSON.stringify(mode)}==="sync-agent-context")return {status:1,stdout:"",stderr:JSON.stringify({ok:false,error:{subtype:"not_configured",message:"workspace is not configured canary-secret"}})};return {status:0,stdout:${JSON.stringify(mode === "verify-fail" ? JSON.stringify({ ok: false, identity: "bot" }) : JSON.stringify({ ok: true, identity: "bot", data: { chats: [] } }))},stderr:""}; }
  if(command===process.execPath){ fs.writeFileSync(process.env.BIND_MARKER,"bound"); if(${JSON.stringify(mode)}!=="bind-fail"){const root=process.env.LARKIN_CONFIG_DIR;fs.writeFileSync(path.join(root,"config.json"),JSON.stringify({version:4,serverId:"strict-register",activeAgent:${JSON.stringify(returnedId)},mentionPolicy:"require",agents:{[${JSON.stringify(returnedId)}]:{runtime:"codex",model:"gpt"}}}),{mode:0o600});} return {status:${mode === "bind-fail" ? 1 : 0},stdout:"",stderr:"bind failed"}; }
  return {status:0,stdout:"",stderr:""};
};
require("node:module").syncBuiltinESMExports();
module.exports={registerApp:async()=>({client_id:${JSON.stringify(returnedId)},client_secret:${JSON.stringify(returnedSecret)},user_info:{tenant_brand:"feishu",open_id:"ou_owner"}}),qrcode:{generate(){}},spawnSync:cp.spawnSync,wait:async()=>{},resolveOfficialLarkCli:()=>({command:"lark-cli",argsPrefix:[],version:"1.0.80"}),syncAgentProfile(agent,env){fs.appendFileSync(process.env.CALL_MARKER,JSON.stringify({command:"lark-cli",args:["config","bind","--source","lark-channel","--identity","bot-only"],larkConfigDir:agent.larkConfigDir,hasHermesHome:Object.hasOwn(env,"HERMES_HOME"),hasOpenClawHome:Object.hasOwn(env,"OPENCLAW_HOME"),hasLarkChannel:Object.keys(env).some(key=>key==="LARK_CHANNEL"||key.startsWith("LARK_CHANNEL_")),secretViaStdin:false})+"\\n");if(${JSON.stringify(mode)}==="sync-fail")throw new Error("bind failed canary-secret");const source=path.join(agent.stateDir,"lark-channel-source"),workspace=path.join(agent.larkConfigDir,"lark-channel");fs.mkdirSync(source,{recursive:true,mode:0o700});fs.mkdirSync(workspace,{recursive:true,mode:0o700});fs.writeFileSync(path.join(source,"config.json"),"{}",{mode:0o600});fs.writeFileSync(path.join(workspace,"config.json"),"{}",{mode:0o600});}};
`);
  fs.writeFileSync(loader, `import { mock } from "bun:test"; import { createRequire } from "node:module"; import * as channel from ${JSON.stringify(new URL(`file://${channelMock}`).href)}; import qrcode from ${JSON.stringify(new URL(`file://${qrcodeMock}`).href)}; process.env.LARKIN_TEST_BOT_REGISTER_MODULE=${JSON.stringify(preload)}; const require=createRequire(import.meta.url); require(${JSON.stringify(preload)}); const cp=require("node:child_process"), cpMock={...cp,spawnSync:cp.spawnSync,spawn:cp.spawn}; for(const id of ["node:child_process",import.meta.resolve("node:child_process")])mock.module(id,()=>cpMock); for(const id of ["@larksuite/channel",import.meta.resolve("@larksuite/channel")])mock.module(id,()=>channel); for(const id of ["qrcode-terminal",import.meta.resolve("qrcode-terminal")])mock.module(id,()=>({default:qrcode}));`);
  return { preload, loader };
}

test("bot-register binds once, then retries transient new-App Bot verification without exposing the secret", { timeout: TRANSIENT_VERIFY_TEST_TIMEOUT_MS }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-register-transient-sync-"));
  try {
    const root = path.join(temp, "root");
    const callMarker = path.join(temp, "calls.ndjson");
    const bindMarker = path.join(temp, "bound");
    const resultFile = path.join(root, ".setup-result-123.json");
    fs.mkdirSync(root, { recursive: true });
    const { preload, loader } = registerPreload(temp, "sync-transient");
    const result = spawnSync(process.execPath, ["--preload", loader, path.join(ROOT, "dist/setup/bot-register.mjs"), "--auto", "--result-file", resultFile], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: TRANSIENT_VERIFY_CHILD_TIMEOUT_MS,
      env: {
        ...process.env,
        HOME: path.join(temp, "home"),
        LARKIN_CONFIG_DIR: root,
        CALL_MARKER: callMarker,
        BIND_MARKER: bindMarker,
        HERMES_HOME: path.join(temp, "hermes"),
        OPENCLAW_HOME: path.join(temp, "openclaw"),
        LARK_CHANNEL: "1",
        LARK_CHANNEL_HOME: path.join(temp, "channel"),
        FAST_RETRY_TIMER: "1",
        LARKIN_TEST_BOT_REGISTER_MODULE: preload, BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" "),
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const calls = fs.readFileSync(callMarker, "utf8").trim().split("\n").map(JSON.parse);
    const configCalls = calls.filter((call) => call.command === "lark-cli" && call.args[0] === "config");
    assert.equal(configCalls.length, 1, "official workspace binding must run once");
    assert.deepEqual(configCalls[0].args, ["config", "bind", "--source", "lark-channel", "--identity", "bot-only"]);
    assert.equal(configCalls[0].secretViaStdin, false);
    const verifyCalls = calls.filter((call) => call.command === "lark-cli" && call.args.includes("+chat-list"));
    assert.equal(verifyCalls.length, 3, "invalid_client verification should retry twice then succeed");
    assert.equal(verifyCalls.every((call) => !call.hasHermesHome && !call.hasOpenClawHome && call.hasLarkChannel), true);
    assert.equal(fs.existsSync(path.join(root, "bots", `${APP}.json`)), true);
    assert.equal(fs.existsSync(bindMarker), true);
    assert.equal(fs.existsSync(resultFile), true);
    assert.doesNotMatch(result.stderr + result.stdout, /canary-secret/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

for (const [mode, expectedCalls, expectedStatus] of [["sync-network", 2, 0], ["sync-agent-context", 1, 1]]) {
  test(`bot-register classifies ${mode} Bot verification with the intended retry policy`, { timeout: 15_000 }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-strict-register-${mode}-`));
    try {
      const root = path.join(temp, "root");
      const callMarker = path.join(temp, "calls.ndjson");
      const bindMarker = path.join(temp, "bound");
      fs.mkdirSync(root, { recursive: true });
      const { preload, loader } = registerPreload(temp, mode);
      const result = spawnSync(process.execPath, ["--preload", loader, path.join(ROOT, "dist/setup/bot-register.mjs"), "--auto"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, CALL_MARKER: callMarker, BIND_MARKER: bindMarker, FAST_RETRY_TIMER: "1", LARKIN_TEST_BOT_REGISTER_MODULE: preload, BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" ") },
      });
      assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
      const calls = fs.readFileSync(callMarker, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(calls.filter((call) => call.command === "lark-cli" && call.args.includes("+chat-list")).length, expectedCalls);
      assert.equal(fs.existsSync(bindMarker), true);
      assert.doesNotMatch(result.stderr + result.stdout, /canary-secret/);
      if (mode === "sync-agent-context") assert.match(result.stderr, /lark-channel binding\/凭证校验失败/i);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}

test("bot-register bounds transient Bot verification retries and preserves authoritative binding state", { timeout: 10_000 }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-register-transient-exhaust-"));
  try {
    const root = path.join(temp, "root");
    const callMarker = path.join(temp, "calls.ndjson");
    const bindMarker = path.join(temp, "bound");
    const resultFile = path.join(root, ".setup-result-123.json");
    fs.mkdirSync(root, { recursive: true });
    const configFile = path.join(root, "config.json");
    fs.writeFileSync(configFile, JSON.stringify(storedConfig()), { mode: 0o600 });
    const configBefore = fs.readFileSync(configFile);
    const { preload, loader } = registerPreload(temp, "sync-transient-exhaust");
    const result = spawnSync(process.execPath, ["--preload", loader, path.join(ROOT, "dist/setup/bot-register.mjs"), "--auto", "--result-file", resultFile], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        HOME: path.join(temp, "home"),
        LARKIN_CONFIG_DIR: root,
        CALL_MARKER: callMarker,
        BIND_MARKER: bindMarker,
        FAST_RETRY_TIMER: "1",
        LARKIN_TEST_BOT_REGISTER_MODULE: preload, BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" "),
      },
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const calls = fs.readFileSync(callMarker, "utf8").trim().split("\n").map(JSON.parse);
    const configCalls = calls.filter((call) => call.command === "lark-cli" && call.args[0] === "config");
    assert.equal(configCalls.length, 1, "workspace binding must not be retried after it succeeds");
    assert.equal(calls.filter((call) => call.args.includes?.("+chat-list")).length, 7,
      "transient verification retry count must remain bounded to the 30-second propagation window");
    assert.equal(fs.existsSync(path.join(root, "bots", `${APP}.json`)), true);
    assert.equal(fs.existsSync(bindMarker), true);
    assert.equal(fs.existsSync(resultFile), false);
    assert.notDeepEqual(fs.readFileSync(configFile), configBefore);
    assert.match(result.stderr, /lark-channel binding\/凭证校验失败/i);
    assert.doesNotMatch(result.stderr + result.stdout, /canary-secret/);
    const profileDirs = [...new Set(configCalls.map((call) => call.larkConfigDir))];
    assert.equal(profileDirs.length, 1);
    assert.equal(fs.existsSync(profileDirs[0]), true, "successful Agent binding remains recoverable after verification exhaustion");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("bot-register rejects an unsafe returned App ID before any local or lark-cli write", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-register-app-id-"));
  try {
    const root = path.join(temp, "root");
    fs.mkdirSync(root, { recursive: true });
    const { preload, loader } = registerPreload(temp, "ok", [APP]);
    const result = spawnSync(process.execPath, ["--preload", loader, path.join(ROOT, "dist/setup/bot-register.mjs"), "--auto"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, CALL_MARKER: path.join(temp, "calls"), BIND_MARKER: path.join(temp, "bind"), LARKIN_TEST_BOT_REGISTER_MODULE: preload, BUN_OPTIONS: `--preload=${preload}` },
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(fs.existsSync(path.join(temp, "calls")), false);
    assert.equal(fs.existsSync(path.join(temp, "bind")), false);
    assert.equal(fs.existsSync(path.join(temp, "escape.json")), false);
    assert.match(result.stderr + result.stdout, /App ID.*\u683c\u5f0f\u975e\u6cd5/i);
    assert.doesNotMatch(result.stderr + result.stdout, /canary-secret/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("bot-register rejects a non-string returned secret before lark-cli or local writes", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-register-secret-type-"));
  try {
    const root = path.join(temp, "root");
    fs.mkdirSync(root, { recursive: true });
    const { preload, loader } = registerPreload(temp, "ok", APP, { value: "canary-secret" });
    const callMarker = path.join(temp, "calls");
    const result = spawnSync(process.execPath, ["--preload", loader, path.join(ROOT, "dist/setup/bot-register.mjs"), "--auto"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, CALL_MARKER: callMarker, BIND_MARKER: path.join(temp, "bind"), LARKIN_TEST_BOT_REGISTER_MODULE: preload, BUN_OPTIONS: `--preload=${preload}` },
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(fs.existsSync(callMarker), false);
    assert.equal(fs.existsSync(path.join(root, "bots", `${APP}.json`)), false);
    assert.doesNotMatch(result.stderr + result.stdout, /canary-secret/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("bot-register rejects the removed explicit App ID option before registration or local writes", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-register-target-"));
  try {
    const root = path.join(temp, "root");
    fs.mkdirSync(root, { recursive: true });
    const returned = "cli_otherA1";
    const { preload, loader } = registerPreload(temp, "ok", returned);
    const callMarker = path.join(temp, "calls");
    const result = spawnSync(process.execPath, ["--preload", loader, path.join(ROOT, "dist/setup/bot-register.mjs"), "--app-id", APP], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, CALL_MARKER: callMarker, BIND_MARKER: path.join(temp, "bind"), LARKIN_TEST_BOT_REGISTER_MODULE: preload, BUN_OPTIONS: `--preload=${preload}` },
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(fs.existsSync(callMarker), false);
    assert.equal(fs.existsSync(path.join(temp, "bind")), false);
    assert.equal(fs.existsSync(path.join(root, "bots")), false);
    assert.equal(fs.existsSync(path.join(root, "bots", `${returned}.json`)), false);
    assert.match(result.stderr + result.stdout, /\u4e0d\u652f\u6301 --app-id/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("bot-register rejects result-file paths outside the config root before registration", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-register-result-path-"));
  try {
    const root = path.join(temp, "root");
    fs.mkdirSync(root, { recursive: true });
    const { preload, loader } = registerPreload(temp, "ok");
    const callMarker = path.join(temp, "calls");
    const outside = path.join(temp, ".setup-result-123.json");
    const result = spawnSync(process.execPath, ["--preload", loader, path.join(ROOT, "dist/setup/bot-register.mjs"), "--auto", "--result-file", outside], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, CALL_MARKER: callMarker, BIND_MARKER: path.join(temp, "bind"), LARKIN_TEST_BOT_REGISTER_MODULE: preload, BUN_OPTIONS: `--preload=${preload}` },
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(fs.existsSync(callMarker), false);
    assert.equal(fs.existsSync(outside), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

for (const kind of ["symlink", "mode"]) {
  test(`bot-register rejects unsafe bots directory (${kind}) before secret sync or external mutation`, { timeout: 10_000 }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-strict-register-bots-${kind}-`));
    try {
      const root = path.join(temp, "root");
      fs.mkdirSync(root, { recursive: true });
      const target = path.join(temp, "outside-bots");
      fs.mkdirSync(target, { mode: 0o700 });
      fs.writeFileSync(path.join(target, "sentinel"), "unchanged");
      if (kind === "symlink") fs.symlinkSync(target, path.join(root, "bots"));
      else { fs.mkdirSync(path.join(root, "bots"), { mode: 0o755 }); fs.chmodSync(path.join(root, "bots"), 0o755); }
      const before = fs.readdirSync(target).join(",") + fs.readFileSync(path.join(target, "sentinel"), "utf8");
      const { preload, loader } = registerPreload(temp, "ok");
      const callMarker = path.join(temp, "calls");
      const result = spawnSync(process.execPath, ["--preload", loader, path.join(ROOT, "dist/setup/bot-register.mjs"), "--auto"], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME:path.join(temp,"home"), LARKIN_CONFIG_DIR:root, CALL_MARKER:callMarker, BIND_MARKER:path.join(temp,"bind"), LARKIN_TEST_BOT_REGISTER_MODULE: preload, BUN_OPTIONS:`--preload=${preload}` },
      });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.equal(fs.existsSync(callMarker), false);
      assert.equal(fs.readdirSync(target).join(",") + fs.readFileSync(path.join(target, "sentinel"), "utf8"), before);
      assert.doesNotMatch(result.stderr + result.stdout, /canary-secret/);
    } finally { fs.rmSync(temp, { recursive:true, force:true }); }
  });
}

for (const existing of [false, true]) {
  test(`bot-register bind failure preserves authoritative new credential and ${existing ? "existing" : "absent"} config`, { timeout: 10_000 }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-strict-register-bind-${existing}-`));
    try {
      const root = path.join(temp, "root");
      fs.mkdirSync(root, { recursive: true });
      const configFile = path.join(root, "config.json");
      const botFile = path.join(root, "bots", `${APP}.json`);
      if (existing) {
        fs.writeFileSync(configFile, JSON.stringify(storedConfig()), { mode: 0o600 });
        writeCredential(root, JSON.stringify({ appId: APP, appSecret: "old-secret", tenant: "feishu" }));
      }
      const beforeConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile) : null;
      const beforeBot = fs.existsSync(botFile) ? fs.readFileSync(botFile) : null;
      const { preload, loader } = registerPreload(temp, "bind-fail");
      const resultFile = path.join(root, ".setup-result-123.json");
      const result = spawnSync(process.execPath, ["--preload", loader, path.join(ROOT, "dist/setup/bot-register.mjs"), "--auto", "--result-file", resultFile], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, CALL_MARKER: path.join(temp, "calls"), BIND_MARKER: path.join(temp, "bind"), CONFIG_FILE: configFile, LARKIN_TEST_BOT_REGISTER_MODULE: preload, BUN_OPTIONS: `--preload=${preload}` },
      });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.deepEqual(fs.existsSync(configFile) ? fs.readFileSync(configFile) : null, beforeConfig);
      const published = JSON.parse(fs.readFileSync(botFile, "utf8"));
      assert.equal(published.appSecret, "canary-secret");
      assert.equal(fs.existsSync(resultFile), false);
      assert.doesNotMatch(result.stderr + result.stdout, /canary-secret|old-secret/);
      assert.match(result.stderr, /\u72b6\u6001\u5df2\u4fdd\u7559|\u91cd\u8dd1.*setup|\u91cd\u8bd5.*setup/i);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}

test("bot-register result publication failure preserves successful binding and authoritative credential", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-register-result-"));
  try {
    const root = path.join(temp, "root");
    fs.mkdirSync(root, { recursive: true });
    const configFile = path.join(root, "config.json");
    const botFile = path.join(root, "bots", `${APP}.json`);
    fs.writeFileSync(configFile, JSON.stringify(storedConfig()), { mode: 0o600 });
    writeCredential(root, JSON.stringify({ appId: APP, appSecret: "old-secret", tenant: "feishu" }));
    const beforeConfig = fs.readFileSync(configFile);
    const beforeBot = fs.readFileSync(botFile);
    const resultFile = path.join(root, ".setup-result-123.json");
    fs.writeFileSync(resultFile, "sentinel");
    const { preload, loader } = registerPreload(temp, "ok");
    const result = spawnSync(process.execPath, ["--preload", loader, path.join(ROOT, "dist/setup/bot-register.mjs"), "--auto", "--result-file", resultFile], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, CALL_MARKER: path.join(temp, "calls"), BIND_MARKER: path.join(temp, "bind"), CONFIG_FILE: configFile, LARKIN_TEST_BOT_REGISTER_MODULE: preload, BUN_OPTIONS: `--preload=${preload}` },
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).agents[APP].runtime, "codex");
    assert.equal(JSON.parse(fs.readFileSync(botFile, "utf8")).appSecret, "canary-secret");
    assert.equal(fs.readFileSync(resultFile, "utf8"), "sentinel");
    assert.doesNotMatch(result.stderr + result.stdout, /canary-secret|old-secret/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

for (const mode of ["sync-fail", "verify-fail"]) {
  test(`bot-register ${mode} preserves the authoritative credential and Agent binding for recovery`, { timeout: 10_000 }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-strict-register-${mode}-`));
    try {
      const root = path.join(temp, "root");
      const resultFile = path.join(root, ".setup-result-123.json");
      const bindMarker = path.join(temp, "bound");
      const callMarker = path.join(temp, "calls.ndjson");
      fs.mkdirSync(root, { recursive: true });
      const { preload, loader } = registerPreload(temp, mode);
      const result = spawnSync(process.execPath, ["--preload", loader, path.join(ROOT, "dist/setup/bot-register.mjs"), "--auto", "--result-file", resultFile], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_CONFIG_DIR: root, CALL_MARKER: callMarker, BIND_MARKER: bindMarker, LARKIN_TEST_BOT_REGISTER_MODULE: preload, BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" ") },
      });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.equal(fs.existsSync(path.join(root, "bots", `${APP}.json`)), true);
      assert.equal(fs.existsSync(bindMarker), true);
      assert.equal(fs.existsSync(resultFile), false);
      assert.doesNotMatch(result.stderr + result.stdout, /canary-secret/);
      const calls = fs.readFileSync(callMarker, "utf8").trim().split("\n").map(JSON.parse);
      const profileDirs = [...new Set(calls.filter((call) => call.command === "lark-cli").map((call) => call.larkConfigDir))];
      assert.equal(profileDirs.length, 1);
      assert.notEqual(profileDirs[0], path.join(root, "lark-cli-config"));
      const larkCalls = calls.filter((call) => call.command === "lark-cli");
      assert.equal(larkCalls.filter((call) => call.args.includes("+chat-list"))
        .every((call) => !call.hasHermesHome && !call.hasOpenClawHome && call.hasLarkChannel), true);
      if (mode === "sync-fail") {
        assert.equal(larkCalls.filter((call) => call.args[0] === "config").length, 1, "permanent sync failure must not retry");
        assert.match(result.stderr, /lark-channel binding\/凭证校验失败/i);
      }
      const verifyCall = calls.find((call) => call.command === "lark-cli" && call.args.includes("+chat-list"));
      if (mode === "verify-fail") assert.deepEqual(verifyCall.args.slice(-2), ["--as", "bot"]);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}

test("host exits nonzero and records status when channel authentication fails; no consume fallback is spawned", { timeout: 10_000 }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-host-channel-"));
  try {
    const root = path.join(temp, "root");
    const stateDir = path.join(root, "state", "agents", APP);
    const workspaceDir = path.join(root, "agents", APP);
    const spawnMarker = path.join(temp, "spawn.ndjson");
    fs.mkdirSync(stateDir, { recursive: true });
    const preload = path.join(temp, "channel-failure.cjs");
    fs.writeFileSync(preload, `
const Module=require("node:module"); const cp=require("node:child_process"); const fs=require("node:fs"); const {EventEmitter}=require("node:events"); const {PassThrough}=require("node:stream"); const original=Module._load;
Module._load=function(request,parent,isMain){ if(request==="@larksuite/channel") return {createLarkChannel(){ return {on(){},dispatcher:{register(){}},connect(){return Promise.reject(new Error("unauthorized secret"));},disconnect(){return new Promise(()=>{});},rawClient:null,botIdentity:null}; }}; return original.call(this,request,parent,isMain); };
cp.spawn=function(command,args){ fs.appendFileSync(process.env.SPAWN_MARKER,JSON.stringify({command,args})+"\\n"); const c=new EventEmitter(); c.stdout=new PassThrough(); c.kill=()=>{}; return c; };
cp.execFile=function(_c,_a,_o,cb){ cb(new Error("mocked"),"",""); };
require("node:module").syncBuiltinESMExports();
`);
    const agents = [{ name: APP, agentId: APP, feishuAppId: APP, feishuProfile: APP, runtime: "codex", model: "gpt", workspaceDir, stateDir, larkConfigDir: path.join(root, "lark-cli-config"), feishuAppSecret: "secret", feishuDomain: "https://open.feishu.cn" }];
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, ["--eval", `require(${JSON.stringify(path.join(ROOT, "test/support/host-shell-test-harness.cjs"))})`], {
      cwd: ROOT, encoding: "utf8", timeout: 6_000,
      env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-strict", LARKIN_AGENTS_CONFIG: JSON.stringify(agents), SPAWN_MARKER: spawnMarker, LARKIN_TEST_CHANNEL_PACKAGE_MODULE: preload },
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.ok(Date.now() - startedAt < 5_500, "fatal channel shutdown must be bounded even when disconnect never settles");
    assert.equal(fs.existsSync(spawnMarker), false, "channel failure must not spawn lark-cli consume");
    const status = JSON.parse(fs.readFileSync(path.join(stateDir, "status.json"), "utf8"));
    assert.match(JSON.stringify(status.recentErrors || []), /channel|unauthorized|认证|连接/i);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

for (const mode of ["bind-fail", "workspace-mismatch"]) {
  test(`run fails closed when Agent lark-channel ${mode} and never spawns daemon`, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-strict-run-profile-${mode}-`));
    try {
      const root = path.join(temp, "root");
      writeConfig(root);
      writeCredential(root, JSON.stringify({ appId: APP, appSecret: "secret-value", tenant: "feishu" }));
      const preload = path.join(temp, "profile.cjs");
      const spawnMarker = path.join(temp, "spawned");
      const callMarker = path.join(temp, "calls.json");
      const packageDir = path.join(temp, "official", "node_modules", "@larksuite", "cli");
      const official = path.join(packageDir, "scripts", "run.sh");
      const fixtureBin = path.join(temp, "bin");
      fs.mkdirSync(path.dirname(official), { recursive: true, mode: 0o700 });
      fs.mkdirSync(fixtureBin, { mode: 0o700 });
      fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@larksuite/cli", version: "1.0.80", bin: { "lark-cli": "scripts/run.sh" } }), { mode: 0o600 });
      fs.writeFileSync(official, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
      fs.symlinkSync(official, path.join(fixtureBin, "lark-cli"));
      fs.writeFileSync(preload, `const cp=require("node:child_process"),fs=require("node:fs"),path=require("node:path"),original=cp.spawnSync; cp.spawn=()=>{fs.writeFileSync(process.env.SPAWN_MARKER,"yes");throw new Error("daemon spawn reached")}; cp.spawnSync=(command,args,options={})=>{if(args?.[0]==="-lc"&&String(args?.[1]).includes("command -v lark-cli"))return {status:0,stdout:process.env.OFFICIAL_CLI+"\\n",stderr:""};let pinned=false;try{pinned=fs.realpathSync(String(command))===fs.realpathSync(process.env.OFFICIAL_CLI)}catch{}if(!pinned)return original(command,args,options);const cli=args;if(cli[0]==="--version")return {status:0,stdout:"1.0.80\\n",stderr:""};if(cli[0]==="config"&&cli[1]==="bind"&&cli[2]==="--help")return {status:0,stdout:"Usage: config bind --source lark-channel --identity bot-only\\n",stderr:""};fs.appendFileSync(process.env.CALL_MARKER,JSON.stringify({command:"official-global",args:cli,secretViaStdin:options.input==="secret-value"})+"\\n");if(cli[0]==="config"&&cli[1]==="bind"){if(${JSON.stringify(mode)}==="bind-fail")return {status:1,stdout:"",stderr:"secret-value"};const source=JSON.parse(fs.readFileSync(options.env.LARK_CHANNEL_CONFIG,"utf8")),id=source.accounts.app.id,dir=path.join(options.env.LARKSUITE_CLI_CONFIG_DIR,"lark-channel");fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,"config.json"),JSON.stringify({apps:[{appId:${JSON.stringify(mode)}==="workspace-mismatch"?"cli_wrong":id,appSecret:{source:"keychain",id:"appsecret:"+id},defaultAs:"bot",strictMode:"bot",users:[]}]}),{mode:0o600});}return {status:0,stdout:"",stderr:""};};require("node:module").syncBuiltinESMExports();`);
      const result = spawnSync(process.execPath, [path.join(ROOT, "dist/app/run.mjs")], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: path.join(temp, "home"), SHELL: "/bin/sh", PATH: `${fixtureBin}:${process.env.PATH || "/usr/bin:/bin"}`, OFFICIAL_CLI: path.join(fixtureBin, "lark-cli"), LARKIN_CONFIG_DIR: root, SPAWN_MARKER: spawnMarker, CALL_MARKER: callMarker, BUN_OPTIONS: `--preload=${preload}` },
      });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.equal(fs.existsSync(spawnMarker), false);
      assert.equal(fs.existsSync(callMarker), true, result.stderr || result.stdout);
      const calls = fs.readFileSync(callMarker, "utf8").trim().split("\n").map(JSON.parse);
      const bindCall = calls.find((call) => call.command === "official-global" && call.args[0] === "config");
      assert.deepEqual(bindCall?.args, ["config", "bind", "--source", "lark-channel", "--identity", "bot-only"]);
      assert.equal(bindCall?.secretViaStdin, false, JSON.stringify({ calls, output: result.stderr + result.stdout }));
      assert.doesNotMatch(result.stderr + result.stdout, /secret-value/);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}

test("production host rejects EVENT_CMD/FILE injection without an explicit dry-run gate", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-event-prod-"));
  try {
    const root = path.join(temp, "root");
    const stateDir = path.join(root, "state", "agents", APP);
    const workspaceDir = path.join(root, "agents", APP);
    const eventFile = path.join(temp, "events.ndjson");
    const agents = [{ name: APP, agentId: APP, feishuAppId: APP, feishuProfile: APP, runtime: "codex", model: "gpt", workspaceDir, stateDir, larkConfigDir: path.join(root, "lark-cli-config") }];
    const result = spawnSync(process.execPath, ["--eval", `require(${JSON.stringify(path.join(ROOT, "test/support/host-shell-test-harness.cjs"))})`], {
      cwd: ROOT, encoding: "utf8", timeout: 4_000,
      env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-strict", LARKIN_AGENTS_CONFIG: JSON.stringify(agents), LARKIN_FEISHU_EVENT_FILE: eventFile },
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr + result.stdout, /dry.?run|DRYRUN|\u6d4b\u8bd5\u6ce8\u5165/i);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("dry-run EVENT_FILE injection takes precedence over profile channel startup", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-event-dryrun-"));
  try {
    const root = path.join(temp, "root");
    const stateDir = path.join(root, "state", "agents", APP);
    const workspaceDir = path.join(root, "agents", APP);
    const eventFile = path.join(temp, "events.ndjson");
    const marker = path.join(temp, "channel-started");
    const preload = path.join(temp, "no-channel.cjs");
    fs.writeFileSync(preload, `const fs=require("node:fs"); module.exports={createLarkChannel(){fs.writeFileSync(process.env.CHANNEL_MARKER,"yes");throw new Error("channel must not start")}};`);
    const agents = [{ name: APP, agentId: APP, feishuAppId: APP, feishuProfile: APP, runtime: "codex", model: "gpt", workspaceDir, stateDir, larkConfigDir: path.join(root, "lark-cli-config") }];
    const result = spawnSync(process.execPath, ["--eval", `require(${JSON.stringify(path.join(ROOT, "test/support/host-shell-test-harness.cjs"))})`], {
      cwd: ROOT, encoding: "utf8", timeout: 3_000,
      env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-strict", LARKIN_AGENTS_CONFIG: JSON.stringify(agents), LARKIN_FEISHU_EVENT_FILE: eventFile, LARKIN_FEISHU_DRYRUN: "1", CHANNEL_MARKER: marker, LARKIN_TEST_CHANNEL_PACKAGE_MODULE: preload },
    });
    assert.equal(result.error?.code, "ETIMEDOUT");
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

for (const scenario of ["keepalive", "missing-identity"]) {
  test(`host routes ${scenario} failure through status recording and bounded fatal shutdown`, { timeout: 10_000 }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-strict-channel-${scenario}-`));
    try {
      const root = path.join(temp, "root");
      const stateDir = path.join(root, "state", "agents", APP);
      const workspaceDir = path.join(root, "agents", APP);
      const preload = path.join(temp, "channel.cjs");
      fs.writeFileSync(preload, `module.exports={createLarkChannel(options){
  const channel={on(){},dispatcher:{register(){}},disconnect(){return new Promise(()=>{});},rawClient:null,botIdentity:${scenario === "missing-identity" ? "null" : "{openId:'ou_bot',name:'bot'}"}};
  channel.connect=function(){${scenario === "keepalive" ? "setTimeout(()=>options.keepalive.onUnrecoverable(new Error('canary-secret')),10); return new Promise(()=>{});" : "return Promise.resolve();"}};
  return channel;
}};`);
      const agents = [{ name: APP, agentId: APP, feishuAppId: APP, feishuProfile: APP, runtime: "codex", model: "gpt", workspaceDir, stateDir, larkConfigDir: path.join(root, "lark-cli-config"), feishuAppSecret: "credential-canary", feishuDomain: "https://open.feishu.cn" }];
      const result = spawnSync(process.execPath, ["--eval", `require(${JSON.stringify(path.join(ROOT, "test/support/host-shell-test-harness.cjs"))})`], {
        cwd: ROOT, encoding: "utf8", timeout: 6_000,
        env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-strict", LARKIN_AGENTS_CONFIG: JSON.stringify(agents), LARKIN_TEST_CHANNEL_PACKAGE_MODULE: preload },
      });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.doesNotMatch(result.stderr + result.stdout, /canary-secret|credential-canary/);
      const status = JSON.parse(fs.readFileSync(path.join(stateDir, "status.json"), "utf8"));
      assert.match(JSON.stringify(status.recentErrors || []), /channel.*\u4e0d\u53ef\u7528/i);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}

test("host disconnects a transiently failed channel before scheduling retry", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-channel-retry-"));
  try {
    const root = path.join(temp, "root");
    const stateDir = path.join(root, "state", "agents", APP);
    const workspaceDir = path.join(root, "agents", APP);
    const marker = path.join(temp, "disconnected");
    const preload = path.join(temp, "channel.cjs");
    fs.writeFileSync(preload, `const fs=require("node:fs"); module.exports={createLarkChannel(){return {on(){},dispatcher:{register(){}},connect(){return Promise.reject(new Error("temporary network canary"));},disconnect(){fs.writeFileSync(process.env.DISCONNECT_MARKER,"yes")},rawClient:null,botIdentity:null}}};`);
    const agents = [{ name: APP, agentId: APP, feishuAppId: APP, feishuProfile: APP, runtime: "codex", model: "gpt", workspaceDir, stateDir, larkConfigDir: path.join(root, "lark-cli-config"), feishuAppSecret: "credential-canary", feishuDomain: "https://open.feishu.cn" }];
    const result = spawnSync(process.execPath, ["--eval", `require(${JSON.stringify(path.join(ROOT, "test/support/host-shell-test-harness.cjs"))})`], {
      cwd: ROOT, encoding: "utf8", timeout: 3_500,
      env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-strict", LARKIN_AGENTS_CONFIG: JSON.stringify(agents), DISCONNECT_MARKER: marker, LARKIN_TEST_CHANNEL_PACKAGE_MODULE: preload },
    });
    assert.equal(result.error?.code, "ETIMEDOUT");
    assert.equal(fs.existsSync(marker), true);
    assert.doesNotMatch(result.stderr + result.stdout, /temporary network canary|credential-canary/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

for (const disconnectMode of ["pending", "reject"]) {
  test(`host treats transient channel disconnect ${disconnectMode} as fatal and never creates a replacement`, { timeout: 30_000 }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-strict-channel-disconnect-${disconnectMode}-`));
    try {
      const root = path.join(temp, "root");
      const stateDir = path.join(root, "state", "agents", APP);
      const workspaceDir = path.join(root, "agents", APP);
      const marker = path.join(temp, "creates");
      const preload = path.join(temp, "channel.cjs");
      fs.writeFileSync(preload, `const fs=require("node:fs"); module.exports={createLarkChannel(){fs.appendFileSync(process.env.CREATE_MARKER,"1");return {on(){},dispatcher:{register(){}},connect(){return Promise.reject(new Error("temporary network"));},disconnect(){${disconnectMode === "pending" ? "return new Promise(()=>{});" : "return Promise.reject(new Error('disconnect failed'));"}},rawClient:null,botIdentity:null}}};`);
      const agents = [{ name: APP, agentId: APP, feishuAppId: APP, feishuProfile: APP, runtime: "codex", model: "gpt", workspaceDir, stateDir, larkConfigDir: path.join(root, "lark-cli-config"), feishuAppSecret: "secret", feishuDomain: "https://open.feishu.cn" }];
      const result = spawnSync(process.execPath, ["--eval", `require(${JSON.stringify(path.join(ROOT, "test/support/host-shell-test-harness.cjs"))})`], {
        cwd: ROOT, encoding: "utf8", timeout: 8_000,
        env: { ...process.env, HOME: path.join(temp, "home"), LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-strict", LARKIN_AGENTS_CONFIG: JSON.stringify(agents), CREATE_MARKER: marker, LARKIN_TEST_CHANNEL_PACKAGE_MODULE: preload },
      });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.equal(fs.readFileSync(marker, "utf8"), "1");
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}

test("synchronous channel creation failure stops multi-agent startup and closes earlier channels", { timeout: 10_000 }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-strict-channel-multi-create-"));
  try {
    const root = path.join(temp, "root");
    const count = path.join(temp, "count");
    const closed = path.join(temp, "closed");
    const preload = path.join(temp, "channel.cjs");
    fs.writeFileSync(preload, `const fs=require("node:fs"); let n=0; module.exports={createLarkChannel(){n++;fs.writeFileSync(process.env.COUNT_MARKER,String(n));if(n===2)throw new Error("sync create failed");return {on(){},dispatcher:{register(){}},connect(){return new Promise(()=>{})},disconnect(){fs.writeFileSync(process.env.CLOSED_MARKER,"yes")},rawClient:null,botIdentity:null}}};`);
    const agents = ["cli_multiA1", "cli_multiB2", "cli_multiC3"].map((id) => ({ name:id, agentId:id, feishuAppId:id, feishuProfile:id, runtime:"codex", model:"gpt", workspaceDir:path.join(root,"agents",id), stateDir:path.join(root,"state","agents",id), larkConfigDir:path.join(root,"lark-cli-config"), feishuAppSecret:"secret", feishuDomain:"https://open.feishu.cn" }));
    const result = spawnSync(process.execPath, ["--eval", `require(${JSON.stringify(path.join(ROOT, "test/support/host-shell-test-harness.cjs"))})`], {
      cwd: ROOT, encoding: "utf8", timeout: 6_000,
      env: { ...process.env, HOME:path.join(temp,"home"), LARKIN_HOME:root, LARKIN_CONFIG_DIR:root, LARKIN_SERVER_ID:"server-strict", LARKIN_AGENTS_CONFIG:JSON.stringify(agents), COUNT_MARKER:count, CLOSED_MARKER:closed, LARKIN_TEST_CHANNEL_PACKAGE_MODULE:preload },
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(count, "utf8"), "2");
    assert.equal(fs.existsSync(closed), true);
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
});
