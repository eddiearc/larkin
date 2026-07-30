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
      { message_id: "om_a1", chat_id: "oc_a", content: "secret-a1", create_time: "100" },
      { message_id: "om_a2", chat_id: "oc_a", content: "secret-a2", create_time: "101" },
      { message_id: "om_a3", chat_id: "oc_a", content: "secret-a3", create_time: "102" },
      { message_id: "om_b", chat_id: "oc_b", content: "secret-b", create_time: "200" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    const run = (argv) => spawnSync(process.execPath, [AGENT_CLI, ...argv], {
      cwd: root, env: { ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId }, encoding: "utf8",
    });
    const check = run(["inbox", "check"]);
    assert.equal(check.status, 0);
    assert.equal(check.stdout.includes("secret-"), false);
    const firstPoll = run(["inbox", "poll", "--target", "chat:oc_a", "--limit", "1"]);
    assert.equal(firstPoll.status, 0, firstPoll.stderr);
    const first = JSON.parse(firstPoll.stdout);
    assert.equal(first.delivery, "direct_ack");
    assert.deepEqual(first.events.map((event) => event.message_id), ["om_a1"]);
    assert.equal(first.pending_count, 2);
    assert.equal(first.has_more, true);
    assert.match(first.next_action, /Continue polling the same Inbox scope until has_more is false/);

    const second = JSON.parse(run(["inbox", "poll", "--target", "chat:oc_a", "--limit", "1"]).stdout);
    assert.deepEqual(second.events.map((event) => event.message_id), ["om_a2"]);
    assert.equal(second.pending_count, 1);
    assert.equal(second.has_more, true);

    const third = JSON.parse(run(["inbox", "poll", "--target", "chat:oc_a", "--limit", "1"]).stdout);
    assert.deepEqual(third.events.map((event) => event.message_id), ["om_a3"]);
    assert.equal(third.pending_count, 0);
    assert.equal(third.has_more, false);

    const empty = JSON.parse(run(["inbox", "poll", "--target", "chat:oc_a", "--limit", "1"]).stdout);
    assert.deepEqual(empty.events, [], "a retried poll must not replay direct-acked bodies");
    assert.equal(empty.pending_count, 0);
    assert.equal(empty.has_more, false);
    assert.equal(fs.readFileSync(inbox, "utf8").includes("om_b"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
