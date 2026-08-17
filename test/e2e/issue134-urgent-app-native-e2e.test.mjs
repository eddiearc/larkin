import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createAgentStateStore } from "../../dist/agent/agent-state-store.mjs";
import { runLarkCli } from "../../dist/app/lark-cli.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue134-urgent-e2e-"));
  const agentId = "cli_issue134UrgentA1";
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-issue134-urgent", mentionPolicy: "require", activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "default" } },
  })}\n`, { mode: 0o600 });
  const store = createAgentStateStore(root, agentId);
  const output = { stdout: "", stderr: "" };
  const calls = [];
  const own = {
    message_id: "om_issue134_own",
    chat_id: "oc_issue134",
    create_time: "1786979000001",
    sender: { id: agentId, id_type: "app_id", sender_type: "app" },
  };
  const spawn = (_command, args) => {
    calls.push(args.slice());
    if (args[2] === "+messages-mget" || (args[1] === "api" && args[2] === "GET")) {
      return {
        status: 0, signal: null, output: [], pid: 1,
        stdout: JSON.stringify({ ok: true, identity: "bot", data: { messages: [own] } }),
        stderr: "", error: undefined,
      };
    }
    if (args[2] === "+chat-members-list") {
      return {
        status: 0, signal: null, output: [], pid: 1,
        stdout: JSON.stringify({
          ok: true, identity: "bot",
          data: { users: [{ member_id: "ou_issue134_human" }], has_more: false, truncations: [] },
        }),
        stderr: "", error: undefined,
      };
    }
    return {
      status: 0, signal: null, output: [], pid: 1,
      stdout: `${JSON.stringify({ ok: true, identity: "bot", data: { invalid_user_id_list: [] } })}\n`,
      stderr: "", error: undefined,
    };
  };
  const run = (argv) => {
    output.stdout = "";
    output.stderr = "";
    const code = runLarkCli(argv, { LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId }, {
      io: { stdout(text) { output.stdout += text; }, stderr(text) { output.stderr += text; } },
      spawn,
      nativeCommand: { command: process.execPath, argsPrefix: ["/fixed/@larksuite/cli/scripts/run.js"], version: "1.0.80" },
      stateStore: store,
    });
    return { code, ...output };
  };
  return { root, store, calls, run };
}

test("issue 134 e2e: official urgent_app is guarded and spawned with native argv", () => {
  const f = fixture();
  try {
    assert.equal(runLarkCli(["im", "+messages-urgent-app", "--message-id", "om_issue134_own"], {
      LARKIN_CONFIG_DIR: f.root, LARKIN_AGENT_ID: "cli_issue134UrgentA1",
    }, {
      io: { stdout() {}, stderr() {} },
      spawn() { throw new Error("invented shortcut must not spawn"); },
      nativeCommand: { command: process.execPath, argsPrefix: ["/fixed/@larksuite/cli/scripts/run.js"], version: "1.0.80" },
      stateStore: f.store,
    }), 2);

    f.store.mergeFreshnessCursor("feishu.im/chat/oc_issue134", {
      schema: 1, revisionTime: "1786979000001", messageIds: ["om_issue134_own"],
    }, (_seen, current) => current ?? _seen);

    const argv = [
      "im", "messages", "urgent_app",
      "--message-id", "om_issue134_own",
      "--user-id-type", "open_id",
      "--data", JSON.stringify({ user_id_list: ["ou_issue134_human"] }),
    ];
    const sent = f.run(argv);
    assert.equal(sent.code, 0, sent.stderr);
    assert.match(sent.stdout, /invalid_user_id_list/);

    const kinds = f.calls.map((args) => args[2] === "messages" ? `${args[2]} ${args[3]}` : args[2]);
    assert.deepEqual(kinds, ["+messages-mget", "GET", "+chat-members-list", "messages urgent_app"]);
    const write = f.calls.at(-1);
    assert.deepEqual(write.slice(1, 4), ["im", "messages", "urgent_app"]);
    assert.equal(write[write.indexOf("--message-id") + 1], "om_issue134_own");
    assert.equal(write[write.indexOf("--user-id-type") + 1], "open_id");
    assert.equal(write.includes("--idempotency-key"), false);
    assert.equal(write.includes("+messages-urgent-app"), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("issue 134 e2e: official --data dash on a native read is not rejected by the policy parser", () => {
  const f = fixture();
  try {
    const result = f.run(["im", "+chat-list", "--data", "-", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(f.calls.some((args) => args[2] === "+chat-list"), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
