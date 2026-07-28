import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const launcher = await import(pathToFileURL(path.join(ROOT, "dist/app/lark-cli.mjs")).href);
const stateModule = await import(pathToFileURL(path.join(ROOT, "dist/agent/agent-state-store.mjs")).href);
const agentCli = await import(pathToFileURL(path.join(ROOT, "dist/app/agent-cli.mjs")).href);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-native-lark-cli-"));
  const agentId = "cli_nativeLarkA1";
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-native-lark", mentionPolicy: "require", activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "default" } },
  })}\n`, { mode: 0o600 });
  const store = stateModule.createAgentStateStore(root, agentId);
  const env = { LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId };
  const output = { stdout: "", stderr: "" };
  const calls = [];
  let spawnStatus = 7;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: spawnStatus, signal: null, output: [], pid: 1, stdout: "native-out\n", stderr: "native-err\n", error: undefined };
  };
  const run = (argv) => {
    output.stdout = "";
    output.stderr = "";
    const code = launcher.runLarkCli(argv, env, {
      io: { stdout(text) { output.stdout += text; }, stderr(text) { output.stderr += text; } },
      spawn, upstreamScript: "/fixed/@larksuite/cli/scripts/run.js", stateStore: store, now: () => Date.parse("2026-07-28T00:00:00.000Z"),
    });
    return { code, ...output };
  };
  const poll = (...args) => agentCli.runAgentCli(["inbox", "poll", ...args], env, {
    stateStore: store, io: { stdout() {}, stderr(text) { throw new Error(text); } },
  });
  return { root, agentId, store, env, calls, run, poll, setSpawnStatus(value) { spawnStatus = value; } };
}

test("launcher classifies exact command paths without substring policy", () => {
  assert.equal(launcher.classifyLarkCliCommand(["im", "+messages-send", "--chat-id", "oc_x", "--text", "hi"]).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand(["--chat-id", "oc_x", "im", "+messages-send", "--text", "hi"]).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand(["im", "--chat-id", "oc_x", "+messages-send", "--text", "hi"]).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand(["im", "+messages-reply", "--message-id", "om_x", "--text", "hi"]).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand(["im", "messages", "create", "--data", "{}"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["api", "POST", "/open-apis/im/v1/messages"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["api", "GET", "/open-apis/im/v1/messages", "--method", "POST"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["im", "messages", "forward", "--message-id", "om_x"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["im", "messages", "merge_forward", "--message-id", "om_x"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["im", "threads", "forward", "--message-id", "om_x"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["im", "threads", "merge_forward", "--message-id", "om_x"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["--as", "bot", "api", "POST", "/open-apis/im/v1/messages"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["--text", "stale", "im", "+messages-send", "--chat-id", "oc_x"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["im", "--text", "stale", "+messages-send", "--chat-id", "oc_x"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["-q", ".", "im", "+messages-send", "--chat-id", "oc_x"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["docs", "+fetch", "--token", "contains-auth-and-messages-send"]).kind, "passthrough");
  assert.equal(launcher.classifyLarkCliCommand(["docs", "+fetch", "--text", "api"]).kind, "passthrough",
    "a protected-looking value consumed by a pinned value flag is not command syntax");
  assert.equal(launcher.classifyLarkCliCommand(["auth", "--help"]).kind, "passthrough", "native help is never rewritten or denied");
  assert.equal(launcher.classifyLarkCliCommand(["im", "+messages-send", "--text", "-h"]).kind, "guarded",
    "-h consumed as text is not native help");
  assert.equal(launcher.classifyLarkCliCommand(["im", "+messages-send", "--chat-id", "-h"]).kind, "denied",
    "-h consumed as a target value is not native help");
  assert.equal(launcher.classifyLarkCliCommand(["larkin-draft", "send", "--draft-id", "-h"]).kind, "denied",
    "-h consumed as a draft id is not native help");
  assert.equal(launcher.classifyLarkCliCommand(["im", "+messages-send", "--chat-id", "oc_a", "--", "--help"]).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand(["im", "+messages-send", "--help", "--", "--chat-id", "oc_a"]).kind, "passthrough");
});

test("launcher forwards native help, output, stderr, exit code, and fixed package entry", () => {
  const f = fixture();
  try {
    const beforeConfig = fs.readFileSync(path.join(f.root, "config.json"));
    const helpArgv = ["im", "+messages-send", "--as", "user", "--chat-id", "a", "--chat-id=b", "--help"];
    const result = f.run(helpArgv);
    assert.equal(result.code, 7);
    assert.equal(result.stdout, "native-out\n");
    assert.equal(result.stderr, "native-err\n");
    assert.equal(f.calls[0].command, process.execPath);
    assert.deepEqual(f.calls[0].args, ["/fixed/@larksuite/cli/scripts/run.js", ...helpArgv]);
    assert.equal(f.calls[0].options.env.LARKSUITE_CLI_CONFIG_DIR, path.join(f.store.paths.root, "lark-cli-config"));
    assert.equal(f.calls[0].options.env.LARKIN_AGENT_ID, f.agentId);
    assert.deepEqual(fs.readFileSync(path.join(f.root, "config.json")), beforeConfig, "native help must not mutate Runtime config");
    assert.equal(fs.existsSync(f.store.paths.inboxState), false, "native help must not create Agent state");

    const contentThenHelp = ["im", "+messages-send", "--text", "stale", "--help"];
    const contentHelpResult = f.run(contentThenHelp);
    assert.equal(contentHelpResult.code, 7);
    assert.deepEqual(f.calls[1].args, ["/fixed/@larksuite/cli/scripts/run.js", ...contentThenHelp]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("canonical read paths treat protected-looking flag values as opaque provider argv", () => {
  const f = fixture();
  try {
    f.setSpawnStatus(0);
    const readCommands = [
      ["docs", "+fetch", "--doc", "api"],
      ["docs", "+fetch", "--keyword", "api"],
      ["docs", "+fetch", "--doc", "larkin-draft"],
      ["im", "+chat-list", "--page-token", "api"],
    ];
    for (const argv of readCommands) assert.equal(f.run(argv).code, 0, argv.join(" "));
    assert.deepEqual(f.calls.map((call) => call.args.slice(1)), readCommands,
      "read argv must reach the pinned provider byte-for-byte");
    assert.equal(fs.existsSync(f.store.paths.inboxState), false,
      "read classification must not create freshness or draft state");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("normalized policy flags cannot bypass guarded targets or generic API denial", () => {
  const f = fixture();
  try {
    f.setSpawnStatus(0);
    f.store.appendNdjson("inbox", { message_id: "om_prefix", chat_id: "oc_prefix", content: "unseen" });
    for (const argv of [
      ["--chat-id", "oc_prefix", "im", "+messages-send", "--text", "old"],
      ["im", "--chat-id", "oc_prefix", "+messages-send", "--text", "old"],
    ]) {
      const result = f.run(argv);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, "held");
    }
    assert.equal(f.run(["--as", "bot", "api", "POST", "/open-apis/im/v1/messages", "--data", "{}"]).code, 2);
    assert.equal(f.calls.length, 0, "held or denied normalized paths must not spawn the native provider");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("launcher holds stale per-target writes as an idempotent draft and poll releases only that target", () => {
  const f = fixture();
  try {
    f.store.appendNdjson("inbox", { message_id: "om_new", chat_id: "oc_target", content: "new context" });
    f.store.appendNdjson("inbox", { message_id: "om_other", chat_id: "oc_other", content: "unrelated" });
    const held = f.run(["im", "+messages-send", "--chat-id", "oc_target", "--markdown", "old answer"]);
    assert.equal(held.code, 0, held.stderr);
    const firstDraft = JSON.parse(held.stdout);
    assert.equal(firstDraft.status, "held");
    assert.equal(firstDraft.target, "chat:oc_target");
    assert.equal(f.calls.length, 0, "held write must not reach upstream lark-cli");
    const repeated = JSON.parse(f.run(["im", "+messages-send", "--chat-id", "oc_target", "--markdown", "old answer"]).stdout);
    assert.equal(repeated.draft_id, firstDraft.draft_id, "same intent must reuse its held draft");

    assert.equal(f.poll("--target", "chat:oc_target"), 0);
    const sent = f.run(["im", "+messages-send", "--chat-id", "oc_target", "--markdown", "current answer"]);
    assert.equal(sent.code, 7);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].args.slice(1, 5), ["im", "+messages-send", "--chat-id", "oc_target"]);
    assert.equal(f.calls[0].args.includes("--as"), true);
    assert.equal(f.calls[0].args.includes("bot"), true);
    assert.equal(f.calls[0].args.includes("--idempotency-key"), true);

    f.calls.length = 0;
    const unrelated = f.run(["im", "+messages-send", "--chat-id", "oc_target", "--text", "still current"]);
    assert.equal(unrelated.code, 7, unrelated.stderr);
    assert.equal(f.calls.length, 1, "an unseen update on another target must not hold this target");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a five-second provider runs after the intent lock and preserves concurrent inbound for the next batch", { timeout: 15_000 }, async () => {
  const f = fixture();
  const moduleFile = path.join(ROOT, "dist/agent/agent-state-store.cjs");
  const appended = path.join(f.root, "slow-provider-append-complete");
  let child;
  let providerCalls = 0;
  let providerArgv = [];
  try {
    const output = { stdout: "", stderr: "" };
    const argv = ["im", "+messages-send", "--chat-id", "oc_slow", "--text", "current"];
    const code = launcher.runLarkCli(argv, f.env, {
      io: { stdout(text) { output.stdout += text; }, stderr(text) { output.stderr += text; } },
      upstreamScript: "/fixed/@larksuite/cli/scripts/run.js",
      stateStore: f.store,
      now: () => Date.parse("2026-07-28T00:00:00.000Z"),
      spawn(_command, args) {
        providerCalls += 1;
        providerArgv = [...args];
        child = spawn(process.execPath, ["-e", `
