import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const AGENT_CLI = path.join(ROOT, "dist/app/agent-cli.mjs");

beforeAll(() => {
  const result = spawnSync(process.execPath, ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr);
});

test("Inbox check remains content-light while poll is bounded, target-local, and direct-ack", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-interface-"));
  const agentId = "cli_inboxInterfaceA1";
  const stateDir = path.join(root, "state", "agents", agentId);
  const inbox = path.join(stateDir, "feishu-inbox.ndjson");
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
      version: 4, serverId: "inbox-interface", mentionPolicy: "require", activeAgent: agentId,
      agents: { [agentId]: { runtime: "pi", model: "default" } },
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(inbox, [
      { message_id: "om_a", chat_id: "oc_a", content: "secret-a", create_time: "100" },
      { message_id: "om_b", chat_id: "oc_b", content: "secret-b", create_time: "200" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    const run = (argv) => spawnSync(process.execPath, [AGENT_CLI, ...argv], {
      cwd: root, env: { ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId }, encoding: "utf8",
    });
    const check = run(["inbox", "check"]);
    assert.equal(check.status, 0);
    assert.equal(check.stdout.includes("secret-"), false);
    const poll = run(["inbox", "poll", "--target", "chat:oc_a", "--limit", "1"]);
    assert.equal(poll.status, 0, poll.stderr);
    const value = JSON.parse(poll.stdout);
    assert.equal(value.delivery, "direct_ack");
    assert.deepEqual(value.events.map((event) => event.message_id), ["om_a"]);
    assert.equal(fs.readFileSync(inbox, "utf8").includes("om_b"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
