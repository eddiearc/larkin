import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { syncAgentProfileAsync } from "../../../dist/app/runtime-agent-config.mjs";
import {
  beginBuiltinPiCredentialTransaction,
  createOfficialPiCredentialRuntime,
  createOfficialPiModelRuntime,
  createOfficialPiLogoutRuntime,
  createOfficialPiRegistryRuntime,
  createOfficialPiAuthInteraction,
  listOfficialPiAuthProviders,
  logoutOfficialPiProvider,
  officialPiAuthStatus,
  runOfficialPiLogin,
} from "../../../dist/runtime/pi-official-auth.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

function provider(id, name, options = {}) {
  return {
    id, name, auth: {
      ...(options.apiKey === false ? {} : { apiKey: { name: options.apiKeyName || `${name} key`, ...(options.apiKeyLogin === false ? {} : { login() {} }) } }),
      ...(options.oauth ? { oauth: { name: options.oauthName || `${name} subscription`, login() {}, refresh() {}, toAuth() {} } } : {}),
    },
    getModels: () => options.models || [], stream() {}, streamSimple() {},
  };
}

test("official Pi auth registry projection is dynamic and preserves every login-capable method", async () => {
  const fake = { getProviders: () => [
    provider("alpha", "Alpha", { oauth: true, models: [{ provider: "alpha", id: "a-1" }] }),
    provider("ambient", "Ambient", { apiKeyLogin: false }),
    provider("oauth-only", "OAuth only", { apiKey: false, oauth: true }),
  ] };
  assert.deepEqual(listOfficialPiAuthProviders(fake), [
    { id: "alpha", name: "Alpha", methods: [
      { type: "api_key", name: "Alpha key" }, { type: "oauth", name: "Alpha subscription" },
    ], models: ["alpha/a-1"], ambientOnly: false },
    { id: "ambient", name: "Ambient", methods: [], models: [], ambientOnly: true },
    { id: "oauth-only", name: "OAuth only", methods: [{ type: "oauth", name: "OAuth only subscription" }], models: [], ambientOnly: false },
  ]);

  const official = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const projected = listOfficialPiAuthProviders(official);
  const expected = official.getProviders().map((entry) => ({
    id: entry.id,
    types: [entry.auth.apiKey?.login ? "api_key" : null, entry.auth.oauth?.login ? "oauth" : null].filter(Boolean),
  }));
  assert.deepEqual(projected.map((entry) => ({ id: entry.id, types: entry.methods.map((method) => method.type) })), expected);
});

test("auth interaction bridges all official prompt and event variants without echoing secrets", async () => {
  const asked = [];
  const secrets = [];
  const reports = [];
  const opened = [];
  const answers = ["text value", "2"];
  const interaction = createOfficialPiAuthInteraction({
    questioner: {
      ask: async (prompt) => { asked.push(prompt); return answers.shift(); },
      secret: async (prompt) => { secrets.push(prompt); return prompt.includes("manual") ? "manual-value" : "secret-value"; },
    },
    report: (message) => reports.push(message),
    openUrl: (url) => { opened.push(url); return true; },
  });
  assert.equal(await interaction.prompt({ type: "text", message: "text" }), "text value");
  assert.equal(await interaction.prompt({ type: "secret", message: "secret" }), "secret-value");
  assert.equal(await interaction.prompt({ type: "select", message: "select", options: [
    { id: "first", label: "First" }, { id: "second", label: "Second", description: "desc" },
  ] }), "second");
  assert.equal(await interaction.prompt({ type: "manual_code", message: "manual" }), "manual-value");
  interaction.notify({ type: "info", message: "info", links: [{ url: "https://info.example/path?token=hidden", label: "docs" }] });
  interaction.notify({ type: "auth_url", url: "https://login.example/authorize?state=hidden", instructions: "open it" });
  interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://device.example/activate", intervalSeconds: 5 });
  interaction.notify({ type: "progress", message: "waiting" });
  assert.deepEqual(opened, ["https://login.example/authorize?state=hidden"]);
  assert.match(asked.join("\n"), /text[\s\S]*First[\s\S]*Second[\s\S]*desc/);
  assert.match(secrets.join("\n"), /secret[\s\S]*manual/);
  const output = reports.join("\n");
  assert.match(output, /info[\s\S]*docs: https:\/\/info\.example\/path/);
  assert.match(output, /ABCD-EFGH[\s\S]*https:\/\/device\.example\/activate[\s\S]*waiting/);
  assert.doesNotMatch(output, /token=hidden|state=hidden|secret-value|manual-value/);

  const fallback = [];
  const manual = createOfficialPiAuthInteraction({
    questioner: { ask: async () => "", secret: async () => "" },
    report: (message) => fallback.push(message), openUrl: () => false,
  });
  manual.notify({ type: "auth_url", url: "https://login.example/authorize?state=copy-me" });
  assert.match(fallback.join("\n"), /请复制完整登录地址: https:\/\/login\.example\/authorize\?state=copy-me/);
});

