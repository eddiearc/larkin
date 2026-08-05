import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cliModule = await import(pathToFileURL(path.join(ROOT, "dist/app/agent-cli.mjs")).href);
const stateModule = await import(pathToFileURL(path.join(ROOT, "dist/agent/agent-state-store.mjs")).href);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-agent-cli-"));
  const agentId = "cli_agentCliA1";
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 3,
    serverId: "server-agent-cli",
    activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "gpt-5.6-sol", effort: "high", createdAt: "2026-07-19T00:00:00.000Z" } },
  })}\n`, { mode: 0o600 });
  const store = stateModule.createAgentStateStore(root, agentId);
  fs.mkdirSync(path.join(root, "bots"), { recursive: true });
  fs.writeFileSync(path.join(root, "bots", `${agentId}.json`), JSON.stringify({ capabilities: { cardActionCallback: {
    status: "verified-effective", requestedAt: "2026-07-19T00:00:00.000Z", verifiedAt: "2026-07-19T00:01:00.000Z",
  } } }), { mode: 0o600 });
  const env = { LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId };
  const output = { stdout: "", stderr: "" };
  const io = {
    stdout(text) { output.stdout += text; },
    stderr(text) { output.stderr += text; },
  };
  const run = (argv, extra = {}) => {
    output.stdout = "";
    output.stderr = "";
    const code = cliModule.runAgentCli(argv, env, { io, stateStore: store, ...extra });
    return code instanceof Promise ? code.then((resolved) => ({ code: resolved, ...output })) : { code, ...output };
  };
  return { root, agentId, store, env, run };
}

test("Agent CLI manifest is the single machine-readable public command inventory", () => {
  assert.deepEqual(cliModule.AGENT_CLI_CAPABILITIES.commands.inbox, ["check", "poll"]);
  assert.deepEqual(cliModule.AGENT_CLI_CAPABILITIES.commands.comment, ["reply"]);
  assert.deepEqual(cliModule.AGENT_CLI_CAPABILITIES.commands.reminder, ["schedule", "list", "snooze", "update", "cancel", "log"]);
  assert.deepEqual(cliModule.AGENT_CLI_CAPABILITIES.commands.interaction, ["callback-status", "callback-probe", "create", "get", "resolve"]);
  assert.deepEqual(cliModule.AGENT_CLI_CAPABILITIES.commands.profile, ["show"]);
  assert.deepEqual(cliModule.AGENT_CLI_CAPABILITIES.commands.config, ["show", "runtime", "model", "effort", "mention", "apply"]);
  const f = fixture();
  try {
    const help = JSON.parse(f.run(["--help"]).stdout);
    assert.equal(help.usage, "larkin <inbox|comment|reminder|interaction|profile|config> ...");
    assert.deepEqual(Object.keys(help.capabilities.commands), ["inbox", "comment", "reminder", "interaction", "profile", "config"]);
    assert.equal("removed" in help.capabilities, false, "help must not advertise removed command names");
    assert.equal("removed" in cliModule.AGENT_CLI_CAPABILITIES, false, "public manifest must contain only usable commands");
    for (const operation of cliModule.AGENT_CLI_CAPABILITIES.commands.config) {
      for (const helpFlag of ["--help", "-h"]) {
        const output = { stdout: "", stderr: "" };
        const code = cliModule.runAgentCli(["config", operation, helpFlag], {}, {
          io: { stdout(text) { output.stdout += text; }, stderr(text) { output.stderr += text; } },
        });
        assert.equal(code, 0, `${operation} ${helpFlag} must be config-free`);
        const nestedHelp = JSON.parse(output.stdout);
        assert.equal(nestedHelp.usage.some((line) => line.includes(`config ${operation}`)), true, `${operation} missing from shared help contract`);
      }
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("Agent config commands support global, explicit cross-Agent targets, and safe apply", async () => {
  const f = fixture();
  try {
    const other = "cli_agentCliB2";
    const storedFixture = JSON.parse(fs.readFileSync(path.join(f.root, "config.json"), "utf8"));
    storedFixture.agents[other] = { runtime: "claude", model: "sonnet" };
    fs.writeFileSync(path.join(f.root, "config.json"), `${JSON.stringify(storedFixture)}\n`, { mode: 0o600 });
    const shown = f.run(["config", "show", "--chat", "oc_self"]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).agents[0].agentId, f.agentId);

    const mention = f.run(["config", "mention", "chat", "oc_self", "free"]);
    assert.equal(mention.code, 0, mention.stderr);
    assert.equal(JSON.parse(mention.stdout).applyState, "saved_not_applied");
    let stored = JSON.parse(fs.readFileSync(path.join(f.root, "config.json"), "utf8"));
    assert.deepEqual(stored.agents[f.agentId].chatMentionPolicies, { oc_self: "free" });

    const model = f.run(["config", "model", "default"], { modelDirectory: () => [{ id: "default", label: "default: gpt-5.6-sol" }] });
    assert.equal(model.code, 0, model.stderr);
    assert.equal(JSON.parse(model.stdout).applyState, "saved_not_applied");
    stored = JSON.parse(fs.readFileSync(path.join(f.root, "config.json"), "utf8"));
    assert.equal(stored.agents[f.agentId].model, "default");
    assert.equal("effort" in stored.agents[f.agentId], false);

    assert.equal(f.run(["config", "mention", "global", "free"]).code, 0);
    assert.equal(f.run(["config", "mention", "agent", "free", "--agent", other]).code, 0);
    assert.equal(JSON.parse(f.run(["config", "show", "--agent", other]).stdout).agents[0].agentId, other);
    let appliedTarget;
    const applied = await f.run(["config", "apply", "--agent", other], {
      requestAgentUpsert: async ({ agentId }) => { appliedTarget = agentId; return { ok: true }; },
    });
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(appliedTarget, other);
    const busy = await f.run(["config", "apply"], {
      requestAgentUpsert: async () => ({ ok: false, error: "Agent 正忙" }),
    });
    assert.equal(busy.code, 2);
    assert.match(busy.stderr, /已保存但未应用.*正忙.*config --help/);
    const storedAfter = JSON.parse(fs.readFileSync(path.join(f.root, "config.json"), "utf8"));
    assert.equal(storedAfter.mentionPolicy, "free");
    assert.equal(storedAfter.agents[other].mentionPolicy, "free");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("Agent config commands reject extra positionals and operation-inapplicable flags without changing config bytes", () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(path.join(f.root, "config.json"));
    const invalidCases = [
      ["show", "extra"],
      ["show", "--model", "default"],
      ["runtime", "pi", "extra"],
      ["runtime", "pi", "--chat", "oc_irrelevant"],
      ["model", "default", "extra"],
      ["model", "default", "--json"],
      ["effort", "default", "extra"],
      ["effort", "default", "--chat", "oc_irrelevant"],
      ["mention", "global", "free", "extra"],
      ["mention", "global", "free", "--agent", f.agentId],
      ["mention", "global", "free", "--chat", "oc_irrelevant"],
      ["mention", "agent", "free", "unexpected", "--agent", f.agentId],
      ["mention", "agent", "free", "--chat", "oc_irrelevant"],
      ["mention", "chat", "oc_self", "free", "extra"],
      ["mention", "chat", "oc_self", "free", "--json"],
      ["apply", "extra"],
      ["apply", "--chat", "oc_irrelevant"],
    ];
    for (const args of invalidCases) {
      const rejected = f.run(["config", ...args]);
      assert.equal(rejected.code, 2, `${args.join(" ")} unexpectedly succeeded`);
      assert.match(rejected.stderr, /用法|不支持参数|只接受/);
      assert.deepEqual(fs.readFileSync(path.join(f.root, "config.json")), before, `${args.join(" ")} changed config bytes`);
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("Agent CLI config load failures do not disclose the absolute config path", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-agent-missing-config-private-"));
  try {
    const output = { stdout: "", stderr: "" };
    const code = cliModule.runAgentCli(["config", "show"], { LARKIN_CONFIG_DIR: temp, LARKIN_AGENT_ID: "cli_missingA1" }, {
      io: { stdout(text) { output.stdout += text; }, stderr(text) { output.stderr += text; } },
    });
    assert.equal(code, 2);
    assert.doesNotMatch(output.stderr, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(output.stderr, /config\.json/);
    assert.doesNotMatch(output.stderr, /\n\s*at\s/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Agent config model and effort use each Runtime's dynamic directory and remain readable in a fresh process", () => {
  const cases = [
    {
      runtime: "codex", initial: "gpt-5.6-sol", dynamic: "gpt-agent-dynamic-1", alternate: "gpt-agent-alternate-1", effort: "high", rejectedEffort: "low",
      models: [{ id: "default", label: "default: gpt-agent-dynamic-1" }, { id: "gpt-agent-dynamic-1", label: "Agent Dynamic", supportedReasoningEfforts: ["high"] }, { id: "gpt-agent-alternate-1", label: "Alternate", supportedReasoningEfforts: ["low"] }],
    },
    {
      runtime: "claude", initial: "sonnet", dynamic: "claude-agent-dynamic-1", alternate: "claude-agent-alternate-1", effort: "medium", rejectedEffort: "high",
      models: [{ id: "default", label: "default: claude-agent-dynamic-1" }, { id: "claude-agent-dynamic-1", label: "Agent Dynamic", supportedReasoningEfforts: ["medium"] }, { id: "claude-agent-alternate-1", label: "Alternate", supportedReasoningEfforts: ["high"] }],
    },
    {
      runtime: "pi", initial: "mock/initial", dynamic: "mock/agent-dynamic-1", alternate: "mock/agent-alternate-1", effort: "max", rejectedEffort: "high",
      models: [{ id: "default", label: "default: mock/agent-dynamic-1" }, { id: "mock/agent-dynamic-1", label: "Agent Dynamic · mock", supportedReasoningEfforts: ["max"] }, { id: "mock/agent-alternate-1", label: "Alternate · mock", supportedReasoningEfforts: ["high"] }],
    },
  ];
  for (const runtimeCase of cases) {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.root, "config.json"), `${JSON.stringify({
        version: 4, serverId: `server-agent-cli-${runtimeCase.runtime}`, mentionPolicy: "require", activeAgent: f.agentId,
        agents: { [f.agentId]: { runtime: runtimeCase.runtime, model: runtimeCase.initial } },
      })}\n`, { mode: 0o600 });
      const directoryCalls = [];
      const modelDirectory = (input) => { directoryCalls.push(input); return runtimeCase.models; };

      const model = f.run(["config", "model", runtimeCase.dynamic], { modelDirectory });
      assert.equal(model.code, 0, `${runtimeCase.runtime}: ${model.stderr}`);
      const effort = f.run(["config", "effort", runtimeCase.effort], { modelDirectory });
      assert.equal(effort.code, 0, `${runtimeCase.runtime}: ${effort.stderr}`);
      assert.equal(directoryCalls.every((call) => call.runtime === runtimeCase.runtime && call.agentId === f.agentId && call.cwd === path.join(f.root, "agents", f.agentId)), true);

      const fresh = spawnSync(process.execPath, [path.join(ROOT, "dist/app/agent-cli.mjs"), "config", "show"], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, ...f.env },
      });
      assert.equal(fresh.status, 0, `${runtimeCase.runtime}: ${fresh.stderr}`);
      assert.deepEqual(
        { model: JSON.parse(fresh.stdout).agents[0].model, effort: JSON.parse(fresh.stdout).agents[0].effort },
        { model: runtimeCase.dynamic, effort: runtimeCase.effort },
      );

      const beforeRejected = fs.readFileSync(path.join(f.root, "config.json"), "utf8");
      const unavailable = f.run(["config", "model", runtimeCase.runtime === "pi" ? "mock/not-available" : "safe-not-available"], { modelDirectory });
      assert.equal(unavailable.code, 2);
      assert.match(unavailable.stderr, /当前.*目录|不在.*目录|合法模型/);
      const unsupported = f.run(["config", "effort", runtimeCase.rejectedEffort], { modelDirectory });
      assert.equal(unsupported.code, 2);
      assert.match(unsupported.stderr, /声明支持|不支持|合法档位/);
      assert.equal(fs.readFileSync(path.join(f.root, "config.json"), "utf8"), beforeRejected);

      const alternate = f.run(["config", "model", runtimeCase.alternate], { modelDirectory });
      assert.equal(alternate.code, 0, alternate.stderr);
      assert.equal("effort" in JSON.parse(fs.readFileSync(path.join(f.root, "config.json"), "utf8")).agents[f.agentId], false,
        "changing model clears the old model's effort before it can become invalid");

      const restored = f.run(["config", "model", "default"], { modelDirectory });
      assert.equal(restored.code, 0, restored.stderr);
      const defaultEffort = f.run(["config", "effort", runtimeCase.effort], { modelDirectory });
      assert.equal(defaultEffort.code, 2);
      assert.match(defaultEffort.stderr, /default.*effort|不能设置/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("Agent CLI process consumes native-shaped Codex, Claude, and Pi directory fixtures", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-agent-cli-native-directories-"));
  const bin = path.join(temp, "bin");
  const entry = path.join(ROOT, "dist", "app", "agent-cli.mjs");
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env bun
let input="";process.stdin.on("data",c=>{input+=c;for(;;){const i=input.indexOf("\\n");if(i<0)break;const request=JSON.parse(input.slice(0,i));input=input.slice(i+1);if(request.method==="model/list")process.stdout.write(JSON.stringify({id:request.id,result:{data:[{id:"gpt-agent-process-1",model:"gpt-agent-process-1",displayName:"Agent Process",hidden:false,isDefault:true,supportedReasoningEfforts:[{reasoningEffort:"high"}]}]}})+"\\n")}});`);
    fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env bun
