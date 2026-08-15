import assert from "node:assert/strict";
import { test } from "bun:test";
import { ContextPromptBuilder } from "../../../dist/agent/context-prompt.mjs";
import { targetKeyOfInboxEnvelope } from "../../../dist/agent/inbox-projection.mjs";
import { HostEnvelopeProjector } from "../../../dist/feishu/host-business-state.mjs";
import { createRuntimeHost } from "../../../dist/runtime/runtime-host.mjs";

class FakeSession {
  sessionId = "runtime-inbox-target-session";
  listeners = new Set();
  prompts = [];
  steers = [];

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async prompt(input) { this.prompts.push(input); return { status: "accepted", inputId: input.inputId }; }
  async busyInput(input) { this.steers.push(input); return { status: "accepted", inputId: input.inputId }; }
  async cancel() {}
  async close() {}
}

test("canonical Inbox target keys cover preserved, dm, chat, thread, and unlocatable envelopes", () => {
  assert.equal(targetKeyOfInboxEnvelope({ target: "chat:oc_preserved" }), "chat:oc_preserved");
  assert.equal(targetKeyOfInboxEnvelope({ channel_type: "dm", channel_name: "system" }), "dm:@system");
  assert.equal(targetKeyOfInboxEnvelope({ chat_id: "oc_chat" }), "chat:oc_chat");
  assert.equal(targetKeyOfInboxEnvelope({ chat_id: "oc_chat", thread_id: "omt_thread" }), "thread:oc_chat:omt_thread");
  assert.equal(targetKeyOfInboxEnvelope({ message_id: "unlocatable" }), "runtime:system");
});

test("production HostEnvelopeProjector assigns the canonical dm target to reminder and redelivery outputs", () => {
  const projector = new HostEnvelopeProjector(
    {},
    () => {},
    () => "abcdef123456",
    () => new Date("2026-07-16T02:00:00.000Z"),
  );
  const reminder = projector.createReminderEnvelope("cli_targetContractA1", {
    reminderId: "1234567890abcdef", title: "Target contract", fireAt: "2026-07-17T01:00:00.000Z",
  }, 0, null);
  const redelivery = projector.createRedeliveryEnvelope("cli_targetContractA1", 2);

  assert.equal(reminder.target, "dm:@system");
  assert.equal(targetKeyOfInboxEnvelope(reminder), "dm:@system");
  assert.equal(redelivery.target, "dm:@system");
  assert.equal(targetKeyOfInboxEnvelope(redelivery), "dm:@system");
});

test("targetless Runtime delivery derives dm, chat, thread, and unlocatable targets in final Runtime input", async () => {
  const session = new FakeSession();
  const host = createRuntimeHost({
    adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(),
  });
  const agentId = "cli_targetDefenseA1";
  const cases = [
    [{ message_id: "rem_dm", channel_type: "dm", channel_name: "system" }, "dm:@system"],
    [{ message_id: "om_chat", chat_id: "oc_chat" }, "chat:oc_chat"],
    [{ message_id: "om_thread", chat_id: "oc_chat", thread_id: "omt_thread" }, "thread:oc_chat:omt_thread"],
    [{ message_id: "runtime_unlocatable" }, "runtime:system"],
  ];
  try {
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: "." }]);
    for (const [envelope] of cases) assert.equal((await host.deliver(agentId, envelope)).status, "accepted");

    const finalInputs = [...session.prompts, ...session.steers];
    assert.equal(finalInputs.length, cases.length);
    cases.forEach(([, target], index) => {
      assert.ok(finalInputs[index].text.includes(`Inbox changed for ${target}`), `final Runtime input names ${target}`);
      assert.doesNotMatch(finalInputs[index].text, /Inbox changed \(/, "final Runtime notice is never targetless");
    });
  } finally {
    await host.shutdown("target derivation contract complete");
  }
});
