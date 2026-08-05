import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE = path.join(ROOT, "src/setup/bot-register.ts");
const BUILT = path.join(ROOT, "dist/setup/bot-register.mjs");
const ENTRY = path.join(ROOT, "dist/setup/bot-register.mjs");
const botRegister = await import(pathToFileURL(ENTRY).href);
const piAuth = await import(pathToFileURL(path.join(ROOT, "dist/runtime/pi-official-auth.mjs")).href);

const statusResult = (value) => ({ status: 0, stdout: JSON.stringify({ ok: true, data: { is_subscribe: value } }), stderr: "" });
const okResult = () => ({ status: 0, stdout: JSON.stringify({ ok: true }), stderr: "" });

async function reconcile(mode, responses) {
  const calls = [];
  const result = await botRegister.reconcileDocumentCommentSubscription({
    mode, command: "/official/lark-cli", argsPrefix: ["--fixture-prefix"], env: {},
    async runProcessImpl(command, args) {
      calls.push({ command, args });
      const next = responses.shift();
      if (!next) throw new Error("unexpected mock call");
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { calls, result };
}

test("bot-register is strict TypeScript compiled to its direct runtime entry", () => {
  assert.equal(fs.existsSync(SOURCE), true);
  assert.equal(fs.existsSync(BUILT), true);
  const entry = fs.readFileSync(ENTRY, "utf8");
  assert.match(entry, /^#!\/usr\/bin\/env bun/);
  assert.match(entry, /registerApp|spawnSync|client_secret|ensureSecureBotsDir/);
  assert.doesNotMatch(entry, /packages\/larkin-shell|fork\/feishu/);
});

test("registration publishes the credential before binding, then verifies the bound Bot workspace", () => {
  const source = fs.readFileSync(SOURCE, "utf8");
  const publish = source.indexOf("fs.writeFileSync(stagedBotFile");
  const bind = source.indexOf("runBindProcess(bindSpec.command, bindSpec.args");
  const sync = source.indexOf("synchronizeAgentProfile(agent");
  const verify = source.indexOf("runIdentityProcess(official.command");
  const resultPublish = source.indexOf("fs.writeFileSync(resultFile");
  const authCommit = source.indexOf("pendingPiAuthTransaction?.commit()");
  const preResolve = source.indexOf("resolvedSetupOfficialCli = resolveOfficialCli({ env: process.env })");
  const authBegin = source.indexOf("pendingPiAuthTransaction = beginBuiltinPiCredentialTransaction");
  assert.equal([publish, bind, sync, verify, resultPublish, authCommit].every((index) => index >= 0), true);
  assert.equal(publish < bind && bind < sync && sync < verify, true);
  assert.equal(verify < resultPublish && resultPublish < authCommit, true,
    "credential transaction must commit only after identity and result publication");
  assert.equal(preResolve >= 0 && preResolve < authBegin, true,
    "the synchronous official CLI probe must complete before the credential transaction lock");
  const transactionInterval = source.slice(authBegin, authCommit);
  assert.doesNotMatch(transactionInterval, /resolveOfficialLarkCli\s*\(/,
    "the active credential transaction must reuse the pre-resolved official CLI");
  assert.doesNotMatch(transactionInterval, /spawnSync\s*\(/,
    "production work while the credential transaction is active must remain asynchronous");
  assert.doesNotMatch(source, /spawnSyncImpl/,
    "comment subscription tests must not be able to inject a synchronous process bypass");
  assert.match(source, /await applyDocumentCommentSubscription\(/,
    "comment subscription reconciliation must keep the credential heartbeat event loop live");
  assert.match(source, /synchronizeAgentProfile\([\s\S]*\{ forceRebind: true \}\)/,
    "new setup credentials must explicitly force one authoritative rebind");
  assert.doesNotMatch(source, /config["', ]+init/);
  assert.match(source, /mode: 0o700/);
  assert.match(source, /mode: 0o600, flag: "wx"/);
  assert.match(source, /callbacks:\s*\{ items: \["card\.action\.trigger"\] \}/);
  assert.match(source, /systemSpawn\(command, args, \{ stdio: "ignore", shell: false \}\)/,
    "browser launch must be non-blocking and shell-free");
  assert.match(source, /child\.once\("error", \(\) => say\(`\[setup\].*\$\{url\}`\)\)/,
    "browser spawn errors must retain a complete manual URL fallback");
  assert.doesNotMatch(source.slice(source.indexOf("function openBrowser"), source.indexOf("async function runBindProcess")), /spawnSync/);
  assert.match(source, /"drive:drive"/);
  assert.match(source, /"drive\.notice\.comment_add_v1"/);
  assert.match(source, /documentCommentEvent/);
  assert.match(source, /--comment-subscription/);
  assert.match(source, /subscription_status/);
  assert.match(source, /官方 lark-cli 的结构化 API 请求/);
  assert.match(source, /"drive", "user", "subscription"/);
  assert.match(source, /"drive", "user", "remove_subscription"/);
  assert.match(source, /documentCommentSubscription/);
  assert.match(source, /docs:document\.comment:create/);
  assert.doesNotMatch(source, /commentSubscription === "user"|dimension === "user"|--as", "user"/);
});

test("comment subscription reconciliation preflights, avoids no-op writes, and verifies exact identity", async () => {
  const already = await reconcile("application", [statusResult(true)]);
  assert.deepEqual(already.result, { changed: false, subscribed: true, dimension: "application" });
  assert.equal(already.calls.length, 1);
  assert.match(already.calls[0].args.join(" "), /subscription_status.*--as bot/);

  const created = await reconcile("application", [statusResult(false), okResult(), statusResult(true)]);
  assert.deepEqual(created.result, { changed: true, subscribed: true, dimension: "application" });
  assert.deepEqual(created.calls.map((call) => call.args[3]), ["subscription_status", "subscription", "subscription_status"]);
  assert.match(created.calls[1].args.join(" "), /--data.*comment_add_v1.*--as bot/);

  const absent = await reconcile("none", [statusResult(false)]);
  assert.deepEqual(absent.result, { changed: false, subscribed: false, dimension: "application" });
  assert.equal(absent.calls.length, 1, "already-absent subscription must not perform remove");

  const removed = await reconcile("none", [statusResult(true), okResult(), statusResult(false)]);
  assert.deepEqual(removed.result, { changed: true, subscribed: false, dimension: "application" });
  assert.deepEqual(removed.calls.map((call) => call.args[3]), ["subscription_status", "remove_subscription", "subscription_status"]);
  assert.match(removed.calls[1].args.join(" "), /--event-type drive.notice.comment_add_v1.*--as bot/);
});

test("local verified-state failure compensates the application subscription and reports rollback certainty", async () => {
  for (const [rollbackStatus, expected] of [
    [statusResult(false), /rollback was verified/],
    [{ status: 1, stdout: "", stderr: "timeout" }, /rollback status is uncertain/],
  ]) {
    const responses = [statusResult(false), okResult(), statusResult(true), statusResult(true), okResult(), rollbackStatus];
    const calls = [];
    await assert.rejects(() => botRegister.applyDocumentCommentSubscription({
      mode: "application", command: "/official/lark-cli", argsPrefix: [], env: {},
      async runProcessImpl(_command, args) { calls.push(args); return responses.shift(); },
      markVerified() { throw new Error("local disk failure"); },
    }), expected);
    assert.deepEqual(calls.map((args) => args[2]), [
      "subscription_status", "subscription", "subscription_status",
      "subscription_status", "remove_subscription", "subscription_status",
    ]);
    assert.equal(calls.every((args) => args[args.indexOf("--as") + 1] === "bot"), true);
  }
  const preExistingCalls = [];
  await assert.rejects(() => botRegister.applyDocumentCommentSubscription({
    mode: "application", command: "/official/lark-cli", argsPrefix: [], env: {},
    async runProcessImpl(_command, args) { preExistingCalls.push(args); return statusResult(true); },
    markVerified() { throw new Error("local disk failure"); },
  }), /pre-existing external subscription was left unchanged/);
  assert.deepEqual(preExistingCalls.map((args) => args[2]), ["subscription_status"]);
});

test("comment subscription reconciliation fails before writes and rolls back uncertain activation", async () => {
  const preflightCalls = [];
  await assert.rejects(() => botRegister.reconcileDocumentCommentSubscription({
    mode: "application", command: "/official/lark-cli", argsPrefix: [], env: {},
    async runProcessImpl(_command, args) { preflightCalls.push(args); return { status: 1, stdout: "", stderr: "unavailable" }; },
  }), /preflight status was unreadable; no write attempted/);
  assert.equal(preflightCalls.length, 1);

  const responses = [statusResult(false), okResult(), { status: 1, stdout: "", stderr: "timeout" }, okResult(), statusResult(false)];
  const rollbackCalls = [];
  await assert.rejects(() => botRegister.reconcileDocumentCommentSubscription({
    mode: "application", command: "/official/lark-cli", argsPrefix: [], env: {},
    async runProcessImpl(_command, args) { rollbackCalls.push(args); return responses.shift(); },
  }), /write was not verified; rollback was verified/);
  assert.deepEqual(rollbackCalls.map((args) => args[2]), ["subscription_status", "subscription", "subscription_status", "remove_subscription", "subscription_status"]);
});

test("ambiguous subscription mutations reconcile platform state before compensation", async () => {
  const activated = await reconcile("application", [statusResult(false), new Error("mutation timeout"), statusResult(true)]);
  assert.deepEqual(activated.result, { changed: true, subscribed: true, dimension: "application" });
  assert.deepEqual(activated.calls.map((call) => call.args[3]), ["subscription_status", "subscription", "subscription_status"]);

  const unchangedCalls = [];
  await assert.rejects(() => botRegister.reconcileDocumentCommentSubscription({
    mode: "application", command: "/official/lark-cli", argsPrefix: [], env: {},
    async runProcessImpl(_command, args) {
      unchangedCalls.push(args);
      if (unchangedCalls.length === 2) throw new Error("output overflow");
      return statusResult(false);
    },
  }), /activation failed; platform status verified unchanged/);
  assert.deepEqual(unchangedCalls.map((args) => args[2]), ["subscription_status", "subscription", "subscription_status"],
    "verified absence after an ambiguous activation must not trigger a needless remove");

  const rollbackCalls = [];
  const rollbackResponses = [statusResult(false), new Error("mutation timeout"),
    { status: 1, stdout: "", stderr: "unreadable" }, new Error("rollback timeout"), statusResult(false)];
  await assert.rejects(() => botRegister.reconcileDocumentCommentSubscription({
    mode: "application", command: "/official/lark-cli", argsPrefix: [], env: {},
    async runProcessImpl(_command, args) {
      rollbackCalls.push(args);
      const next = rollbackResponses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  }), /rollback was verified/);
  assert.deepEqual(rollbackCalls.map((args) => args[2]),
    ["subscription_status", "subscription", "subscription_status", "remove_subscription", "subscription_status"],
    "a rejected rollback mutation must still be followed by final status verification");

  const uncertainResponses = [statusResult(false), new Error("mutation timeout"),
    { status: 1, stdout: "", stderr: "unreadable" }, new Error("rollback timeout"), statusResult(true)];
  await assert.rejects(() => botRegister.reconcileDocumentCommentSubscription({
    mode: "application", command: "/official/lark-cli", argsPrefix: [], env: {},
    async runProcessImpl() {
      const next = uncertainResponses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  }), (error) => error.message ===
    "document comment application subscription write was not verified; rollback failed and platform status verified the subscription remains active; run larkin setup --comment-subscription none to remove it");

  const unknownResponses = [statusResult(false), new Error("mutation timeout"),
    { status: 1, stdout: "", stderr: "unreadable" }, new Error("rollback timeout"),
    { status: 1, stdout: "", stderr: "still unreadable" }];
  await assert.rejects(() => botRegister.reconcileDocumentCommentSubscription({
    mode: "application", command: "/official/lark-cli", argsPrefix: [], env: {},
    async runProcessImpl() {
      const next = unknownResponses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  }), (error) => error.message ===
    "document comment application subscription write was not verified; rollback status is uncertain");
});

test("ambiguous removals distinguish removed, unchanged, uncertain, and shutdown states", async () => {
  const removed = await reconcile("none", [statusResult(true), new Error("remove timeout"), statusResult(false)]);
  assert.deepEqual(removed.result, { changed: true, subscribed: false, dimension: "application" });

  await assert.rejects(() => botRegister.reconcileDocumentCommentSubscription({
    mode: "none", command: "/official/lark-cli", argsPrefix: [], env: {},
    async runProcessImpl(_command, args) {
      const operation = args[2];
      if (operation === "remove_subscription") throw new Error("remove timeout");
      return statusResult(true);
    },
  }), /removal failed; platform status verified unchanged/);

  const unreadable = [statusResult(true), new Error("remove timeout"), { status: 1, stdout: "", stderr: "unreadable" }];
  await assert.rejects(() => botRegister.reconcileDocumentCommentSubscription({
    mode: "none", command: "/official/lark-cli", argsPrefix: [], env: {},
    async runProcessImpl() {
      const next = unreadable.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  }), /removal external state is uncertain/);

  let aborted = false;
  const shutdownCalls = [];
  await assert.rejects(() => botRegister.reconcileDocumentCommentSubscription({
    mode: "application", command: "/official/lark-cli", argsPrefix: [], env: {},
    isShutdownAborted: () => aborted,
    async runProcessImpl(_command, args) {
      shutdownCalls.push(args);
      if (shutdownCalls.length === 1) return statusResult(false);
      aborted = true;
      throw new Error("cancelled");
    },
  }), /interrupted by shutdown; external state is uncertain/);
  assert.deepEqual(shutdownCalls.map((args) => args[2]), ["subscription_status", "subscription"],
    "process shutdown must not start follow-up children that cannot complete");
});

test("slow subscription CLI preserves the Pi credential heartbeat and isolates commit and rollback from AuthStorage", {
  timeout: 60_000,
}, async () => {
  const officialAuthStorageModule = pathToFileURL(path.join(ROOT,
    "node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js")).href;
  await Promise.all(["commit", "rollback"].map(async (outcome) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-comment-subscription-${outcome}-`));
    const agentId = `cli_subscription${outcome === "commit" ? "Commit" : "Rollback"}A1`;
    const directory = path.join(root, "providers", "pi", agentId);
    const authPath = path.join(directory, "auth.json");
    const statusState = path.join(root, "subscription-status-count");
    const contenderStarted = path.join(root, "contender-started");
    const contenderWritten = path.join(root, "contender-written");
    let transaction;
    let contender;
    try {
      fs.chmodSync(root, 0o700);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(authPath, `${JSON.stringify({ original: { type: "api_key", key: "original-key" } }, null, 2)}\n`, { mode: 0o600 });
      transaction = piAuth.beginBuiltinPiCredentialTransaction(root, agentId);
      fs.writeFileSync(authPath, `${JSON.stringify({
        original: { type: "api_key", key: "original-key" },
        setup: { type: "api_key", key: "setup-key" },
      }, null, 2)}\n`, { mode: 0o600 });

      const slowCli = path.join(root, "slow-subscription-cli.mjs");
      fs.writeFileSync(slowCli, `import fs from "node:fs";\n`
        + `const [state,...args]=process.argv.slice(2);const user=args.indexOf("user"),operation=args[user+1];\n`
        + `if(operation==="subscription_status"){const count=fs.existsSync(state)?Number(fs.readFileSync(state,"utf8")):0;fs.writeFileSync(state,String(count+1));`
        + `if(count===0)await new Promise(resolve=>setTimeout(resolve,35000));console.log(JSON.stringify({ok:true,data:{is_subscribe:count>0}}));process.exit(0);}\n`
        + `if(operation==="subscription"){console.log(JSON.stringify({ok:true}));process.exit(0);}\nprocess.exit(1);\n`, { mode: 0o600 });
      const subscription = botRegister.reconcileDocumentCommentSubscription({
        mode: "application", command: process.execPath, argsPrefix: [slowCli, statusState], env: process.env,
      });

      await new Promise((resolve) => setTimeout(resolve, 31_500));
      const contenderScript = path.join(root, "auth-storage-contender.mjs");
      fs.writeFileSync(contenderScript, `import fs from "node:fs";import {AuthStorage} from ${JSON.stringify(officialAuthStorageModule)};\n`
        + `const [authPath,started,written]=process.argv.slice(2);fs.writeFileSync(started,"started");`
        + `const storage=AuthStorage.create(authPath);await storage.modify("contender",async()=>({type:"api_key",key:"contender-key"}));`
        + `fs.writeFileSync(written,"written");\n`, { mode: 0o600 });
      contender = spawn(process.execPath, [contenderScript, authPath, contenderStarted, contenderWritten], {
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
      assert.equal(fs.existsSync(contenderStarted), true, `${outcome}: AuthStorage contender did not start`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(fs.existsSync(contenderWritten), false,
        `${outcome}: contender acquired a falsely stale lock while subscription CLI was still running`);

      assert.deepEqual(await subscription, { changed: true, subscribed: true, dimension: "application" });
      transaction[outcome]();
      transaction = null;
      const released = await contenderExit;
      contender = null;
      assert.equal(released.code, 0, `${outcome}: contender failed after transaction release ${released.signal}: ${contenderError}`);
      const final = JSON.parse(fs.readFileSync(authPath, "utf8"));
      assert.equal(final.original.key, "original-key");
      assert.equal(final.contender.key, "contender-key");
      assert.equal(Object.hasOwn(final, "setup"), outcome === "commit",
        `${outcome}: setup credential must follow transaction outcome without clobbering the contender`);
    } finally {
      transaction?.rollback();
      contender?.kill("SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  }));
});

test("help does not create credentials or expose a browser-selection bypass", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-bot-register-help-"));
  try {
    const result = spawnSync(process.execPath, [ENTRY, "--help"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, HOME: path.join(root, "home"), LARKIN_CONFIG_DIR: path.join(root, "config") },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /网页|原子写|绑定 Agent/);
    assert.equal(fs.existsSync(path.join(root, "config", "bots")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("grant-scopes is strict TypeScript compiled to its direct runtime entry", () => {
  const source = path.join(ROOT, "src/setup/grant-scopes.ts");
  const built = path.join(ROOT, "dist/setup/grant-scopes.mjs");
  const entryFile = path.join(ROOT, "dist/setup/grant-scopes.mjs");
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(built), true);
  const entry = fs.readFileSync(entryFile, "utf8");
  assert.match(entry, /^#!\/usr\/bin\/env bun/);
  assert.match(entry, /registerApp|spawnSync|TENANT_SCOPES|selectAgent/);
  assert.doesNotMatch(entry, /packages\/larkin-shell|fork\/feishu/);
  const authored = fs.readFileSync(source, "utf8");
  assert.match(authored, /const selected = larkinConfig\.selectAgent/);
  assert.match(authored, /explicitAppId !== selected\.feishuAppId/);
  assert.match(authored, /resolveManagedOfficialCli\(selected, process\.env\)/);
  assert.doesNotMatch(authored, /defaultChatId|LARKIN_FEISHU_DEFAULT_CHAT_ID/);
  assert.match(authored, /callbacks:\s*\{ items: \["card\.action\.trigger"\] \}/);
  assert.match(authored, /"drive:drive"/);
  assert.match(authored, /"drive\.notice\.comment_add_v1"/);
});
