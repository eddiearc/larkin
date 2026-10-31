import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "bun:test";
import { createNativeRuntimeAdapter } from "../../dist/runtime/runtime-adapters.mjs";
import { createRuntimeHost } from "../../dist/runtime/runtime-host.mjs";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";

for (const resume of [false, true]) {
  test(`native Codex ${resume ? "resumed" : "fresh"} delivery survives child noise and stale configuration failures`, async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    const writes = [];
    let serverTurnId = "root-turn";
    const notify = (method, params) => child.stdout.write(`${JSON.stringify({ method, params })}\n`);
    child.stdin = { write(line, cb) {
      const req = JSON.parse(line); writes.push(req); cb?.();
      if (req.id) queueMicrotask(() => {
        const result = ["thread/start", "thread/resume"].includes(req.method) ? { thread: { id: "root-thread" } }
          : req.method === "turn/start" ? { turn: { id: "root-turn" } } : {};
        const wrongSteer = req.method === "turn/steer"
          && (req.params.threadId !== "root-thread" || req.params.expectedTurnId !== serverTurnId);
        child.stdout.write(`${JSON.stringify({ id: req.id, ...(wrongSteer
          ? { error: { message: "expected active turn id child-turn but found root-turn" } } : { result }) })}\n`);
        if (req.method === "turn/start") notify("turn/started", { threadId: "root-thread", turn: { id: "root-turn" } });
      });
      return true;
    } };
    const native = createNativeRuntimeAdapter("codex", { spawn: () => child });
    const adapter = { ...native, async probe() { return { runtime: "codex", state: "ready" }; } };
    const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), assertOfficialCliReady: () => {} });
    const events = []; host.subscribe(event => events.push(event));
    const agentId = "cli_subagentDelivery";
    const deliver = (id) => host.deliver(agentId, { message_id: id, chat_id: "oc_subagent", content: "review task" });
    try {
      await host.start([{ agentId, name: "reviewer", runtime: "codex", model: "model", workspaceDir: "/tmp", ...(resume ? { sessionId: "root-thread" } : {}) }]);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(writes.filter(req => req.method === (resume ? "thread/resume" : "thread/start")).length, 1);
      assert.equal((await deliver("om_root")).status, "accepted");
      notify("thread/started", { thread: { id: "child-thread" } });
      notify("turn/started", { threadId: "child-thread", turn: { id: "child-turn" } });
      notify("item/started", { threadId: "child-thread", item: { type: "agentMessage", id: "child-message" } });
      notify("item/agentMessage/delta", { threadId: "child-thread", delta: "child output" });
      notify("item/started", { threadId: "child-thread", item: { type: "commandExecution", id: "child-tool" } });
      notify("item/completed", { threadId: "child-thread", item: { type: "commandExecution", id: "child-tool", exitCode: 1 } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await deliver("om_during_child")).status, "accepted");
      assert.equal(events.filter(event => event.type === "runtime" &&
        ["text-delta", "tool-result", "activity"].includes(event.event.type)).length, 0);
      notify("item/agentMessage/delta", { threadId: "root-thread", delta: "root output" });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(events.filter(event => event.type === "runtime" && event.event.type === "text-delta")
        .map(event => event.event), [{ type: "text-delta", text: "root output" }]);
      notify("error", { threadId: "child-thread", turnId: "child-turn", error: { message: "child failed" }, willRetry: false });
      notify("turn/completed", { threadId: "child-thread", turn: { id: "child-turn", status: "failed" } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(host.isBusy(agentId), true);
      assert.equal((await deliver("om_after_child")).status, "accepted");
      assert.equal(writes.filter(req => req.method === "turn/start").length, 1);
      assert.equal(writes.filter(req => req.method === "turn/steer").length, 2);
      assert.equal(events.filter(event => event.type === "delivery" && ["error", "deferred"].includes(event.status)).length, 0);
      assert.equal(events.filter(event => event.type === "activity" && event.detailKind === "turn_ended").length, 0);
      serverTurnId = "new-root-turn";
      notify("turn/started", { threadId: "root-thread", turn: { id: serverTurnId } });
      const error = { message: "model requires a newer version of Codex" };
      notify("turn/completed", { threadId: "root-thread", turn: { id: "root-turn", status: "failed", error } });
      notify("error", { threadId: "root-thread", turnId: "root-turn", error, willRetry: false });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(host.isBusy(agentId), true);
      assert.equal((await deliver("om_after_stale_config")).status, "accepted");
      assert.equal(writes.filter(req => req.method === "turn/start").length, 1);
      assert.equal(writes.filter(req => req.method === "turn/steer").length, 3);
      assert.equal(events.filter(event => event.type === "activity" && event.detailKind === "turn_ended").length, 0);
      notify("turn/completed", { threadId: "root-thread", turn: { id: serverTurnId, status: "completed" } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(host.isBusy(agentId), false);
      assert.equal(events.filter(event => event.type === "activity" && event.detailKind === "turn_ended").length, 1);
    } finally {
      await host.shutdown("done"); child.stdout.destroy(); child.stderr.destroy();
    }
  });
}