let input="";process.stdin.on("data",c=>{input+=c;for(;;){const i=input.indexOf("\\n");if(i<0)break;const request=JSON.parse(input.slice(0,i));input=input.slice(i+1);if(request.request?.subtype==="list_models")process.stdout.write(JSON.stringify({type:"control_response",response:{request_id:request.request_id,subtype:"success",response:{models:[{value:"default",displayName:"Default",resolvedModel:"claude-agent-process-1",supportsEffort:false,supportedEffortLevels:[]},{value:"claude-agent-process-1",displayName:"Agent Process",resolvedModel:"claude-agent-process-1",supportsEffort:true,supportedEffortLevels:["high"]}]}}})+"\\n")}});`);
    fs.chmodSync(path.join(bin, "codex"), 0o755);
    fs.chmodSync(path.join(bin, "claude"), 0o755);

    for (const runtimeCase of [
      { runtime: "codex", model: "gpt-agent-process-1" },
      { runtime: "claude", model: "claude-agent-process-1" },
      { runtime: "pi", model: "mock/pi-agent-process-1" },
    ]) {
      const root = path.join(temp, runtimeCase.runtime);
      const agentId = `cli_native${runtimeCase.runtime[0].toUpperCase()}A1`;
      fs.mkdirSync(path.join(root, "agents", agentId), { recursive: true });
      fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
        version: 4, serverId: `server-native-${runtimeCase.runtime}`, mentionPolicy: "require", activeAgent: agentId,
        agents: { [agentId]: { runtime: runtimeCase.runtime, model: "default" } },
      })}\n`, { mode: 0o600 });
      const modelDirectoryFixture = path.join(root, "model-directory.json");
      fs.writeFileSync(modelDirectoryFixture, `${JSON.stringify({ models: [
        { id: "default", label: `default: ${runtimeCase.model}` },
        { id: runtimeCase.model, label: "Agent Process", supportedReasoningEfforts: ["high"] },
      ] })}\n`);
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH || ""}`,
        LARKIN_CONFIG_DIR: root,
        LARKIN_AGENT_ID: agentId,
        LARKIN_TEST_RUNTIME_MODEL_DIRECTORY_FILE: modelDirectoryFixture,
      };
      const run = (...args) => spawnSync(process.execPath, [entry, ...args], { cwd: ROOT, encoding: "utf8", env, timeout: 30_000 });
      const directory = spawnSync(process.execPath, [path.join(ROOT, "dist/app/runtime-model-directory.mjs"), runtimeCase.runtime, path.join(root, "agents", agentId)], {
        cwd: ROOT, encoding: "utf8", env, timeout: 30_000,
      });
      assert.equal(directory.status, 0, `${runtimeCase.runtime}: ${directory.stderr}`);
      const defaultRow = JSON.parse(directory.stdout).models[0];
      assert.deepEqual(defaultRow, { id: "default", label: `default: ${runtimeCase.model}` });
      const selected = run("config", "model", runtimeCase.model);
      assert.equal(selected.status, 0, `${runtimeCase.runtime}: ${selected.stderr}`);
      const effort = run("config", "effort", "high");
      assert.equal(effort.status, 0, `${runtimeCase.runtime}: ${effort.stderr}`);
      const beforeRejected = fs.readFileSync(path.join(root, "config.json"), "utf8");
      const unavailable = run("config", "model", runtimeCase.runtime === "pi" ? "mock/not-available" : "safe-not-available");
      assert.equal(unavailable.status, 2);
      const unsupported = run("config", "effort", "low");
      assert.equal(unsupported.status, 2);
      assert.equal(fs.readFileSync(path.join(root, "config.json"), "utf8"), beforeRejected);
      const shown = run("config", "show");
      assert.equal(shown.status, 0, `${runtimeCase.runtime}: ${shown.stderr}`);
      assert.deepEqual(
        { model: JSON.parse(shown.stdout).agents[0].model, effort: JSON.parse(shown.stdout).agents[0].effort },
        { model: runtimeCase.model, effort: "high" },
      );
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("inbox check is repeatable and content-light while poll direct-acks a bounded target batch", async () => {
  const f = fixture();
  try {
    f.store.writeJson("runtimeDeliveries", {
      version: 1,
      owner: "preserved",
      records: [
        { deliveryId: "d1", messageId: "om_1", status: "accepted", input: { text: "wake" }, updatedAt: "2026-07-19T00:00:00.000Z", extra: 7 },
        { deliveryId: "d2", messageId: "om_other", status: "pending", input: {}, updatedAt: "2026-07-19T00:00:00.000Z" },
      ],
    });
    f.store.appendNdjson("inbox", { message_id: "om_1", chat_id: "oc_1", sender_id: "ou_1", content: "secret body", seq: 4 });
    f.store.appendNdjson("inbox", { message_id: "om_2", chat_id: "oc_1", sender_id: "ou_1", content: "second body", seq: 5 });
    f.store.appendNdjson("inbox", { message_id: "om_other", chat_id: "oc_2", sender_id: "ou_2", content: "other body", seq: 6 });
    const beforeInbox = fs.readFileSync(f.store.paths.inbox);
    const beforeDeliveries = fs.readFileSync(f.store.paths.runtimeDeliveries);
    const first = f.run(["inbox", "check"]);
    const second = f.run(["inbox", "check"]);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), JSON.parse(second.stdout));
    assert.equal(JSON.stringify(JSON.parse(first.stdout)).includes("secret body"), false);
    assert.deepEqual(JSON.parse(first.stdout).targets.map(({ target, pending_count }) => ({ target, pending_count })), [
      { target: "chat:oc_1", pending_count: 2 },
      { target: "chat:oc_2", pending_count: 1 },
    ]);
    assert.deepEqual(fs.readFileSync(f.store.paths.inbox), beforeInbox, "check must not mutate Inbox bytes");
    assert.deepEqual(fs.readFileSync(f.store.paths.runtimeDeliveries), beforeDeliveries, "check must not consume Runtime delivery state");

    const telemetryCalls = [];
    const telemetry = {
      async externalPhase(agentId, stateDir, name, kind, operation, boundary) {
        telemetryCalls.push({ agentId, stateDir, name, kind, boundary });
        return operation();
      },
    };
    const firstPoll = await f.run(["inbox", "poll", "--target", "chat:oc_1", "--limit", "1"], { telemetry });
    assert.equal(firstPoll.code, 0, firstPoll.stderr);
    assert.deepEqual(telemetryCalls, [{ agentId: f.agentId, stateDir: f.store.paths.root, name: "inbox.consume", kind: 4, boundary: "agent_cli" }]);
    const polled = JSON.parse(firstPoll.stdout);
    assert.equal(polled.delivery, "direct_ack");
    assert.equal(polled.at_most_once, true);
    assert.equal(polled.events.length, 1);
    assert.equal(polled.events[0].content, "secret body");
    assert.equal(polled.pending_count, 1);
    assert.equal(polled.has_more, true);
    assert.match(polled.next_action, /Continue polling the same Inbox scope until has_more is false/);
    assert.equal(polled.seen_through_seq, 1);
    assert.deepEqual(f.store.readNdjson("inbox").map((row) => row.message_id), ["om_2", "om_other"]);
    const deliveries = f.store.readJson("runtimeDeliveries", null);
    assert.equal(deliveries.owner, "preserved");
    assert.deepEqual({ ...deliveries.records[0], updatedAt: "<changed>" }, {
      deliveryId: "d1", messageId: "om_1", status: "consumed", input: { text: "wake" }, updatedAt: "<changed>", extra: 7,
    });
    assert.equal(deliveries.records[1].status, "pending");
    assert.equal(JSON.parse(f.run(["inbox", "check"]).stdout).targets.find((row) => row.target === "chat:oc_1").pending_count, 1);
    const finalPoll = JSON.parse(f.run(["inbox", "poll", "--target", "chat:oc_1"]).stdout);
    assert.equal(finalPoll.events[0].message_id, "om_2");
    assert.equal(finalPoll.pending_count, 0);
    assert.equal(finalPoll.has_more, false);
    assert.equal("next_action" in finalPoll, false);
    const emptyPoll = JSON.parse(f.run(["inbox", "poll", "--target", "chat:oc_1"]).stdout);
    assert.deepEqual(emptyPoll.events, []);
    assert.equal(emptyPoll.pending_count, 0);
    assert.equal(emptyPoll.has_more, false);
    assert.deepEqual(f.store.readNdjson("inbox").map((row) => row.message_id), ["om_other"], "unrelated target must remain pending");

    f.store.appendNdjson("inbox", { message_id: "om_other_2", chat_id: "oc_3", content: "another target" });
    const globalPartial = JSON.parse(f.run(["inbox", "poll", "--limit", "1"]).stdout);
    assert.deepEqual(globalPartial.events.map((row) => row.message_id), ["om_other"]);
    assert.equal(globalPartial.pending_count, 1, "an unscoped poll counts all remaining consumable rows");
    assert.equal(globalPartial.has_more, true);
    const globalFinal = JSON.parse(f.run(["inbox", "poll", "--limit", "1"]).stdout);
    assert.deepEqual(globalFinal.events.map((row) => row.message_id), ["om_other_2"]);
    assert.equal(globalFinal.pending_count, 0);
    assert.equal(globalFinal.has_more, false);

    fs.writeFileSync(f.store.paths.inbox, '{"message_id":"om_bad"}\nnot-json\n');
    const deliveryBytes = fs.readFileSync(f.store.paths.runtimeDeliveries, "utf8");
    const malformed = await f.run(["inbox", "poll"], { telemetry });
    assert.equal(malformed.code, 2);
    assert.match(malformed.stderr, /invalid NDJSON/);
    assert.equal(fs.readFileSync(f.store.paths.inbox, "utf8"), '{"message_id":"om_bad"}\nnot-json\n');
    assert.equal(fs.readFileSync(f.store.paths.runtimeDeliveries, "utf8"), deliveryBytes, "failed parse must not mutate correlation state");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("current Agent-facing docs and prompts do not teach removed Agent commands", () => {
  const files = ["README.md"];
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.doesNotMatch(text, /larkin (?:message|channel|attachment|server|task claim)\b/, file);
  }
});

test("an artificially old but live Inbox lock cannot be reclaimed by a cross-process append", async () => {
  const f = fixture();
  const marker = path.join(f.root, "append-started");
  const appended = path.join(f.root, "append-complete");
  const moduleFile = path.join(ROOT, "dist/agent/agent-state-store.cjs");
  let child;
  try {
    f.store.appendNdjson("inbox", { message_id: "om_old" });
    const drained = f.store.pollInbox({
      afterRead() {
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(`${f.store.paths.inbox}.lock`, old, old);
        child = spawn(process.execPath, ["-e", `
