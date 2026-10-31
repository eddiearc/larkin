import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const configApi = require("../../../dist/platform/config.cjs");
const { ContextPromptBuilder } = await import("../../../dist/agent/context-prompt.mjs");
const APP = "cli_replyModeA1";
const OTHER = "cli_replyModeB2";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reply-mode-config-"));
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-reply-mode", mentionPolicy: "require", activeAgent: APP,
    agents: { [APP]: { runtime: "codex", model: "gpt-5.6-sol" }, [OTHER]: { runtime: "claude", model: "sonnet" } },
  }, null, 2)}\n`, { mode: 0o600 });
  return { root, env: { LARKIN_CONFIG_DIR: root } };
}

test("global reply mode is stored once, projected onto every Agent and requires re-apply", () => {
  const { root, env } = fixture();
  try {
    const before = configApi.loadConfig(env).config;
    assert.equal(before.replyMode, undefined);
    assert.equal(before.agents[APP].replyMode, undefined);
    assert.equal(configApi.safeConfigView(before).replyMode, null);
    const signatureBefore = configApi.runtimeConfigSignature(before, APP);

    const result = configApi.mutateConfig(env, { kind: "set-global-reply-mode", value: "cli" }, { kind: "user" });
    assert.equal(result.changedScope, "global");
    assert.equal(result.applyState, "saved_not_applied");
    const stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.equal(stored.replyMode, "cli");
    assert.equal("replyMode" in stored.agents[APP], false);

    const after = configApi.loadConfig(env).config;
    assert.equal(after.replyMode, "cli");
    assert.equal(after.agents[APP].replyMode, "cli");
    assert.equal(after.agents[OTHER].replyMode, "cli");
    assert.equal(configApi.safeConfigView(after).replyMode, "cli");
    assert.notEqual(configApi.runtimeConfigSignature(after, APP), signatureBefore);

    assert.throws(() => configApi.mutateConfig(env, { kind: "set-global-reply-mode", value: "both" }, { kind: "user" }), /card\/cli/);
    fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({ ...stored, replyMode: "bogus" })}\n`, { mode: 0o600 });
    assert.throws(() => configApi.loadConfig(env), /config\.replyMode/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an Agent's own reply mode overrides the global one and survives a global change", () => {
  const { root, env } = fixture();
  try {
    configApi.mutateConfig(env, { kind: "set-global-reply-mode", value: "card" }, { kind: "user" });
    const signatureBefore = configApi.runtimeConfigSignature(configApi.loadConfig(env).config, APP);
    const result = configApi.mutateConfig(env, { kind: "set-agent-reply-mode", agentId: APP, value: "cli" }, { kind: "user" });
    assert.equal(result.changedScope, "agent");
    assert.equal(result.applyState, "saved_not_applied");
    const stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.equal(stored.agents[APP].replyMode, "cli");
    assert.equal("replyMode" in stored.agents[OTHER], false);

    let config = configApi.loadConfig(env).config;
    assert.equal(config.agents[APP].replyMode, "cli");
    assert.equal(config.agents[OTHER].replyMode, "card");
    assert.equal(configApi.safeConfigView(config, APP).agents[0].replyMode, "cli");
    const signatureOwn = configApi.runtimeConfigSignature(config, APP);
    assert.notEqual(signatureOwn, signatureBefore);

    configApi.mutateConfig(env, { kind: "set-global-reply-mode", value: "cli" }, { kind: "user" });
    configApi.mutateConfig(env, { kind: "set-global-reply-mode", value: "card" }, { kind: "user" });
    config = configApi.loadConfig(env).config;
    assert.equal(config.agents[APP].replyMode, "cli");
    assert.equal(configApi.runtimeConfigSignature(config, APP), signatureOwn, "a global change leaves an Agent with its own mode applied");

    assert.throws(() => configApi.mutateConfig(env, { kind: "set-agent-reply-mode", agentId: APP, value: "both" }, { kind: "user" }), /card\/cli/);
    fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({ ...stored, agents: { ...stored.agents, [APP]: { ...stored.agents[APP], replyMode: "bogus" } } })}\n`, { mode: 0o600 });
    assert.throws(() => configApi.loadConfig(env), /replyMode/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a per-session reply mode overrides the prompt builder default", () => {
  const builder = new ContextPromptBuilder({ replyMode: "card" });
  const input = { agentId: APP, runtime: "codex" };
  assert.equal(builder.build(input).version, "larkin-standing-v42-card");
  assert.equal(builder.build({ ...input, replyMode: "cli" }).version, "larkin-standing-v35");
  assert.equal(new ContextPromptBuilder().build({ ...input, replyMode: "card" }).version, "larkin-standing-v42-card");
});

test("card prompt drops Feishu reply recipes but keeps the safety boundaries", () => {
  const input = { agentId: APP, runtime: "codex" };
  const card = new ContextPromptBuilder({ replyMode: "card" }).build(input).content;
  const cli = new ContextPromptBuilder({ replyMode: "cli" }).build(input).content;
  for (const recipe of ["--page-size 10", "im +chat-search --query", "$'First line", "--text '<exact_body"]) {
    assert.ok(!card.includes(recipe), `card prompt still carries recipe: ${recipe}`);
    assert.ok(cli.includes(recipe), `cli prompt lost recipe: ${recipe}`);
  }
  for (const boundary of ["no bare `lark-cli`", "beginning with `om_`", "`rem_`, `redeliver_`", "never the whole chat",
    "`duplicate: true`", "Freshness never blocks a write", "stays in that thread", "im messages delete --message-id"]) {
    assert.ok(card.includes(boundary), `card prompt lost boundary: ${boundary}`);
  }
});

test("card prompt states once how to answer a group message that does not @ the Agent", () => {
  const card = new ContextPromptBuilder({ replyMode: "card" }).build({ agentId: APP, runtime: "codex" }).content;
  const rule = card.split("\n").find((line) => line.startsWith("Command replies:")) ?? "";
  for (const fact of ['`mentions_you: false`', "reaches no one", "If you decide to answer", "`--reply-in-thread` to start a thread on that message", "main chat stream", "end the turn silently"]) {
    assert.ok(rule.includes(fact), `command-reply rule lost: ${fact}`);
  }
  // The official lark-im skill asks to confirm every reply with the user; an Inbox message needs no such step.
  assert.ok(card.includes("Reply to a polled Inbox message directly."), "card prompt lost the reply authorization");
  assert.ok(card.includes("a thread (Feishu 话题)"), "card prompt lost the thread definition");
  assert.ok(card.includes("is the main chat stream (the `chat:` target)"), "card prompt lost the main chat stream definition");
  assert.ok(!card.includes("回复方式"), "card prompt still points at the removed per-message note");
});

test("card prompt states each rule once and keeps eval-only wording out", () => {
  const input = { agentId: APP, runtime: "codex" };
  const card = new ContextPromptBuilder({ replyMode: "card" }).build(input).content;
  const cli = new ContextPromptBuilder({ replyMode: "cli" }).build(input).content;
  for (const evalOnly of ["这是独立用例", "There is no cooldown or frequency gate."]) {
    assert.ok(!card.includes(evalOnly), `card prompt still carries: ${evalOnly}`);
    assert.ok(cli.includes(evalOnly), `cli prompt lost its pinned wording: ${evalOnly}`);
  }
  assert.equal(card.split("`--as user`").length - 1, 1, "the identity hard limits appear once");
  assert.ok(card.includes("`mentions_you: true`"), "card replies are keyed on the mention field");
  const mentions = card.split("\n").find((line) => line.startsWith("Mentions:")) ?? "";
  for (const fact of ["a person or an Agent", "`<at user_id=\\\"<open_id>\\\"></at>`", "card text and a plain `@name` read as ordinary words"]) {
    assert.ok(mentions.includes(fact.replaceAll("\\\"", "\"")), `mention rule lost: ${fact}`);
  }
});
