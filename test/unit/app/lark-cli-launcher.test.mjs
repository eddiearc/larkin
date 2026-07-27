import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  assert.equal(launcher.classifyLarkCliCommand(["im", "+messages-reply", "--message-id", "om_x", "--text", "hi"]).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand(["im", "messages", "create", "--data", "{}"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["api", "POST", "/open-apis/im/v1/messages"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["api", "GET", "/open-apis/im/v1/messages", "--method", "POST"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["im", "messages", "forward", "--message-id", "om_x"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["im", "messages", "merge_forward", "--message-id", "om_x"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["docs", "+fetch", "--token", "contains-auth-and-messages-send"]).kind, "passthrough");
  assert.equal(launcher.classifyLarkCliCommand(["auth", "--help"]).kind, "passthrough", "native help is never rewritten or denied");
  assert.equal(launcher.classifyLarkCliCommand(["im", "+messages-send", "--chat-id", "oc_a", "--", "--help"]).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand(["im", "+messages-send", "--help", "--", "--chat-id", "oc_a"]).kind, "passthrough");
});

test("launcher forwards native help, output, stderr, exit code, and fixed package entry", () => {
  const f = fixture();
  try {
    const result = f.run(["im", "+messages-send", "--help"]);
    assert.equal(result.code, 7);
    assert.equal(result.stdout, "native-out\n");
    assert.equal(result.stderr, "native-err\n");
    assert.equal(f.calls[0].command, process.execPath);
    assert.deepEqual(f.calls[0].args, ["/fixed/@larksuite/cli/scripts/run.js", "im", "+messages-send", "--help"]);
    assert.equal(f.calls[0].options.env.LARKSUITE_CLI_CONFIG_DIR, path.join(f.store.paths.root, "lark-cli-config"));
    assert.equal(f.calls[0].options.env.LARKIN_AGENT_ID, f.agentId);
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

test("saved draft send commits atomically after provider success and cannot be retried", () => {
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
    f.setSpawnStatus(0);
    const sent = f.run(["larkin-draft", "send", "--draft-id", held.draft_id]);
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].args.slice(1, 7), ["im", "+messages-send", "--chat-id", "oc_draft", "--text", "held answer"]);
    assert.equal(f.calls[0].args.includes("--as"), true);
    assert.equal(f.calls[0].args.includes("--idempotency-key"), true);
    assert.equal(f.store.readInboxDraft(held.draft_id).status, "sent");

    const retry = f.run(["larkin-draft", "send", "--draft-id", held.draft_id]);
    assert.equal(retry.code, 2);
    assert.equal(f.calls.length, 1, "sent draft must not reach provider twice");

    f.store.appendNdjson("inbox", { message_id: "om_abandon", chat_id: "oc_draft", content: "newer context" });
    const abandonedDraft = JSON.parse(f.run(["im", "+messages-send", "--chat-id", "oc_draft", "--text", "discard me"]).stdout);
    const abandoned = JSON.parse(f.run(["larkin-draft", "abandon", "--draft-id", abandonedDraft.draft_id]).stdout);
    assert.equal(abandoned.status, "abandoned");
    assert.equal(f.run(["larkin-draft", "send", "--draft-id", abandonedDraft.draft_id]).code, 2);
    assert.equal(f.calls.length, 1, "abandoned draft must not reach provider");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("launcher rejects identity switches and generic write bypasses before spawn", () => {
  const f = fixture();
  try {
    for (const argv of [
      ["im", "+chat-list", "--profile", "other"],
      ["im", "+chat-list", "--config-dir", "/tmp/escape"],
      ["im", "+chat-list", "--profile", "other", "--help"],
      ["im", "+messages-send", "--chat-id", "oc_x", "--as", "user", "--text", "x"],
      ["im", "+messages-send", "--user-id", "ou_x", "--text", "x"],
      ["im", "+messages-send", "--chat-id", "oc_a", "--chat-id=oc_b", "--text", "x"],
      ["im", "+messages-send", "--chat-id", "oc_a", "--idempotency-key=one", "--idempotency-key", "two", "--text", "x"],
      ["im", "+messages-reply", "--message-id", "om_a", "--message-id=om_b", "--text", "x"],
      ["im", "+messages-send", "--chat-id", "oc_a", "--as", "bot", "--as=user", "--text", "x"],
      ["im", "+messages-send", "--chat-id", "oc_a", "--as=bot", "--as", "user", "--help"],
      ["im", "+messages-send", "--chat-id", "-h", "--text", "x"],
      ["im", "+messages-send", "--chat-id=oc_a", "--as=-h", "--text", "x"],
      ["api", "POST", "/open-apis/im/v1/messages", "--data", "{}"],
      ["im", "messages", "create", "--data", "{}"],
      ["im", "messages", "forward", "--message-id", "om_a"],
      ["im", "messages", "merge_forward", "--message-id", "om_a"],
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
