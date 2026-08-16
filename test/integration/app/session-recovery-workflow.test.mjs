import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function waitForReady(child, output) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (output().includes("ready")) return;
    if (child.exitCode !== null) throw new Error(`workflow harness exited: ${output()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`workflow harness readiness timeout: ${output()}`);
}

function runPublicCli(root, args) {
  const env = { ...process.env, LARKIN_HOME: root, LARKIN_CONFIG_DIR: root };
  delete env.LARKIN_AGENT_ID;
  return spawnSync(process.execPath, [path.join(ROOT, "dist/app/cli.mjs"), ...args], { cwd: ROOT, encoding: "utf8", env });
}

test("isolated public workflow refuses ordinary reset, recovers four deliveries, and preserves stable identities", { timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-public-context-workflow-"));
  const calls = path.join(root, "calls.log");
  const agentId = "cli_newA1";
  fs.writeFileSync(calls, "", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ version: 3, serverId: "server-workflow",
    activeAgent: agentId, agents: { [agentId]: { runtime: "pi", model: "fixture-model" } } }), { mode: 0o600 });
  const harness = spawn(process.execPath, [path.join(ROOT, "test/support/local-control-harness.mjs"), "app/runtime-process.mjs"], {
    cwd: ROOT, env: { ...process.env, LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_CONTROL_CALLS: calls,
      LARKIN_RECOVERY_WORKFLOW: "1", LARKIN_CONTROL_DELAY_MS: "0", TMPDIR: fs.mkdtempSync(path.join(os.tmpdir(), "larkin-workflow-tmp-")) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  harness.stdout.on("data", (chunk) => { output += chunk; });
  harness.stderr.on("data", (chunk) => { output += chunk; });
  try {
    await waitForReady(harness, () => output);
    const reset = runPublicCli(root, ["session", "reset", "--agent", agentId, "--json", "--wait-ready", "0"]);
    assert.equal(reset.status, 1, reset.stderr || reset.stdout);
    const resetJson = JSON.parse(reset.stdout);
    assert.equal(resetJson.reset_committed, false);
    assert.equal(resetJson.code, "inbox_backlog");
    assert.equal(resetJson.pending_count, 4);
    assert.doesNotMatch(reset.stdout, /workflow-delivery|workflow-input|om_workflow|\/private|\/tmp|secret|credential/);

    const recovery = runPublicCli(root, ["session", "recover", "--agent", agentId, "--reason", "context-overflow", "--json", "--wait-ready", "0"]);
    assert.equal(recovery.status, 0, recovery.stderr || recovery.stdout);
    const recoveryJson = JSON.parse(recovery.stdout);
    assert.equal(recoveryJson.recovery_committed, true);
    assert.equal(recoveryJson.rearmed_count, 4);
    assert.equal(recoveryJson.remaining_pending_count, 4, "the operator result remains conservative before replay settles");
    assert.doesNotMatch(recovery.stdout, /workflow-delivery|workflow-input|om_workflow|\/private|\/tmp|secret|credential|synthetic/);

    const replayDeadline = Date.now() + 3_000;
    let replayLines = [];
    while (Date.now() < replayDeadline) {
      replayLines = fs.readFileSync(calls, "utf8").trim().split("\n").filter((line) => line.startsWith("replay:"));
      if (replayLines.length === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(replayLines.length, 4, fs.readFileSync(calls, "utf8"));
    assert.equal(new Set(replayLines).size, 4);
    assert.deepEqual(replayLines.map((line) => line.split(":")[1]).sort(), [
      "workflow-delivery-0", "workflow-delivery-1", "workflow-delivery-2", "workflow-delivery-3",
    ]);
    const store = createAgentStateStore(root, agentId);
    const consumedDeadline = Date.now() + 3_000;
    while (store.readNdjson("inbox").length !== 0 && Date.now() < consumedDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(store.readNdjson("inbox").length, 0);
    const ledger = store.readJson("runtimeDeliveries", { records: [] });
    assert.deepEqual(ledger.records.filter((record) => record.messageId.startsWith("om_workflow_context_")).map((record) => record.status), ["consumed", "consumed", "consumed", "consumed"]);
    assert.deepEqual(ledger.records.filter((record) => record.messageId.startsWith("om_workflow_context_")).map((record) => [record.deliveryId, record.input.inputId]).sort(), [
      ["workflow-delivery-0", "workflow-input-0"], ["workflow-delivery-1", "workflow-input-1"],
      ["workflow-delivery-2", "workflow-input-2"], ["workflow-delivery-3", "workflow-input-3"],
    ]);
    const inboxState = store.readJson("inboxState", { targets: {} });
    assert.equal(inboxState.targets["chat:oc_workflow_context"].model_seen_seq, 4);

    const repeated = runPublicCli(root, ["session", "recover", "--agent", agentId, "--reason", "context-overflow", "--json", "--wait-ready", "0"]);
    assert.equal(repeated.status, 1, repeated.stderr || repeated.stdout);
    const repeatedJson = JSON.parse(repeated.stdout);
    assert.equal(repeatedJson.recovery_committed, false);
    assert.equal(repeatedJson.code, "recovery_refused");
    assert.doesNotMatch(repeated.stdout, /workflow-delivery|workflow-input|om_workflow|\/private|\/tmp|secret|credential|synthetic/);
  } finally {
    if (harness.exitCode === null) { harness.kill("SIGTERM"); await once(harness, "exit"); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