test("official login delegates to ModelRuntime and cancellation reaches the provider signal", async () => {
  const calls = [];
  const runtime = { login: async (...args) => { calls.push(args); return { type: "oauth", access: "hidden", refresh: "hidden", expires: 1 }; } };
  const interaction = { prompt: async () => "unused", notify() {} };
  const credential = await runOfficialPiLogin(runtime, "alpha", "oauth", interaction);
  assert.equal(credential.type, "oauth");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "alpha");
  assert.equal(calls[0][1], "oauth");
  assert.equal(calls[0][2], interaction);

  const controller = new AbortController();
  controller.abort();
  const cancelled = createOfficialPiAuthInteraction({
    questioner: { ask: async () => "never", secret: async () => "never" }, report() {}, signal: controller.signal,
  });
  await assert.rejects(() => cancelled.prompt({ type: "text", message: "cancelled" }), /cancel/i);
});

test("credential transaction restores exact bytes and preserves other Agents/providers", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-official-auth-"));
  try {
    fs.chmodSync(temp, 0o700);
    const transaction = beginBuiltinPiCredentialTransaction(temp, "cli_authA1");
    const directory = transaction.directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "auth.json"), '{"alpha":{"type":"api_key","key":"changed"}}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "models-store.json"), '{"changed":true}\n', { mode: 0o600 });
    const other = path.join(temp, "providers", "pi", "cli_otherA1");
    fs.mkdirSync(other, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(other, "auth.json"), "other-agent", { mode: 0o600 });
    transaction.rollback();
    assert.equal(fs.existsSync(path.join(directory, "auth.json")), false);
    assert.equal(fs.existsSync(path.join(directory, "models-store.json")), false);
    assert.equal(fs.existsSync(directory), false, "new Agent rollback must restore the provider directory to absent");
    assert.equal(fs.readFileSync(path.join(other, "auth.json"), "utf8"), "other-agent");
    const noState = beginBuiltinPiCredentialTransaction(temp, "cli_noStateA1");
    const noStateDirectory = noState.directory;
    noState.commit();
    assert.equal(fs.existsSync(noStateDirectory), false, "no-state commit must restore a new provider directory to absent");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("status is non-sensitive and logout delegates to the official runtime only for the target provider", async () => {
  const runtime = {
    getProviders: () => [provider("alpha", "Alpha"), provider("beta", "Beta")],
    listCredentials: async () => [
      { providerId: "alpha", type: "oauth" }, { providerId: "beta", type: "api_key" },
    ],
    checkAuth: async (id) => ({ type: id === "alpha" ? "oauth" : "api_key", source: id === "alpha" ? "OAuth" : "stored credential" }),
    logout: async (id) => { runtime.loggedOut = id; },
  };
  assert.deepEqual(await officialPiAuthStatus(runtime), [
    { providerId: "alpha", providerName: "Alpha", credentialType: "oauth", source: "OAuth", stored: true },
    { providerId: "beta", providerName: "Beta", credentialType: "api_key", source: "stored credential", stored: true },
  ]);
  await logoutOfficialPiProvider(runtime, "alpha");
  assert.equal(runtime.loggedOut, "alpha");
});

test("registry, status, and logout never execute stored API-key commands or create read-only files", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-safe-auth-"));
  const marker = path.join(temp, "command-marker");
  try {
    fs.chmodSync(temp, 0o700);
    const absentAgent = "cli_absentAuthA1";
    const absentDirectory = path.join(temp, "providers", "pi", absentAgent);
    const registry = await createOfficialPiRegistryRuntime();
    assert.ok(listOfficialPiAuthProviders(registry).length > 0);
    assert.equal(fs.existsSync(absentDirectory), false, "registry enumeration must not create an Agent store");
    const absentStatus = await officialPiAuthStatus(await createOfficialPiCredentialRuntime(temp, absentAgent));
    assert.ok(Array.isArray(absentStatus));
    assert.equal(fs.existsSync(absentDirectory), false, "read-only status must preserve absent auth/models paths");
    await logoutOfficialPiProvider(await createOfficialPiLogoutRuntime(temp, absentAgent), "not-stored");
    assert.equal(fs.existsSync(absentDirectory), false, "logout of an absent credential must preserve absent auth/models paths");

    const agentId = "cli_maliciousAuthA1";
    const directory = path.join(temp, "providers", "pi", agentId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const malicious = { type: "api_key", key: `!touch ${marker}`, env: { sentinel: "exact-other-provider" } };
    const target = { type: "oauth", access: "target-access", refresh: "target-refresh", expires: Date.now() + 3_600_000 };
    const originalBytes = `${JSON.stringify({ anthropic: malicious, "openai-codex": target }, null, 4)}\n`;
    const authPath = path.join(directory, "auth.json");
    fs.writeFileSync(authPath, originalBytes, { mode: 0o600 });

    const statusRuntime = await createOfficialPiCredentialRuntime(temp, agentId);
    const status = await officialPiAuthStatus(statusRuntime);
    assert.ok(status.some((entry) => entry.providerId === "anthropic" && entry.credentialType === "api_key"));
    assert.equal(fs.existsSync(marker), false, "status must not execute !command credentials");
    assert.equal(fs.readFileSync(authPath, "utf8"), originalBytes, "status must preserve exact auth bytes");
    assert.equal(fs.existsSync(path.join(directory, "models.json")), false);
    assert.equal(fs.existsSync(path.join(directory, "models-store.json")), false);

    await logoutOfficialPiProvider(await createOfficialPiLogoutRuntime(temp, agentId), "openai-codex");
    assert.equal(fs.existsSync(marker), false, "logout refresh must not execute unrelated !command credentials");
    const remaining = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.equal(remaining["openai-codex"], undefined);
    assert.deepEqual(remaining.anthropic, malicious, "logout must preserve the unrelated credential exactly");
    assert.equal(fs.existsSync(path.join(directory, "models.json")), false);
    assert.equal(fs.existsSync(path.join(directory, "models-store.json")), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("cross-process setup rollback serializes with ModelRuntime OAuth refresh and preserves both updates", { timeout: 30_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-lock-barrier-"));
  const agentId = "cli_lockBarrierA1";
  const held = path.join(temp, "transaction-held");
  const release = path.join(temp, "release-transaction");
  const refreshEntered = path.join(temp, "refresh-entered");
  const marker = path.join(temp, "command-marker");
  const authModule = pathToFileURL(path.join(ROOT, "dist/runtime/pi-official-auth.mjs")).href;
  const waitFor = async (file, message) => {
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(file), true, message);
  };
  const exited = (child) => new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`child failed ${code}/${signal}: ${stderr}`)));
  });
  try {
    fs.chmodSync(temp, 0o700);
    const directory = path.join(temp, "providers", "pi", agentId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const original = {
      "refresh-fixture": { type: "oauth", access: "expired", refresh: "refresh-old", expires: 1 },
      "setup-target": { type: "api_key", key: "setup-target-key" },
      malicious: { type: "api_key", key: `!touch ${marker}` },
    };
    fs.writeFileSync(path.join(directory, "auth.json"), `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
    const transactionScript = path.join(temp, "transaction-child.mjs");
    fs.writeFileSync(transactionScript, `import fs from "node:fs";\nimport {beginBuiltinPiCredentialTransaction,createOfficialPiLogoutRuntime,logoutOfficialPiProvider} from ${JSON.stringify(authModule)};\n`
      + `const [configDir,agentId,held,release]=process.argv.slice(2); const txn=beginBuiltinPiCredentialTransaction(configDir,agentId);\n`
      + `await logoutOfficialPiProvider(await createOfficialPiLogoutRuntime(configDir,agentId),"setup-target"); fs.writeFileSync(held,"held");\n`
      + `while(!fs.existsSync(release)) await new Promise(r=>setTimeout(r,20)); txn.rollback();\n`, { mode: 0o600 });
    const refreshScript = path.join(temp, "refresh-child.mjs");
    fs.writeFileSync(refreshScript, `import fs from "node:fs";\nimport {createOfficialPiModelRuntime} from ${JSON.stringify(authModule)};\n`
      + `const [configDir,agentId,entered]=process.argv.slice(2); const runtime=await createOfficialPiModelRuntime(configDir,agentId);\n`
      + `runtime.registerNativeProvider({id:"refresh-fixture",name:"Refresh",auth:{oauth:{name:"Refresh",async login(){throw new Error("unused")},async refresh(c){fs.writeFileSync(entered,"entered");return {...c,access:"rotated",refresh:"refresh-new",expires:Date.now()+3600000}},async toAuth(c){return {apiKey:c.access}}}},getModels(){return []},stream(){},streamSimple(){}});\n`
      + `const auth=await runtime.getAuth("refresh-fixture",{minOAuthValidityMs:300000}); if(auth?.auth.apiKey!=="rotated") throw new Error("refresh did not rotate");\n`, { mode: 0o600 });

    const transactionChild = spawn(process.execPath, [transactionScript, temp, agentId, held, release], { stdio: ["ignore", "ignore", "pipe"] });
    const transactionExit = exited(transactionChild);
    await waitFor(held, "setup transaction did not reach logout barrier");
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "auth.json"), "utf8"))["setup-target"], undefined);
    const refreshChild = spawn(process.execPath, [refreshScript, temp, agentId, refreshEntered], { stdio: ["ignore", "ignore", "pipe"] });
    const refreshExit = exited(refreshChild);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(fs.existsSync(refreshEntered), false, "OAuth refresh must block behind the setup transaction lock");
    fs.writeFileSync(release, "release");
    await Promise.all([transactionExit, refreshExit]);
    const final = JSON.parse(fs.readFileSync(path.join(directory, "auth.json"), "utf8"));
    assert.deepEqual(final["setup-target"], original["setup-target"], "setup rollback must restore its target");
    assert.equal(final["refresh-fixture"].access, "rotated");
    assert.equal(final["refresh-fixture"].refresh, "refresh-new");
    assert.deepEqual(final.malicious, original.malicious);
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("post-stale official AuthStorage contender blocks behind the live heartbeat then merges after release", { timeout: 60_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-heartbeat-barrier-"));
  const agentId = "cli_heartbeatA1";
  const contenderStarted = path.join(temp, "contender-started");
  const contenderWritten = path.join(temp, "contender-written");
  const officialAuthStorageModule = pathToFileURL(path.join(ROOT,
    "node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js")).href;
  let transaction;
  try {
    fs.chmodSync(temp, 0o700);
    const directory = path.join(temp, "providers", "pi", agentId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const authPath = path.join(directory, "auth.json");
    fs.writeFileSync(authPath, `${JSON.stringify({ original: { type: "api_key", key: "original-key" } }, null, 2)}\n`, { mode: 0o600 });
    transaction = beginBuiltinPiCredentialTransaction(temp, agentId);

    const stateDir = path.join(temp, "state", "agents", agentId);
    const bindScript = path.join(temp, "slow-official-bind.mjs");
    fs.writeFileSync(bindScript, `import fs from "node:fs"; import path from "node:path";\n`
      + `await new Promise((resolve)=>setTimeout(resolve,35000));\n`
      + `const dir=path.join(process.env.LARKSUITE_CLI_CONFIG_DIR,"lark-channel");fs.mkdirSync(dir,{recursive:true,mode:0o700});\n`
      + `fs.writeFileSync(path.join(dir,"config.json"),JSON.stringify({apps:[{appId:${JSON.stringify(agentId)},appSecret:{source:"keychain",id:"appsecret:${agentId}"},defaultAs:"bot",strictMode:"bot",users:[]}]}),{mode:0o600});\n`, { mode: 0o600 });
    const agent = {
      agentId, feishuAppId: agentId, feishuAppSecret: "heartbeat-secret", feishuDomain: "https://open.feishu.cn",
      credentialRevision: "updated:heartbeat", stateDir, larkConfigDir: path.join(stateDir, "lark-cli-config"),
      workspaceDir: path.join(temp, "agents", agentId), runtime: "pi", model: "default", feishuProfile: agentId,
    };
    const profileSync = syncAgentProfileAsync(agent, { ...process.env, LARKIN_CONFIG_DIR: temp }, {
      forceRebind: true, timeoutMs: 45_000,
      resolveOfficialCli: () => ({ command: process.execPath, argsPrefix: [bindScript], version: "1.0.79" }),
    });

    await new Promise((resolve) => setTimeout(resolve, 31_500));
    const contenderScript = path.join(temp, "official-auth-contender.mjs");
    fs.writeFileSync(contenderScript, `import fs from "node:fs"; import {AuthStorage} from ${JSON.stringify(officialAuthStorageModule)};\n`
      + `const [authPath,started,written]=process.argv.slice(2);fs.writeFileSync(started,"started");\n`
      + `const storage=AuthStorage.create(authPath);await storage.modify("anthropic",async()=>({type:"api_key",key:"contender-key"}));\n`
      + `fs.writeFileSync(written,"written");\n`, { mode: 0o600 });
    const contender = spawn(process.execPath, [contenderScript, authPath, contenderStarted, contenderWritten], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let contenderError = "";
    contender.stderr.on("data", (chunk) => { contenderError += String(chunk); });
    const contenderExit = new Promise((resolve, reject) => {
      contender.once("error", reject);
      contender.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const startDeadline = Date.now() + 5_000;
    while (!fs.existsSync(contenderStarted) && Date.now() < startDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(contenderStarted), true, "official AuthStorage contender did not start");

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(fs.existsSync(contenderWritten), false,
      "an official AuthStorage contender first started post-stale must not acquire the live setup lock immediately");
    assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).anthropic, undefined);

    await profileSync;
    transaction.commit();
    transaction = null;
    const releasedExit = await contenderExit;
    assert.equal(releasedExit.code, 0, `same post-stale contender failed after release ${releasedExit.signal}: ${contenderError}`);
    const final = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.equal(final.original.key, "original-key", "contender merge must preserve the pre-transaction provider");
    assert.equal(final.anthropic.key, "contender-key", "contender must write after the parent releases the live lock");
    assert.equal(fs.existsSync(contenderWritten), true);
  } finally {
    transaction?.rollback();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("OAuth refresh remains owned by the official ModelRuntime request-auth path", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-oauth-refresh-"));
  try {
    fs.chmodSync(temp, 0o700);
    const directory = path.join(temp, "providers", "pi", "cli_refreshA1");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "auth.json"), `${JSON.stringify({
      "refresh-fixture": { type: "oauth", access: "expired-access", refresh: "refresh-value", expires: 1 },
    })}\n`, { mode: 0o600 });
    const runtime = await createOfficialPiModelRuntime(temp, "cli_refreshA1");
    let refreshCalls = 0;
    runtime.registerNativeProvider(provider("refresh-fixture", "Refresh Fixture", { apiKey: false, oauth: true }));
    const registered = runtime.getProvider("refresh-fixture");
    registered.auth.oauth.refresh = async (credential) => {
      refreshCalls += 1;
      return { ...credential, access: "rotated-access", refresh: "rotated-refresh", expires: Date.now() + 3_600_000 };
    };
    registered.auth.oauth.toAuth = async (credential) => ({ apiKey: credential.access });
    const auth = await runtime.getAuth("refresh-fixture", { minOAuthValidityMs: 300_000 });
    assert.equal(refreshCalls, 1);
    assert.equal(auth.auth.apiKey, "rotated-access");
    const stored = JSON.parse(fs.readFileSync(path.join(directory, "auth.json"), "utf8"));
    assert.equal(stored["refresh-fixture"].access, "rotated-access");
    assert.equal(stored["refresh-fixture"].refresh, "rotated-refresh");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test.skipIf(!Bun.which("expect"))("real PTY bridges text/secret/select/manual_code and hides secret inputs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-auth-pty-"));
  const secret = "pty-auth-secret-sentinel";
  const manual = "pty-manual-code-sentinel";
  try {
    const fixture = path.join(temp, "auth-pty-fixture.mjs");
    const transcript = path.join(temp, "auth-pty-transcript.txt");
    const expectScript = path.join(temp, "auth-pty.expect");
    const authUrl = pathToFileURL(path.join(ROOT, "dist/runtime/pi-official-auth.mjs")).href;
    const setupUrl = pathToFileURL(path.join(ROOT, "dist/setup/setup-agent-choice.mjs")).href;
    fs.writeFileSync(fixture, `import {createOfficialPiAuthInteraction} from ${JSON.stringify(authUrl)};\n`
      + `import {terminalSetupQuestioner} from ${JSON.stringify(setupUrl)};\n`
      + `const q=terminalSetupQuestioner(); const i=createOfficialPiAuthInteraction({questioner:q,report() {}});\n`
      + `const text=await i.prompt({type:"text",message:"TEXT_PROMPT"});\n`
      + `const secret=await i.prompt({type:"secret",message:"SECRET_PROMPT"});\n`
      + `const selected=await i.prompt({type:"select",message:"SELECT_PROMPT",options:[{id:"one",label:"One"},{id:"two",label:"Two"}]});\n`
      + `const manual=await i.prompt({type:"manual_code",message:"MANUAL_PROMPT"}); q.close();\n`
      + `console.log(JSON.stringify({text,secretLength:secret.length,selected,manualLength:manual.length}));\n`, { mode: 0o600 });
    fs.writeFileSync(expectScript, `set timeout 15\nlog_file -noappend {${transcript}}\nspawn -noecho {${process.execPath}} {${fixture}}\n`
      + `expect {TEXT_PROMPT}; send -- "visible-text\\r"\n`
      + `expect {SECRET_PROMPT}; send -- "${secret}\\r"\n`
      + `expect {SELECT_PROMPT}; send -- "2\\r"\n`
      + `expect {MANUAL_PROMPT}; send -- "${manual}\\r"\n`
      + `expect {*"text":"visible-text"*"secretLength":${secret.length}*"selected":"two"*"manualLength":${manual.length}*}\nexpect eof\n`, { mode: 0o600 });
    const result = spawnSync(Bun.which("expect"), [expectScript], { cwd: temp, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = fs.readFileSync(transcript, "utf8");
    assert.doesNotMatch(output, new RegExp(`${secret}|${manual}`));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
