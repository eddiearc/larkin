import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { runSessionCli } from "../../../dist/app/session-cli.mjs";

test("public session reset emits stable truthful JSON without raw session identifiers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-session-cli-"));
  const agentId = "cli_resetPublicA1";
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ version: 3, serverId: "server-test", activeAgent: agentId,
    agents: { [agentId]: { runtime: "pi", model: "openai/gpt-5" } } }), { mode: 0o600 });
  let stdout = "", stderr = "", request;
  try {
    const code = await runSessionCli(["reset", "--agent", agentId, "--json", "--wait-ready", "2", "--operation-id", "operation_public_1"],
      { ...process.env, LARKIN_CONFIG_DIR: root }, {
        async request(input) { request = input; return { ok: true, operationId: input.operationId, agentId,
          resetCommitted: true, generationChanged: true, sessionChanged: true, turns: 0,
          runtimeReady: true, channelConnected: true, reconnecting: false, pendingCount: 0,
          readyForFreshScenario: true, inboundObserved: false }; },
        io: { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } },
      });
    assert.equal(code, 0, stderr);
    assert.equal(request.waitReadyMs, 2_000);
    const result = JSON.parse(stdout);
    assert.deepEqual(result, { ok: true, operation_id: "operation_public_1", agent_id: agentId,
      reset_committed: true, generation_changed: true, session_changed: true, turns: 0,
      runtime_ready: true, channel_connected: true, reconnecting: false, pending_count: 0,
      ready_for_fresh_scenario: true, inbound_observed: false });
    assert.doesNotMatch(stdout, /session-[0-9]|stateDir|credential/i);
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
  const code = await runSessionCli(["reset", "--json", "--agent", "cli_parseA1", "--operation-id", "operation_user_1"],
    { LARKIN_AGENT_ID: "cli_runtimeA1" }, { async request() { calls += 1; throw new Error("must not run"); },
      io: { stdout: (value) => { stdout += value; }, stderr() {} } });
  assert.equal(code, 1);
  assert.equal(calls, 0);
  assert.equal(JSON.parse(stdout).code, "user_authority_required");
});
