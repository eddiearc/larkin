import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectProcess } from "../../../dist/platform/process-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HARNESS = path.join(ROOT, "test", "live", "three-agent-live-acceptance.test.mjs");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

test("three-Agent live acceptance is opt-in, hermetic by default, and fixture-verifiable", async () => {
  const childEnv = { ...process.env };
  for (const key of ["LARKIN_RUN_FEISHU_LIVE_TEST", "LARKIN_CONFIG_DIR", "LARKIN_LIVE_ACCEPTANCE_EVIDENCE"]) delete childEnv[key];
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["test:live:three-agent"], "bun test --max-concurrency 1 test/live/three-agent-live-acceptance.test.mjs");
  assert.equal(fs.existsSync(HARNESS), true, "live acceptance harness must exist");

  const skipped = spawnSync(process.execPath, ["test", "--max-concurrency", "1", HARNESS], { cwd: ROOT, encoding: "utf8", env: childEnv });
  assert.equal(skipped.status, 0, skipped.stderr || skipped.stdout);
  assert.match(skipped.stdout + skipped.stderr, /LARKIN_RUN_FEISHU_LIVE_TEST=1/);
  assert.match(skipped.stdout + skipped.stderr, /2 skip/i);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-live-acceptance-contract-"));
  const daemonScript = path.join(temp, "larkin.cjs");
  fs.writeFileSync(daemonScript, "setInterval(() => {}, 1000);\n");
  const daemon = spawn(process.execPath, [daemonScript], { stdio: "ignore" });
  onTestFinished(() => {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const inspected = inspectProcess(daemon.pid);
  assert.equal(inspected.ok, true, inspected.reason);

  const ids = ["cli_fixtureA", "cli_fixtureB", "cli_fixtureC"];
  const chatId = "oc_fixture";
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const endedAt = new Date().toISOString();
  const config = {
    version: 3,
    serverId: "server-fixture",
    activeAgent: ids[0],
    agents: Object.fromEntries(ids.map((id) => [id, { runtime: "codex", model: "fixture", noMentionChats: [chatId] }])),
  };
  writeJson(path.join(temp, "config.json"), config);
  writeJson(path.join(temp, "daemon-status.json"), {
    pid: daemon.pid,
    processStartToken: inspected.startToken,
    commandToken: "larkin.cjs",
    startedAt,
    agents: ids,
  });
  for (const id of ids) {
    const workspace = path.join(temp, "agents", id);
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "owner-maintained native instructions\n");
    writeJson(path.join(temp, "state", "agents", id, "status.json"), { connectedVia: "channel", connectedAt: endedAt, inboundVerifiedAt: endedAt, recentErrors: [] });
  }
  const evidence = path.join(temp, "evidence.json");
  const pass = (observed, evidenceSource = ["status-json"]) => ({ status: "pass", observed, evidenceSource });
  const skippedCase = (reasonCode) => ({ status: "skipped", reasonCode });
  const currentCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(currentCommit.status, 0, currentCommit.stderr);
  writeJson(evidence, {
    schemaVersion: 1,
    evidenceKind: "manual-observation",
    environment: "local-feishu-live",
    runId: "fixture-run-0001",
    marker: "[LARKIN-LIVE-TEST:fixture-run-0001]",
    startedAt,
    endedAt,
    commit: currentCommit.stdout.trim(),
    chatAlias: "fixture-chat",
    chatHash: crypto.createHash("sha256").update(chatId).digest("hex").slice(0, 16),
    roster: { humanUsers: 1, botAgents: 3, targetAgents: 3, source: "lark-cli-chat-members" },
    cases: {
      "setup-reuses-agent": skippedCase("requires-user-ui"),
      "start-is-idempotent": pass({ daemonReused: true, hostProcessCount: 1 }, ["public-cli", "status-json"]),
      "workspace-and-prompt-ready": pass({ readyAgents: 3, duplicateManagedBlocks: 0 }),
      "free-human-no-at": pass({ observingAgents: 3, wokenAgents: 3, replyingAgents: 1 }, ["status-json", "feishu-history"]),
      "strict-human-no-at": pass({ observingAgents: 3, wokenAgents: 0, replyingAgents: 0 }, ["transient-inbox", "feishu-history"]),
      "strict-human-target-at": pass({ observingAgents: 3, wokenAgents: 1, replyingAgents: 0, nonTargetReplyingAgents: 0, targetOnly: true, realAt: true }, ["status-json", "feishu-history"]),
      "restore-free-mode": pass({ freeAgents: 3, connectedAgents: 3, newErrorAgents: 0 }, ["public-cli", "status-json"]),
      "strict-bot-no-at": skippedCase("supplemental-not-run"),
      "strict-bot-target-at": skippedCase("supplemental-not-run"),
      "strict-at-all": skippedCase("supplemental-not-run"),
      "no-cooldown-two-directed": skippedCase("supplemental-not-run"),
    },
  });
  const enabled = spawnSync(process.execPath, ["test", "--max-concurrency", "1", HARNESS], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...childEnv,
      LARKIN_RUN_FEISHU_LIVE_TEST: "1",
      LARKIN_CONFIG_DIR: temp,
      LARKIN_LIVE_ACCEPTANCE_EVIDENCE: evidence,
    },
  });
  assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);
  assert.match(enabled.stdout + enabled.stderr, /prepared three-Agent shell baseline is currently healthy/i);
  assert.match(enabled.stdout + enabled.stderr, /manual Feishu evidence has a safe shape and the required core effects/i);

  const unsafeEvidence = JSON.parse(fs.readFileSync(evidence, "utf8"));
  unsafeEvidence.cases["strict-bot-no-at"] = pass({ observingAgents: 3, wokenAgents: 0, replyingAgents: 0 }, ["manual-ui"]);
  writeJson(evidence, unsafeEvidence);
  const rejected = spawnSync(process.execPath, ["test", "--max-concurrency", "1", HARNESS], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...childEnv, LARKIN_RUN_FEISHU_LIVE_TEST: "1", LARKIN_CONFIG_DIR: temp, LARKIN_LIVE_ACCEPTANCE_EVIDENCE: evidence },
  });
  assert.notEqual(rejected.status, 0, "supplemental pass evidence must not rely on manual UI alone");
  assert.match(rejected.stderr + rejected.stdout, /strict-bot-no-at requires evidence source: transient-inbox/i);
});