const fs = require("node:fs");
const { createAgentStateStore } = require(process.argv[1]);
fs.writeFileSync(process.argv[4], "started");
createAgentStateStore(process.argv[2], process.argv[3]).appendNdjson("inbox", { message_id: "om_new" });
fs.writeFileSync(process.argv[5], "complete");
`, moduleFile, f.root, f.agentId, marker, appended], { stdio: "ignore" });
        const deadline = Date.now() + 2_000;
        while (!fs.existsSync(marker) && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        assert.equal(fs.existsSync(marker), true, "child must attempt append while drain owns the lock");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        assert.equal(fs.existsSync(appended), false, "live owner must win even when lock mtime exceeds the former stale threshold");
      },
    });
    assert.deepEqual(drained.envelopes.map((row) => row.message_id), ["om_old"]);
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.deepEqual(f.store.readNdjson("inbox").map((row) => row.message_id), ["om_new"]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("reminder commands wire the existing schedule/list/snooze/update/cancel/log service", () => {
  const f = fixture();
  try {
    let current = Date.parse("2026-07-19T01:00:00.000Z");
    const deps = { now: () => current, timeZone: () => "Asia/Shanghai" };
    const scheduled = f.run(["reminder", "schedule", "--title", "follow up", "--delay-seconds", "60", "--message-id", "om_1"], deps);
    assert.equal(scheduled.code, 0, scheduled.stderr);
    const id = JSON.parse(scheduled.stdout).reminder.reminderId;
    assert.equal(JSON.parse(f.run(["reminder", "list"], deps).stdout).reminders.length, 1);
    current += 1_000;
    assert.equal(JSON.parse(f.run(["reminder", "snooze", "--id", id, "--delay-seconds", "30"], deps).stdout).reminder.fireAt, "2026-07-19T01:00:31.000Z");
    assert.equal(JSON.parse(f.run(["reminder", "update", "--id", id, "--title", "renamed"], deps).stdout).reminder.title, "renamed");
    assert.deepEqual(JSON.parse(f.run(["reminder", "log", "--id", id], deps).stdout).events.map((event) => event.eventType), ["scheduled", "snoozed", "updated"]);
    assert.equal(JSON.parse(f.run(["reminder", "cancel", "--id", id], deps).stdout).reminder.status, "canceled");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("callback probe is the only path from requested to verified-effective readiness", async () => {
  const f = fixture();
  try {
    const credentialFile = path.join(f.root, "bots", `${f.agentId}.json`);
    fs.writeFileSync(credentialFile, JSON.stringify({ capabilities: { cardActionCallback: {
      status: "requested-unverified", requestedAt: "2026-07-23T00:00:00.000Z",
    } } }), { mode: 0o600 });
    assert.equal(JSON.parse(f.run(["interaction", "callback-status"]).stdout).status, "requested-unverified");
    const probe = f.run(["interaction", "callback-probe"], { now: () => Date.parse("2026-07-23T00:01:00.000Z") });
    assert.equal(probe.code, 0, probe.stderr);
    const payload = JSON.parse(probe.stdout);
    assert.equal(payload.status, "probe-issued");
    assert.equal(JSON.parse(payload.message_content).body.elements.some((item) => item.tag === "action"), false);
    const nonce = JSON.parse(payload.message_content).body.elements.find((item) => item.tag === "button")
      .behaviors.find((behavior) => behavior.type === "callback").value.larkin_callback_probe;
    const capability = await import(pathToFileURL(path.join(ROOT, "dist/platform/callback-capability.mjs")).href);
    assert.equal(capability.verifyCallbackProbe(f.root, f.agentId, nonce, "evt_probe"), true);
    assert.equal(JSON.parse(f.run(["interaction", "callback-status"]).stdout).status, "verified-effective");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("interaction commands create, inspect, and resolve through the durable state machine", async () => {
  const f = fixture();
  try {
    const specFile = path.join(f.root, "interaction.json");
    fs.writeFileSync(specFile, JSON.stringify({
      schema_version: 1,
      initial_state: "pending",
      expires_in_seconds: 3600,
      audience: { open_ids: ["ou_requester"] },
      states: {
        pending: { title: "Request", markdown: "Waiting." },
        processing: { title: "Request", markdown: "Agent is processing." },
        done: { title: "Done", markdown: "Completed.", terminal: true },
        failed: { title: "Failed", markdown: "Failed.", terminal: true },
      },
      actions: {
        run: {
          from: ["pending"], label: "Run", success_state: "done", failure_state: "failed", processing_state: "processing",
          agent: { instruction: "Verify and execute." }, reflex: { toast: "Accepted." },
          result_schema: { properties: {}, required: [], additional_properties: false },
        },
      },
    }));
    const created = f.run(["interaction", "create", "--spec-file", specFile, "--chat-id", "oc_cli_test"]);
    assert.equal(created.code, 0, created.stderr);
    const payload = JSON.parse(created.stdout);
    assert.equal(JSON.parse(payload.message_content).schema, "2.0");
    const credentialFile = path.join(f.root, "bots", `${f.agentId}.json`);
    fs.rmSync(credentialFile);
    const blocked = f.run(["interaction", "create", "--spec-file", specFile, "--chat-id", "oc_cli_test"]);
    assert.equal(blocked.code, 2);
    assert.match(blocked.stderr, /card\.action\.trigger.*verified-effective/);
    fs.writeFileSync(credentialFile, JSON.stringify({ capabilities: { cardActionCallback: {
      status: "verified-effective", requestedAt: "2026-07-19T00:00:00.000Z", verifiedAt: "2026-07-19T00:01:00.000Z",
    } } }), { mode: 0o600 });
    const inspected = f.run(["interaction", "get", "--instance-id", payload.instance.instance_id]);
    assert.equal(inspected.code, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).instance.current_state, "pending");

    const ref = payload.card.body.elements.find((item) => item.tag === "button")
      .behaviors.find((behavior) => behavior.type === "callback").value.interaction_ref;
    const machine = new (await import(pathToFileURL(path.join(ROOT, "dist/agent/interaction-state-machine.mjs")).href)).InteractionStateMachine({ stateStore: f.store, agentId: f.agentId });
    const claimed = machine.claim({ interaction_ref: ref, expected_version: 1, callback_id: "cb_cli", operator_open_id: "ou_requester", chat_id: "oc_cli_test", message_id: "om_cli_card" });
    machine.recordReflex(claimed.run.run_id, { status: "succeeded", summary: "accepted" });
    const resolved = f.run(["interaction", "resolve", "--run-id", claimed.run.run_id, "--expected-version", "2", "--status", "succeeded", "--summary", "finished"]);
    assert.equal(resolved.code, 0, resolved.stderr);
    assert.equal(JSON.parse(resolved.stdout).instance.current_state, "done");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("profile show is local and the removed internal IM surface points to larkin", () => {
  const f = fixture();
  try {
    f.store.writeJson("botIdentity", { open_id: "ou_bot", name: "Larkin Bot", avatar_url: "https://example.test/avatar.png" });
    const profile = f.run(["profile", "show"]);
    assert.equal(profile.code, 0, profile.stderr);
    assert.deepEqual(JSON.parse(profile.stdout), {
      kind: "agent", id: f.agentId, isSelf: true, name: "Larkin Bot", displayName: "Larkin Bot", openId: "ou_bot",
      avatarUrl: "https://example.test/avatar.png", runtime: "codex", model: "gpt-5.6-sol", reasoningEffort: "high",
      createdAt: "2026-07-19T00:00:00.000Z",
    });

    let call;
    const spawn = (command, args, options) => {
      call = { command, args, options };
      return { status: 0, signal: null, output: [], pid: 1, stdout: '{"ok":true}\n', stderr: "", error: undefined };
    };
    const im = f.run(["im", "+chat-list", "--json"], { spawn });
    assert.equal(im.code, 2);
    assert.match(im.stderr, /larkin im/);
    assert.equal(call, undefined, "migration must happen before any spawn");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("Agent CLI does not retain a second IM argv surface", () => {
  const f = fixture();
  try {
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, signal: null, output: [], pid: 1, stdout: '{"ok":true}\n', stderr: "", error: undefined };
    };

    const migrated = f.run(["im", "+messages-reply", "--message-id", "om_x", "--text", "**raw**"], { spawn });
    assert.equal(migrated.code, 2);
    assert.match(migrated.stderr, /`larkin im/);
    assert.deepEqual(calls, []);

  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("removed Agent commands fail locally with precise migration guidance", () => {
  const f = fixture();
  try {
    for (const [argv, expected] of [
      [["message", "check"], /inbox check/],
      [["message", "send"], /messages-send/],
      [["channel", "members"], /chat-list/],
      [["attachment", "upload"], /messages-send/],
      [["server", "info"], /server 已移除/],
      [["profile", "update"], /只保留.*profile show/],
    ]) {
      const result = f.run(argv);
      assert.equal(result.code, 2, JSON.stringify(argv));
      assert.match(result.stderr, expected);
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("Agent CLI refuses ambient activeAgent fallback", () => {
  const f = fixture();
  try {
    const output = { stdout: "", stderr: "" };
    const code = cliModule.runAgentCli(["profile", "show"], { LARKIN_CONFIG_DIR: f.root }, {
      io: { stdout: (text) => { output.stdout += text; }, stderr: (text) => { output.stderr += text; } },
    });
    assert.equal(code, 2);
    assert.match(output.stderr, /authority marker|LARKIN_AGENT_ID/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("Agent CLI executes when its argv path contains a symlinked directory", () => {
  const f = fixture();
  try {
    const linkedRoot = path.join(f.root, "linked-root");
    fs.symlinkSync(ROOT, linkedRoot, "dir");
    const cliPath = path.join(linkedRoot, "dist/app/agent-cli.mjs");
    const result = spawnSync(process.execPath, [cliPath, "profile", "show"], {
      cwd: f.root,
      env: { ...process.env, ...f.env },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).id, f.agentId);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
