import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { runSessionCli } from "../../../dist/app/session-cli.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("public session reset emits stable truthful JSON without raw session identifiers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-session-cli-"));
  const agentId = "cli_resetPublicA1";
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ version: 3, serverId: "server-test", activeAgent: agentId,
    agents: { [agentId]: { runtime: "pi", model: "openai/gpt-5" } } }), { mode: 0o600 });
  let stdout = "", stderr = "", request;
  try {
    const code = await runSessionCli(["reset", "--agent", agentId, "--json", "--wait-ready", "2"],
      { ...process.env, LARKIN_CONFIG_DIR: root }, {
        async request(input) { request = input; return { ok: true, agentId,
          resetCommitted: true, generationChanged: true, sessionChanged: true, turns: 0,
          runtimeReady: true, channelConnected: true, reconnecting: false, pendingCount: 0,
          readyForFreshScenario: true, inboundObserved: false }; },
        io: { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } },
      });
    assert.equal(code, 0, stderr);
    assert.equal(request.waitReadyMs, 2_000);
    const result = JSON.parse(stdout);
    assert.equal("operationId" in request, false);
    assert.deepEqual(result, { ok: true, agent_id: agentId,
      reset_committed: true, generation_changed: true, session_changed: true, turns: 0,
      runtime_ready: true, channel_connected: true, reconnecting: false, pending_count: 0,
      ready_for_fresh_scenario: true, inbound_observed: false });
    assert.doesNotMatch(stdout, /session-[0-9]|stateDir|credential/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("public session reset preserves a truthful reconnect refusal projection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-session-cli-refusal-"));
  const agentId = "cli_resetRefusedA1";
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ version: 3, serverId: "server-test", activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "gpt-5.3-codex" } } }), { mode: 0o600 });
  let stdout = "";
  try {
    const code = await runSessionCli(["reset", "--agent", agentId, "--json"],
      { ...process.env, LARKIN_CONFIG_DIR: root }, {
        async request() { return { ok: false, agentId, code: "channel_reconnecting", error: "channel is reconnecting",
          resetCommitted: false, generationChanged: false, sessionChanged: false, turns: 2,
          runtimeReady: true, channelConnected: true, reconnecting: true, pendingCount: 3,
          readyForFreshScenario: false, inboundObserved: false }; },
        io: { stdout: (value) => { stdout += value; }, stderr() {} },
      });
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(stdout), {
      ok: false, agent_id: agentId, reset_committed: false, generation_changed: false,
      session_changed: false, turns: 2, runtime_ready: true, channel_connected: true,
      reconnecting: true, pending_count: 3, ready_for_fresh_scenario: false,
      inbound_observed: false, code: "channel_reconnecting", error: "channel is reconnecting",
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("public context-overflow recovery requires the exact reason and emits only aggregate replay state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-session-recover-cli-"));
  const agentId = "cli_recoverPublicA1";
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ version: 3, serverId: "server-test", activeAgent: agentId,
    agents: { [agentId]: { runtime: "pi", model: "openai/gpt-5" } } }), { mode: 0o600 });
  let stdout = "", request;
  try {
    const code = await runSessionCli(["recover", "--agent", agentId, "--reason", "context-overflow", "--json", "--wait-ready", "2"],
      { ...process.env, LARKIN_CONFIG_DIR: root }, {
        async requestRecovery(input) { request = input; return { ok: true, agentId, recoveryCommitted: true,
          generationChanged: true, sessionChanged: true, turns: 0, runtimeReady: true, channelConnected: true,
          reconnecting: false, pendingCount: 4, rearmedCount: 4, replayStatus: "pending", remainingPendingCount: 4,
          readyForFreshScenario: true, inboundObserved: false }; },
        io: { stdout: (value) => { stdout += value; }, stderr() {} },
      });
    assert.equal(code, 0);
    assert.equal(request.reason, "context-overflow");
    assert.equal(request.waitReadyMs, 2_000);
    assert.deepEqual(JSON.parse(stdout), { ok: true, agent_id: agentId, recovery_committed: true,
      generation_changed: true, session_changed: true, turns: 0, runtime_ready: true,
      channel_connected: true, reconnecting: false, pending_count: 4, rearmed_count: 4,
      replay_status: "pending", remaining_pending_count: 4, ready_for_fresh_scenario: true,
      inbound_observed: false });
    assert.doesNotMatch(stdout, /message|delivery|session-[0-9]|stateDir|credential|\/tmp/i);
    stdout = "";
    assert.equal(await runSessionCli(["recover", "--agent", agentId, "--reason", "context-overflow", "--json"],
      { ...process.env, LARKIN_CONFIG_DIR: root }, { async requestRecovery() { return { ok: false, agentId,
        recoveryCommitted: false, generationChanged: false, sessionChanged: false, turns: 0, runtimeReady: false,
        channelConnected: false, reconnecting: false, pendingCount: 4, rearmedCount: 0, replayStatus: "not_started",
        remainingPendingCount: 4, readyForFreshScenario: false, inboundObserved: false, code: "runtime_unavailable",
        error: "raw /private/session-id message body credential=secret", readiness: { runtime: "pi", state: "unavailable",
          executable: "/private/bin/pi", reason: "raw provider response /private", nextAction: "raw secret" } }; }, io: { stdout: (value) => { stdout += value; }, stderr() {} } }), 1);
    assert.doesNotMatch(stdout, /raw|private|session-id|message body|credential|secret|\/tmp/i);
    assert.deepEqual(JSON.parse(stdout).readiness, { runtime: "pi", state: "unavailable",
      reason: "Runtime readiness is unavailable.", nextAction: "Inspect Runtime/provider configuration, then retry." });
    for (const [argv, expected] of [
      [["recover", "--agent", agentId, "--json"], /--reason context-overflow is required/],
      [["recover", "--agent", agentId, "--reason", "quota", "--json"], /--reason context-overflow is required/],
      [["reset", "--agent", agentId, "--reason", "context-overflow", "--json"], /--reason is only valid/],
    ]) {
      let invalid = "";
      assert.equal(await runSessionCli(argv, {}, { requestRecovery: async () => { throw new Error("must not run"); }, io: { stdout: (value) => { invalid += value; }, stderr() {} } }), 1);
      assert.equal(JSON.parse(invalid).code, "invalid_arguments");
      assert.match(JSON.parse(invalid).error, expected);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("session reset is user-only and rejects malformed argv before control access", async () => {
  const cases = [
    [[], /unsupported session subcommand/],
    [["show", "--json"], /unsupported session subcommand/],
    [["reset", "--agent", "cli_parseA1"], /--json is required/],
    [["reset", "--json", "--agent"], /missing value/],
    [["reset", "--json", "--agent", "cli_parseA1", "--agent", "cli_parseA1"], /duplicate flag/],
    [["reset", "--json", "--agent", "cli_parseA1", "--wat"], /unknown flag/],
    [["reset", "--json", "--agent", "cli_parseA1", "--operation-id", "operation_user_1"], /unknown flag: --operation-id/],
    [["reset", "--json", "--agent", "cli_parseA1", "extra"], /unexpected positional/],
  ];
  for (const [argv, expected] of cases) {
    let stdout = "", calls = 0;
    const code = await runSessionCli(argv, {}, { async request() { calls += 1; throw new Error("must not run"); },
      io: { stdout: (value) => { stdout += value; }, stderr() {} } });
    assert.equal(code, 1);
    assert.equal(calls, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.code, "invalid_arguments");
    assert.match(result.error, expected);
  }

  let stdout = "", calls = 0;
  const code = await runSessionCli(["reset", "--json", "--agent", "cli_parseA1"],
    { LARKIN_AGENT_ID: "cli_runtimeA1" }, { async request() { calls += 1; throw new Error("must not run"); },
      io: { stdout: (value) => { stdout += value; }, stderr() {} } });
  assert.equal(code, 1);
  assert.equal(calls, 0);
  assert.equal(JSON.parse(stdout).code, "user_authority_required");
});

test("public session help does not expose internal operation IDs", () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, "dist/app/cli.mjs"), "session", "--help"], {
    cwd: ROOT, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /larkin session reset --agent <App ID> --json/);
  assert.doesNotMatch(result.stdout, /operation-id/i);
});