const fs = require("node:fs");
const { createAgentStateStore } = require(process.argv[1]);
createAgentStateStore(process.argv[2], process.argv[3]).appendNdjson("inbox", {
  message_id: "om_during_provider", chat_id: "oc_slow", content: "new during provider",
});
fs.writeFileSync(process.argv[4], "complete");
`, moduleFile, f.root, f.agentId, appended], { stdio: "ignore" });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
        return { status: 0, signal: null, output: [], pid: 1, stdout: "sent\n", stderr: "", error: undefined };
      },
    });
    assert.equal(code, 0, output.stderr);
    assert.ok(child);
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    assert.equal(child.exitCode, 0, "concurrent append must finish before the slow provider returns");
    assert.equal(fs.existsSync(appended), true);
    assert.equal(providerCalls, 1);
    assert.deepEqual(f.store.readNdjson("inbox").map((row) => row.message_id), ["om_during_provider"]);
    const state = f.store.readJson("inboxState", null);
    const intent = Object.values(state.intents)[0];
    const idempotencyIndex = providerArgv.indexOf("--idempotency-key");
    const upstreamIdempotency = providerArgv[idempotencyIndex + 1];
    assert.match(upstreamIdempotency, /^larkin-[0-9a-f]{32}$/);
    assert.equal(upstreamIdempotency, intent.intent_id, "durable intent and provider argv share one stable idempotency key");
    assert.equal(f.poll("--target", "chat:oc_slow"), 0);
    assert.deepEqual(f.store.readNdjson("inbox"), [], "concurrent append is consumed only by the next poll");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("saved draft send returns provider failure to held, reuses its idempotency key, and commits only on success", () => {
  const f = fixture();
  try {
    f.store.appendNdjson("inbox", { message_id: "om_draft", chat_id: "oc_draft", content: "new context" });
    const held = JSON.parse(f.run(["im", "+messages-send", "--chat-id", "oc_draft", "--text", "held answer"]).stdout);
    assert.equal(held.status, "held");
    assert.equal(f.calls.length, 0);
    const listed = JSON.parse(f.run(["larkin-draft", "list"]).stdout);
    assert.deepEqual(listed.drafts.map((draft) => draft.draft_id), [held.draft_id]);

    const stillHeld = f.run(["larkin-draft", "send", "--draft-id", held.draft_id]);
    assert.equal(stillHeld.code, 0, stillHeld.stderr);
    assert.equal(JSON.parse(stillHeld.stdout).status, "held");
    assert.equal(f.calls.length, 0, "unseen target update must block saved draft provider call");

    assert.equal(f.poll("--target", "chat:oc_draft"), 0);
    const failed = f.run(["larkin-draft", "send", "--draft-id", held.draft_id]);
    assert.equal(failed.code, 7, failed.stderr);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].args.slice(1, 7), ["im", "+messages-send", "--chat-id", "oc_draft", "--text", "held answer"]);
    assert.equal(f.calls[0].args.includes("--as"), true);
    assert.equal(f.calls[0].args.includes("--idempotency-key"), true);
    assert.equal(f.store.readInboxDraft(held.draft_id).status, "held", "provider failure must make the draft retryable");
    const failedKey = f.calls[0].args[f.calls[0].args.indexOf("--idempotency-key") + 1];

    f.setSpawnStatus(0);
    const sent = f.run(["larkin-draft", "send", "--draft-id", held.draft_id]);
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(f.calls.length, 2);
    const retriedKey = f.calls[1].args[f.calls[1].args.indexOf("--idempotency-key") + 1];
    assert.equal(retriedKey, failedKey, "the same saved intent and seen boundary must reuse one provider idempotency key");
    assert.equal(f.store.readInboxDraft(held.draft_id).status, "sent");

    const retry = f.run(["larkin-draft", "send", "--draft-id", held.draft_id]);
    assert.equal(retry.code, 2);
    assert.equal(f.calls.length, 2, "sent draft must not reach provider again");

    f.store.appendNdjson("inbox", { message_id: "om_abandon", chat_id: "oc_draft", content: "newer context" });
    const abandonedDraft = JSON.parse(f.run(["im", "+messages-send", "--chat-id", "oc_draft", "--text", "discard me"]).stdout);
    const abandoned = JSON.parse(f.run(["larkin-draft", "abandon", "--draft-id", abandonedDraft.draft_id]).stdout);
    assert.equal(abandoned.status, "abandoned");
    assert.equal(f.run(["larkin-draft", "send", "--draft-id", abandonedDraft.draft_id]).code, 2);
    assert.equal(f.calls.length, 2, "abandoned draft must not reach provider");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("an interrupted draft provider leaves sending durable, refuses abandon, and recovers with the same key", async () => {
  const f = fixture();
  const launcherFile = path.join(ROOT, "dist/app/lark-cli.mjs");
  const stateFile = path.join(ROOT, "dist/agent/agent-state-store.mjs");
  const marker = path.join(f.root, "crashed-provider-argv.json");
  try {
    f.store.appendNdjson("inbox", { message_id: "om_crash", chat_id: "oc_crash", content: "new context" });
    const held = JSON.parse(f.run(["im", "+messages-send", "--chat-id", "oc_crash", "--text", "recover me"]).stdout);
    assert.equal(f.poll("--target", "chat:oc_crash"), 0);
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const launcher = await import(pathToFileURL(process.argv[2]).href);
const state = await import(pathToFileURL(process.argv[3]).href);
const root = process.argv[4];
const agent = process.argv[5];
const draft = process.argv[6];
const marker = process.argv[7];
launcher.runLarkCli(["larkin-draft", "send", "--draft-id", draft], {
  LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agent,
}, {
  stateStore: state.createAgentStateStore(root, agent),
  upstreamScript: "/fixed/@larksuite/cli/scripts/run.js",
  spawn(_command, args) {
    fs.writeFileSync(marker, JSON.stringify(args));
    process.exit(91);
  },
});
`, "draft-crash-harness", launcherFile, stateFile, f.root, f.agentId, held.draft_id, marker], { stdio: ["ignore", "pipe", "pipe"] });
    let childStderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { childStderr += chunk; });
    await once(child, "exit");
    assert.equal(child.exitCode, 91, childStderr);
    assert.equal(f.store.readInboxDraft(held.draft_id).status, "sending");
    const listed = JSON.parse(f.run(["larkin-draft", "list"]).stdout);
    assert.deepEqual(listed.drafts.map((draft) => draft.status), ["sending"]);

    const abandoned = f.run(["larkin-draft", "abandon", "--draft-id", held.draft_id]);
    assert.equal(abandoned.code, 2);
    assert.match(abandoned.stderr, /too late to abandon/);
    assert.equal(f.store.readInboxDraft(held.draft_id).status, "sending");

    const crashedArgv = JSON.parse(fs.readFileSync(marker, "utf8"));
    const crashedKey = crashedArgv[crashedArgv.indexOf("--idempotency-key") + 1];
    f.setSpawnStatus(0);
    const recovered = f.run(["larkin-draft", "send", "--draft-id", held.draft_id]);
    assert.equal(recovered.code, 0, recovered.stderr);
    const recoveredArgv = f.calls.at(-1).args;
    assert.equal(recoveredArgv[recoveredArgv.indexOf("--idempotency-key") + 1], crashedKey);
    assert.equal(f.store.readInboxDraft(held.draft_id).status, "sent");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("provider idempotency is stable within one model-seen boundary and rotates after the next poll", () => {
  const f = fixture();
  try {
    f.setSpawnStatus(0);
    const argv = ["im", "+messages-send", "--chat-id", "oc_boundary", "--text", "same intent"];
    assert.equal(f.run(argv).code, 0);
    assert.equal(f.run(argv).code, 0);
    const keyAt = (index) => f.calls[index].args[f.calls[index].args.indexOf("--idempotency-key") + 1];
    assert.equal(keyAt(1), keyAt(0), "local provider replay at the same seen boundary must use the same key");

    f.store.appendNdjson("inbox", { message_id: "om_boundary", chat_id: "oc_boundary", content: "new context" });
    assert.equal(f.poll("--target", "chat:oc_boundary"), 0);
    assert.equal(f.run(argv).code, 0);
    assert.notEqual(keyAt(2), keyAt(0), "polling a newer receive boundary must create a new intent key");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("launcher rejects identity switches and generic write bypasses before spawn", () => {
  const f = fixture();
  try {
    const noncanonical = f.run(["--text", "stale", "im", "+messages-send", "--chat-id", "oc_x"]);
    assert.equal(noncanonical.code, 2);
    assert.match(noncanonical.stderr, /把 service\/subcommand 放在前面/);
    for (const argv of [
      ["im", "+chat-list", "--profile", "other"],
      ["im", "+chat-list", "--config-dir", "/tmp/escape"],
      ["im", "+messages-send", "--chat-id", "oc_x", "--as", "user", "--text", "x"],
      ["im", "+messages-send", "--user-id", "ou_x", "--text", "x"],
      ["im", "+messages-send", "--chat-id", "oc_a", "--chat-id=oc_b", "--text", "x"],
      ["im", "+messages-send", "--chat-id", "oc_a", "--idempotency-key=one", "--idempotency-key", "two", "--text", "x"],
      ["im", "+messages-reply", "--message-id", "om_a", "--message-id=om_b", "--text", "x"],
      ["im", "+messages-send", "--chat-id", "oc_a", "--as", "bot", "--as=user", "--text", "x"],
      ["im", "+messages-send", "--chat-id=oc_a", "--as=-h", "--text", "x"],
      ["im", "--text", "stale", "+messages-send", "--chat-id", "oc_x"],
      ["-q", ".", "im", "+messages-send", "--chat-id", "oc_x"],
      ["im", "+messages-send", "--text", "-h"],
      ["im", "+messages-send", "--chat-id", "-h"],
      ["api", "POST", "/open-apis/im/v1/messages", "--data", "{}"],
      ["im", "messages", "create", "--data", "{}"],
      ["im", "messages", "forward", "--message-id", "om_a"],
      ["im", "messages", "merge_forward", "--message-id", "om_a"],
      ["im", "threads", "forward", "--message-id", "om_a"],
      ["im", "threads", "merge_forward", "--message-id", "om_a"],
    ]) {
      const rejected = f.run(argv);
      assert.equal(rejected.code, 2, `${argv.join(" ")} unexpectedly succeeded`);
    }
    assert.equal(f.calls.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("flags after -- cannot change the freshness target or receive injected identity", () => {
  const f = fixture();
  try {
    const result = f.run(["im", "+messages-send", "--chat-id", "oc_exact", "--text", "x", "--", "--chat-id", "oc_positional", "--as", "user", "--help"]);
    assert.equal(result.code, 7, result.stderr);
    assert.equal(f.calls.length, 1);
    const upstream = f.calls[0].args.slice(1);
    const boundary = upstream.indexOf("--");
    assert.deepEqual(upstream.slice(0, boundary), [
      "im", "+messages-send", "--chat-id", "oc_exact", "--text", "x", "--as", "bot", "--idempotency-key", upstream[9],
    ]);
    assert.deepEqual(upstream.slice(boundary + 1), ["--chat-id", "oc_positional", "--as", "user", "--help"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
