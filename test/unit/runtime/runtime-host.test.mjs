import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { ContextPromptBuilder } from "../../../dist/agent/context-prompt.mjs";
import { createRuntimeHost } from "../../../dist/runtime/runtime-host.mjs";
import { RuntimePrerequisiteError } from "../../../dist/runtime/runtime-readiness.mjs";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { ProcessingEyeOrchestrator } from "../../../dist/feishu/host-processing-eye.mjs";

class FakeSession {
  sessionId = "session-1";
  listeners = new Set();
  prompts = [];
  steers = [];
  cancels = [];
  closes = [];
  nextBusy = null;
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event) { for (const fn of this.listeners) fn(event); }
  async prompt(input) { this.prompts.push(input); return { status: "accepted", inputId: input.inputId }; }
  async busyInput(input) {
    this.steers.push(input);
    return this.nextBusy ?? { status: "accepted", inputId: input.inputId };
  }
  async cancel(reason) { this.cancels.push(reason); }
  async close(reason) { this.closes.push(reason); }
}

test("RuntimeHost stages a candidate session without stopping the old healthy Agent", async () => {
  const oldSession = new FakeSession();
  oldSession.sessionId = "old-session";
  const nextSession = new FakeSession();
  nextSession.sessionId = "next-session";
  const adapter = { id: "pi", capabilities: {}, async createSession(input) {
    if (input.model === "broken") throw new Error("candidate handshake failed");
    return input.model === "next" ? nextSession : oldSession;
  } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
  const base = { agentId: "cli_stageA1", name: "stage", runtime: "pi", workspaceDir: "/tmp" };
  await host.start([{ ...base, model: "old" }]);
  await assert.rejects(host.stage({ ...base, model: "broken" }), /candidate handshake failed/);
  assert.deepEqual(oldSession.closes, []);
  assert.equal((await host.deliver(base.agentId, { message_id: "om_old_still_usable" })).status, "accepted");
  oldSession.emit({ type: "turn-end" });
  const staged = await host.stage({ ...base, model: "next" });
  assert.deepEqual(oldSession.closes, []);
  await staged.commit();
  assert.deepEqual(oldSession.closes, ["runtime candidate committed"]);
  assert.equal((await host.deliver(base.agentId, { message_id: "om_next_usable" })).status, "accepted");
  assert.equal(nextSession.prompts.length, 1);
  await host.shutdown("done");
});

test("RuntimeHost isolates a missing runtime and keeps healthy agents active", async () => {
  const healthy = new FakeSession();
  const events = [];
  const host = createRuntimeHost({
    adapterFor(runtime) {
      return runtime === "pi"
        ? { id: "pi", capabilities: {}, async createSession() { throw new RuntimePrerequisiteError({ runtime: "pi", state: "missing", reason: "pi not found", nextAction: "install pi" }); } }
        : { id: "codex", capabilities: {}, async createSession() { return healthy; } };
    },
    promptBuilder: new ContextPromptBuilder(),
  });
  host.subscribe((event) => events.push(event));
  await host.start([
    { agentId: "cli_badPiA1", name: "bad", runtime: "pi", model: "default", workspaceDir: "/tmp" },
    { agentId: "cli_goodCodexA1", name: "good", runtime: "codex", model: "default", workspaceDir: "/tmp" },
  ]);
  assert.ok(events.some((event) => event.type === "agent-status" && event.agentId === "cli_badPiA1" && event.readiness?.state === "missing"));
  assert.ok(events.some((event) => event.type === "agent-status" && event.agentId === "cli_goodCodexA1" && event.status === "active"));
  await host.shutdown("done");
});

for (const [runtime, intermediates] of [
  ["codex", ["thinking", "text"]],
  ["claude", ["thinking", "text", "tool"]],
  ["pi", ["thinking", "text", "tool"]],
]) {
  test(`RuntimeHost projects ${runtime} normalized boundaries through the shared processing-eye contract`, async () => {
    const session = new FakeSession();
    const adapter = { id: runtime, capabilities: {}, async createSession() { return session; } };
    const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
    const timers = [], calls = [];
    const eye = new ProcessingEyeOrchestrator({
      cliForAgent: () => ({ command: "/test/official-lark-cli", argsPrefix: [], env: {} }),
      execFile(_command, args, _options, callback) {
        calls.push(args);
        callback(null, JSON.stringify(args.includes("POST") ? { data: { reaction_id: `react-${runtime}` } } : { ok: true }), "");
        return {};
      },
      writePending() {},
      setTimer(callback, delay) {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimer(timer) { timer.cancelled = true; },
    });
    host.subscribe((event) => {
      if (event.type === "activity") eye.observeActivity({ agentId: "cli_eyeContractA1", name: "eye", feishuProfile: "eye" }, event.activity);
    });
    await host.start([{ agentId: "cli_eyeContractA1", name: "cli_eyeContractA1", runtime, model: "model", workspaceDir: "/tmp" }]);
    eye.add({ agentId: "cli_eyeContractA1", name: "eye", feishuProfile: "eye" }, `om_${runtime}_contract`);
    session.emit({ type: "turn-start" });
    for (const activity of intermediates) session.emit({ type: "activity", activity });
    session.emit({ type: "turn-end" });
    assert.equal(calls.filter((args) => args.includes("DELETE")).length, 0);
    const completion = timers.find((timer) => timer.delay === 1_000 && !timer.cancelled);
    assert.ok(completion);
    completion.callback();
    assert.equal(calls.filter((args) => args.includes("DELETE")).length, 1);
    await host.shutdown("processing-eye contract test complete");
  });
}

test("Runtime Host owns duplicate suppression, busy delivery and turn-boundary retry without cancel", async () => {
  const session = new FakeSession();
  const adapter = { id: "codex", capabilities: { standingPrompt: "append", sessionResume: true, busyInput: "direct", cancel: true }, async createSession(input) {
    assert.match(input.standingPrompt.content, /inbox check/);
    assert.match(input.standingPrompt.content, /larkin inbox poll/);
    assert.match(input.standingPrompt.content, /larkin im \+messages-send/);
    assert.doesNotMatch(input.standingPrompt.content, /(?:^|\s)lark-cli im /m);
    assert.equal(input.resumeSessionId, "old-session");
    return session;
  } };
  const events = [];
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
  host.subscribe((event) => events.push(event));
  await host.start([{ agentId: "cli_hostA1", name: "cli_hostA1", runtime: "codex", model: "gpt", workspaceDir: "/tmp", sessionId: "old-session" }]);

  const first = await host.deliver("cli_hostA1", { message_id: "om_1", seq: 1 });
  assert.equal(first.status, "accepted");
  assert.equal(session.prompts.length, 1);
  assert.match(session.prompts[0].text, /Inbox changed/);
  assert.match(session.prompts[0].text, /Poll that target/);
  assert.doesNotMatch(session.prompts[0].text, /larkin message check/);
  assert.deepEqual(await host.deliver("cli_hostA1", { message_id: "om_1", seq: 1 }), { status: "duplicate", deliveryId: first.deliveryId });

  session.emit({ type: "turn-start", turnId: "turn-1" });
  session.nextBusy = { status: "deferred", inputId: "ignored", reason: "turn raced" };
  const deferred = await host.deliver("cli_hostA1", { message_id: "om_2", seq: 2 });
  assert.equal(deferred.status, "deferred");
  assert.equal(session.steers.length, 1);
  assert.deepEqual(session.cancels, []);
  session.nextBusy = null;
  session.emit({ type: "turn-end", turnId: "turn-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 2, "deferred input is retried after the safe turn boundary");
  assert.ok(events.some((event) => event.type === "session" && event.sessionId === "session-1"));
  assert.ok(events.some((event) => event.type === "delivery" && event.deliveryId === first.deliveryId
    && event.status === "deferred" && /before Inbox consumption/.test(event.reason)),
  "an accepted-but-undrained delivery is visible when the runtime turn ends");
  await host.shutdown("test complete");
});

test("Codex compatibility recovery closes, updates once, recreates, and retries the owned delivery", async () => {
  const sessions = [];
  let recoveries = 0;
  const adapter = {
    id: "codex", capabilities: {},
    async createSession() {
      const session = new FakeSession();
      session.sessionId = `compat-${sessions.length + 1}`;
      sessions.push(session);
      return session;
    },
    async recoverConfigurationError(message) {
      recoveries += 1;
      assert.match(message, /requires a newer version of Codex/);
      return recoveries === 1
        ? { recovered: true, reason: "Codex update succeeded: upgraded" }
        : { recovered: false, reason: "Codex update was already attempted during this runtime startup" };
    },
  };
  const events = [];
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    retryPolicy: { baseDelayMs: 3, maxDelayMs: 3, maxAttempts: 2 } });
  host.subscribe((event) => events.push(event));
  await host.start([{ agentId: "cli_compatA1", name: "cli_compatA1", runtime: "codex", model: "new-model", workspaceDir: "/tmp" }]);
  const receipt = await host.deliver("cli_compatA1", { message_id: "om_compat" });
  sessions[0].emit({ type: "configuration-error", message: "selected model requires a newer version of Codex" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recoveries, 1);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].prompts.length, 1);
  assert.equal(sessions[1].prompts[0].inputId, receipt.deliveryId, "recovery retains and retries the original delivery ownership");
  assert.ok(events.some((event) => event.type === "delivery" && event.deliveryId === receipt.deliveryId && event.status === "deferred"));
  sessions[1].emit({ type: "configuration-error", message: "selected model requires a newer version of Codex" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recoveries, 2);
  assert.equal(sessions.length, 2, "a completed update attempt cannot create an infinite recovery loop");
  const later = await host.deliver("cli_compatA1", { message_id: "om_after_attempt" });
  assert.equal(later.status, "deferred");
  assert.match(later.reason, /already attempted/);
  await host.shutdown("test complete");
});

test("Runtime Host reserves a turn before prompt yields so the second delivery steers", async () => {
  let release;
  const session = new FakeSession();
  session.prompt = async (input) => { session.prompts.push(input); await new Promise((resolve) => { release = resolve; }); return { status: "accepted", inputId: input.inputId }; };
  const adapter = { id: "codex", capabilities: {}, async createSession() { return session; } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
  await host.start([{ agentId: "cli_raceA1", name: "cli_raceA1", runtime: "codex", model: "gpt", workspaceDir: "/tmp" }]);
  const first = host.deliver("cli_raceA1", { message_id: "om_first" });
  const second = await host.deliver("cli_raceA1", { message_id: "om_second" });
  assert.equal(session.prompts.length, 1);
  assert.equal(session.steers.length, 1);
  assert.equal(second.status, "accepted");
  release();
  assert.equal((await first).status, "accepted");
  await host.shutdown("test complete");
});

test("delivery ownership, dedupe and correlation survive recreation and reach consumed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-persist-"));
  const agentId = "cli_persistA1";
  const store = createAgentStateStore(root, agentId);
  const sessions = [];
  const adapter = { id: "codex", capabilities: {}, async createSession() { const session = new FakeSession(); session.sessionId = `session-${sessions.length + 1}`; sessions.push(session); return session; } };
  const config = { agentId, name: agentId, runtime: "codex", model: "gpt", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root };
  try {
    store.appendNdjson("inbox", { message_id: "om_persist", content: "canonical" });
    const host1 = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
    await host1.start([config]);
    const accepted = await host1.deliver(agentId, { message_id: "om_persist" });
    await host1.shutdown("simulated process exit");

    const events = [];
    const host2 = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
    host2.subscribe((event) => events.push(event));
    await host2.start([config]);
    assert.equal(sessions[1].prompts[0].inputId, accepted.deliveryId, "pending reconstruction preserves deliveryId");
    assert.deepEqual(await host2.deliver(agentId, { message_id: "om_persist" }), { status: "duplicate", deliveryId: accepted.deliveryId });
    store.drainInbox();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(events.some((event) => event.type === "delivery" && event.status === "consumed" && event.deliveryId === accepted.deliveryId));
    const persisted = store.readJson("runtimeDeliveries", { records: [] });
    assert.equal(persisted.records.find((record) => record.deliveryId === accepted.deliveryId).status, "consumed");
    await host2.shutdown("test complete");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("startup migration consumes orphan synthetic active deliveries but never guesses for real om_ messages", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-synthetic-migration-"));
  const agentId = "cli_migrateA1";
  const store = createAgentStateStore(root, agentId);
  const session = new FakeSession();
  const record = (deliveryId, messageId) => ({ deliveryId, messageId, status: "accepted",
    input: { inputId: deliveryId, deliveryId, kind: "wake", text: "check", attempt: 0 }, updatedAt: "2026-07-19T00:00:00.000Z" });
  store.writeJson("runtimeDeliveries", { version: 1, records: [
    record("delivery-redeliver", "redeliver_509c"), record("delivery-reminder", "rem_legacy"),
    record("delivery-interaction", "interaction_run_missing"), record("delivery-real", "om_real_missing"),
  ] });
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  try {
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root }]);
    assert.deepEqual(session.prompts.map((input) => input.inputId), ["delivery-real"], "only the real message retains delivery ownership");
    const statuses = Object.fromEntries(store.readJson("runtimeDeliveries", { records: [] }).records
      .map((item) => [item.messageId, item.status]));
    assert.equal(statuses.redeliver_509c, "consumed");
    assert.equal(statuses.rem_legacy, "consumed");
    assert.equal(statuses.interaction_run_missing, "consumed");
    assert.equal(statuses.om_real_missing, "accepted", "real Feishu delivery is never blindly consumed without Inbox evidence");
  } finally {
    await host.shutdown("test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a canonical drain that wins before the current deliver call atomically closes the newly-created generic ledger", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-post-delivery-reconcile-"));
  const agentId = "cli_postDrainA1";
  const store = createAgentStateStore(root, agentId);
  const session = new FakeSession();
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  try {
    store.appendNdjson("inbox", { message_id: "om_drain_won", wake: true });
    store.drainInbox();
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root }]);
    const receipt = await host.deliver(agentId, { message_id: "om_drain_won", wake: true });
    assert.equal(receipt.status, "accepted");
    const record = store.readJson("runtimeDeliveries", { records: [] }).records
      .find((candidate) => candidate.deliveryId === receipt.deliveryId);
    assert.equal(record.status, "consumed");
    assert.equal(store.readNdjson("inbox").length, 0);
  } finally {
    await host.shutdown("test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("closed runtime is discarded and recreated; late stale events are ignored", async () => {
  const sessions = [];
  const adapter = { id: "claude", capabilities: {}, async createSession() { const session = new FakeSession(); session.sessionId = `s-${sessions.length + 1}`; sessions.push(session); return session; } };
  const events = [];
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    retryPolicy: { baseDelayMs: 5, maxDelayMs: 10, maxAttempts: 3 } });
  host.subscribe((event) => events.push(event));
  await host.start([{ agentId: "cli_crashA1", name: "cli_crashA1", runtime: "claude", model: "claude", workspaceDir: "/tmp" }]);
  await host.deliver("cli_crashA1", { message_id: "om_crash" });
  sessions[0].emit({ type: "closed", code: 1, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].prompts[0].inputId, sessions[0].prompts[0].inputId);
  const before = events.length;
  sessions[0].emit({ type: "turn-start" });
  assert.equal(events.length, before, "replaced session cannot mutate current state");
  await host.shutdown("test complete");
});

test("async retryable input-error returns an accepted Pi delivery to pending and retries it", async () => {
  const session = new FakeSession();
  const adapter = { id: "pi", capabilities: {}, async createSession() { return session; } };
  const events = [];
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
  host.subscribe((event) => events.push(event));
  await host.start([{ agentId: "cli_piRejectA1", name: "cli_piRejectA1", runtime: "pi", model: "pi", workspaceDir: "/tmp" }]);
  const receipt = await host.deliver("cli_piRejectA1", { message_id: "om_pi_reject" });
  assert.equal(receipt.status, "accepted");
  session.emit({ type: "input-error", inputId: receipt.deliveryId, retryable: true, message: "provider queue rejected" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 2);
  assert.equal(session.prompts[1].inputId, receipt.deliveryId, "retry preserves delivery/input correlation");
  assert.ok(events.some((event) => event.type === "delivery" && event.status === "deferred" && event.deliveryId === receipt.deliveryId));
  await host.shutdown("test complete");
});

test("non-retryable input-error produces a terminal delivery error without resubmission", async () => {
  const session = new FakeSession();
  const adapter = { id: "pi", capabilities: {}, async createSession() { return session; } };
  const events = [];
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
  host.subscribe((event) => events.push(event));
  await host.start([{ agentId: "cli_piTerminalA1", name: "cli_piTerminalA1", runtime: "pi", model: "pi", workspaceDir: "/tmp" }]);
  const receipt = await host.deliver("cli_piTerminalA1", { message_id: "om_pi_terminal" });
  session.emit({ type: "input-error", inputId: receipt.deliveryId, retryable: false, message: "invalid request" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 1);
  assert.ok(events.some((event) => event.type === "delivery" && event.status === "error" && event.reason === "invalid request"));
  await host.shutdown("test complete");
});

test("terminal provider auth failure downgrades only its Agent and a later successful turn restores readiness", async () => {
  const failedSession = new FakeSession();
  const stagedSession = new FakeSession();
  stagedSession.sessionId = "session-staged";
  const healthySession = new FakeSession();
  const events = [];
  const host = createRuntimeHost({
    adapterFor: () => ({
      id: "pi", capabilities: {},
      async createSession(input) {
        if (input.agentId !== "cli_authFailedA1") return healthySession;
        return input.model === "bigmodel-anthropic/glm-5.2-updated" ? stagedSession : failedSession;
      },
    }),
    promptBuilder: new ContextPromptBuilder(),
  });
  host.subscribe((event) => events.push(event));
  await host.start([
    { agentId: "cli_authFailedA1", name: "failed", runtime: "pi", model: "bigmodel-anthropic/glm-5.2", workspaceDir: "/tmp" },
    { agentId: "cli_authHealthyB2", name: "healthy", runtime: "pi", model: "fixture/healthy", workspaceDir: "/tmp" },
  ]);
  const failedReceipt = await host.deliver("cli_authFailedA1", { message_id: "om_auth_failed" });
  failedSession.emit({ type: "turn-start", turnId: "turn-auth-failed" });
  failedSession.emit({
    type: "input-error", inputId: failedReceipt.deliveryId, retryable: false, willRetry: false,
    message: "API key auth failed at /Users/example/.pi/agent/bin/cc-switch-token; api_key=fixture-secret",
    errorCategory: "auth", nextAction: "unsafe raw action", upstream: { provider: "bigmodel-anthropic", message: "unsafe" },
  });
  failedSession.emit({ type: "turn-end", turnId: "turn-auth-failed" });
  await new Promise((resolve) => setImmediate(resolve));

  const downgraded = events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").at(-1);
  assert.equal(downgraded.status, "error");
  assert.equal(downgraded.readiness.state, "unauthenticated");
  assert.match(downgraded.readiness.reason, /bigmodel-anthropic.*authentication failed/i);
  assert.match(downgraded.readiness.nextAction, /login|API-key resolver/i);
  assert.doesNotMatch(JSON.stringify(downgraded), /Users\/example|cc-switch-token|fixture-secret|unsafe raw action/);
  assert.equal(events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authHealthyB2").at(-1).status, "active");
  assert.equal((await host.deliver("cli_authHealthyB2", { message_id: "om_healthy" })).status, "accepted");

  const authStatusCount = events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").length;
  const staged = await host.stage({ agentId: "cli_authFailedA1", name: "failed", runtime: "pi",
    model: "bigmodel-anthropic/glm-5.2-updated", workspaceDir: "/tmp" });
  assert.equal(staged.readiness.state, "ready", "candidate prerequisite probe remains independently ready");
  await staged.commit();
  assert.equal(events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").length,
    authStatusCount, "hot commit must not replace projected unauthenticated readiness with an error/ready status");
  assert.equal(events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").at(-1).readiness.state,
    "unauthenticated");

  const retry = await host.deliver("cli_authFailedA1", { message_id: "om_auth_failed" });
  stagedSession.emit({ type: "turn-start", turnId: "turn-auth-empty" });
  stagedSession.emit({ type: "turn-end", turnId: "turn-auth-empty" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retry.status, "accepted");
  assert.equal(events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").at(-1).readiness.state,
    "unauthenticated", "an empty/aborted turn is not authenticated evidence");

  stagedSession.emit({ type: "turn-start", turnId: "turn-auth-aborted" });
  stagedSession.emit({ type: "activity", activity: "text" });
  stagedSession.emit({ type: "input-error", inputId: retry.deliveryId, retryable: true, willRetry: false,
    message: "Pi assistant turn aborted" });
  stagedSession.emit({ type: "turn-end", turnId: "turn-auth-aborted" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").at(-1).readiness.state,
    "unauthenticated", "partial output from an aborted turn is not authenticated success");

  stagedSession.emit({ type: "turn-start", turnId: "turn-auth-recovered" });
  stagedSession.emit({ type: "activity", activity: "text" });
  stagedSession.emit({ type: "turn-end", turnId: "turn-auth-recovered" });
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").at(-1);
  assert.equal(recovered.status, "active");
  assert.equal(recovered.readiness.state, "ready");
  await host.shutdown("provider auth readiness test complete");
});

test("synchronous terminal rejection returns an explicit error receipt and a later explicit delivery retries the same ownership", async () => {
  const session = new FakeSession();
  let reject = true;
  session.prompt = async function(input) {
    this.prompts.push(input);
    return reject
      ? { status: "rejected", inputId: input.inputId, retryable: false, reason: "invalid fixture request" }
      : { status: "accepted", inputId: input.inputId };
  };
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder() });
  await host.start([{ agentId: "cli_terminalReceiptA1", name: "terminal", runtime: "codex", model: "g", workspaceDir: "/tmp" }]);
  const first = await host.deliver("cli_terminalReceiptA1", { message_id: "interaction_terminal_receipt" });
  assert.deepEqual(first, { status: "error", deliveryId: first.deliveryId, reason: "invalid fixture request", retryable: false });
  reject = false;
  const recovered = await host.deliver("cli_terminalReceiptA1", { message_id: "interaction_terminal_receipt" });
  assert.equal(recovered.status, "accepted");
  assert.equal(recovered.deliveryId, first.deliveryId);
  assert.equal(session.prompts[1].inputId, first.deliveryId);
  assert.equal(session.prompts[1].attempt, 1);
  await host.shutdown("terminal receipt contract test complete");
});

test("retryable busy-input error waits for the real turn boundary before retrying", async () => {
  const session = new FakeSession();
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder() });
  await host.start([{ agentId: "cli_busyErrorA1", name: "cli_busyErrorA1", runtime: "codex", model: "g", workspaceDir: "/tmp" }]);
  await host.deliver("cli_busyErrorA1", { message_id: "om_turn_owner" });
  session.emit({ type: "turn-start", turnId: "turn-owner" });
  const busyReceipt = await host.deliver("cli_busyErrorA1", { message_id: "om_failed_steer" });
  session.emit({ type: "input-error", inputId: busyReceipt.deliveryId, retryable: true, message: "steer rejected" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 1, "active turn is not mistaken for an idle boundary");
  session.emit({ type: "turn-end", turnId: "turn-owner" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 2);
  assert.equal(session.prompts[1].inputId, busyReceipt.deliveryId);
  await host.shutdown("test complete");
});

test("aborted prompt plus busy steer retries one owner per real terminal boundary", async () => {
  const session = new FakeSession();
  const calls = [];
  session.prompt = async function(input) {
    this.prompts.push(input); calls.push(`prompt:${input.inputId}`);
    return { status: "accepted", inputId: input.inputId };
  };
  session.busyInput = async function(input) {
    this.steers.push(input); calls.push(`steer:${input.inputId}`);
    return { status: "accepted", inputId: input.inputId };
  };
  const host = createRuntimeHost({ adapterFor: () => ({ id: "pi", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder() });
  await host.start([{ agentId: "cli_abortOwnedA1", name: "abort-owned", runtime: "pi", model: "fixture/pi", workspaceDir: "/tmp" }]);
  const prompt = await host.deliver("cli_abortOwnedA1", { message_id: "om_abort_owner_a" });
  session.emit({ type: "turn-start", turnId: "turn-abort-owned" });
  const steer = await host.deliver("cli_abortOwnedA1", { message_id: "om_abort_owner_b" });
  session.emit({ type: "activity", activity: "text" });
  session.emit({ type: "input-error", inputId: prompt.deliveryId, retryable: true, willRetry: false, message: "Pi assistant turn aborted" });
  session.emit({ type: "input-error", inputId: steer.deliveryId, retryable: true, willRetry: false, message: "Pi assistant turn aborted" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [`prompt:${prompt.deliveryId}`, `steer:${steer.deliveryId}`], "no retry may start before turn-end");

  session.emit({ type: "turn-end", turnId: "turn-abort-owned" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [`prompt:${prompt.deliveryId}`, `steer:${steer.deliveryId}`, `prompt:${prompt.deliveryId}`]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3, "only one serialized prompt starts after the aborted boundary");

  session.emit({ type: "turn-start", turnId: "turn-abort-retry-a" });
  session.emit({ type: "turn-end", turnId: "turn-abort-retry-a" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [`prompt:${prompt.deliveryId}`, `steer:${steer.deliveryId}`, `prompt:${prompt.deliveryId}`, `prompt:${steer.deliveryId}`]);
  await host.shutdown("aborted ownership test complete");
});

test("a failed Codex turn closes both prompt and steer deliveries instead of leaving accepted ownership", async () => {
  let stored = { version: 1, records: [] };
  const stateStore = {
    withInboxTransaction(operation) { return operation(); },
    readJson(_key, fallback) { return structuredClone(stored ?? fallback); },
    writeJson(_key, value) { stored = structuredClone(value); },
  };
  const session = new FakeSession();
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => stateStore });
  await host.start([{ agentId: "cli_turnOwnA1", name: "cli_turnOwnA1", runtime: "codex", model: "g", workspaceDir: "/tmp" }]);
  const prompt = await host.deliver("cli_turnOwnA1", { message_id: "om_owned_A" });
  session.emit({ type: "turn-start", turnId: "turn-owned" });
  const steer = await host.deliver("cli_turnOwnA1", { message_id: "om_owned_B" });
  session.emit({ type: "input-error", inputId: prompt.deliveryId, retryable: false, willRetry: false, message: "turn failed" });
  session.emit({ type: "input-error", inputId: steer.deliveryId, retryable: false, willRetry: false, message: "turn failed" });
  session.emit({ type: "turn-end", turnId: "turn-owned" });
  await new Promise((resolve) => setImmediate(resolve));
  const owned = stored.records.filter((record) => [prompt.deliveryId, steer.deliveryId].includes(record.deliveryId));
  assert.deepEqual(owned.map((record) => record.status).sort(), ["error", "error"]);
  assert.equal(owned.some((record) => record.status === "accepted"), false);
  await host.shutdown("test complete");
});

test("terminal input events during a busy submission coalesce one retry after submit without spinning", async () => {
  let stored = { version: 1, records: [] };
  const stateStore = {
    withInboxTransaction(operation) { return operation(); },
    readJson(_key, fallback) { return structuredClone(stored ?? fallback); },
    writeJson(_key, value) { stored = structuredClone(value); },
  };
  const session = new FakeSession();
  let releaseBusy;
  session.busyInput = async (input) => {
    session.steers.push(input);
    return new Promise((resolve) => { releaseBusy = resolve; });
  };
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => stateStore });
  await host.start([{ agentId: "cli_coalesceA1", name: "cli_coalesceA1", runtime: "codex", model: "g", workspaceDir: "/tmp" }]);
  const prompt = await host.deliver("cli_coalesceA1", { message_id: "om_coalesce_A" });
  session.emit({ type: "turn-start", turnId: "turn-coalesce" });
  const busyDelivery = host.deliver("cli_coalesceA1", { message_id: "om_coalesce_B" });
  await new Promise((resolve) => setImmediate(resolve));
  const busyInputId = session.steers[0].inputId;
  session.emit({ type: "input-error", inputId: prompt.deliveryId, retryable: true, willRetry: false, message: "interrupted" });
  session.emit({ type: "input-error", inputId: busyInputId, retryable: true, willRetry: false, message: "interrupted" });
  session.emit({ type: "turn-end", turnId: "turn-coalesce" });
  releaseBusy({ status: "rejected", inputId: busyInputId, retryable: true, reason: "interrupted" });
  assert.equal((await busyDelivery).status, "deferred");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 2, "one coalesced retry runs after the busy submit settles");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.prompts.length, 2, "coalescing does not create an immediate retry spin");
  session.emit({ type: "turn-start", turnId: "turn-coalesced-retry" });
  session.emit({ type: "turn-end", turnId: "turn-coalesced-retry" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 3, "the second pending input retries at the next real boundary");
  assert.equal(stored.records.some((record) => record.status === "pending" || record.status === "submitting"), false);
  await host.shutdown("test complete");
});

test("session recreation uses bounded exponential retries, reports exhaustion, and stop cancels timers", async () => {
  const first = new FakeSession();
  let creates = 0;
  const errors = [];
  const adapter = { id: "claude", capabilities: {}, async createSession() {
    creates += 1;
    if (creates === 1) return first;
    throw new Error(`launch-${creates}-failed`);
  } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    retryPolicy: { baseDelayMs: 4, maxDelayMs: 8, maxAttempts: 2 } });
  host.subscribe((event) => { if (event.type === "agent-status" && event.status === "error") errors.push(event.error); });
  await host.start([{ agentId: "cli_backoffA1", name: "cli_backoffA1", runtime: "claude", model: "c", workspaceDir: "/tmp" }]);
  first.emit({ type: "closed", code: 1, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(creates, 3, "initial session plus exactly two bounded recreation attempts");
  assert.ok(errors.some((message) => /attempt 1\/2 in 4ms/.test(message)));
  assert.ok(errors.some((message) => /attempt 2\/2 in 8ms/.test(message)));
  assert.ok(errors.some((message) => /recreation exhausted after 2 attempts/.test(message)));
  await host.shutdown("test complete");

  const delayed = new FakeSession();
  let delayedCreates = 0;
  const delayedHost = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() {
    delayedCreates += 1; return delayed;
  } }), promptBuilder: new ContextPromptBuilder(), retryPolicy: { baseDelayMs: 40, maxDelayMs: 40, maxAttempts: 2 } });
  await delayedHost.start([{ agentId: "cli_cancelRetryA1", name: "cli_cancelRetryA1", runtime: "codex", model: "g", workspaceDir: "/tmp" }]);
  delayed.emit({ type: "closed", code: 1, signal: null });
  await delayedHost.shutdown("stop before retry");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(delayedCreates, 1, "stop cancels a scheduled recreation");
});

test("accepted persistence racing CLI consumption emits consumed exactly once and not stale accepted", async () => {
  let stored = { version: 1, records: [] };
  let consumeInputId = null;
  const stateStore = {
    withInboxTransaction(operation) { return operation(); },
    readJson(_key, fallback) {
      if (!stored) return fallback;
      if (consumeInputId) stored = { ...stored, records: stored.records.map((record) =>
        record.deliveryId === consumeInputId ? { ...record, status: "consumed" } : record) };
      return structuredClone(stored);
    },
    writeJson(_key, value) { stored = structuredClone(value); },
  };
  const session = new FakeSession();
  session.prompt = async (input) => { session.prompts.push(input); consumeInputId = input.inputId; return { status: "accepted", inputId: input.inputId }; };
  const events = [];
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => stateStore });
  host.subscribe((event) => events.push(event));
  await host.start([{ agentId: "cli_consumeRaceA1", name: "cli_consumeRaceA1", runtime: "codex", model: "g", workspaceDir: "/tmp" }]);
  const receipt = await host.deliver("cli_consumeRaceA1", { message_id: "om_consume_race" });
  const deliveryEvents = events.filter((event) => event.type === "delivery" && event.deliveryId === receipt.deliveryId);
  assert.deepEqual(deliveryEvents.map((event) => event.status), ["consumed"]);
  await host.shutdown("test complete");
});

test("session closed in the subscription microtask is recreated after starting settles", async () => {
  const sessions = [];
  const adapter = { id: "claude", capabilities: {}, async createSession() {
    const session = new FakeSession();
    session.sessionId = `microtask-${sessions.length + 1}`;
    if (sessions.length === 0) {
      const baseSubscribe = session.subscribe.bind(session);
      session.subscribe = (listener) => {
        const unsubscribe = baseSubscribe(listener);
        queueMicrotask(() => session.emit({ type: "closed", code: 1, signal: null }));
        return unsubscribe;
      };
    }
    sessions.push(session);
    return session;
  } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    retryPolicy: { baseDelayMs: 3, maxDelayMs: 3, maxAttempts: 2, stableWindowMs: 20 } });
  await host.start([{ agentId: "cli_microCloseA1", name: "cli_microCloseA1", runtime: "claude", model: "c", workspaceDir: "/tmp" }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessions.length, 2, "starting settlement schedules the recreate that close could not schedule synchronously");
  await host.shutdown("test complete");
});

test("short-lived successful creations share one crash epoch and reach bounded exhaustion", async () => {
  let creates = 0;
  const errors = [];
  const adapter = { id: "pi", capabilities: {}, async createSession() {
    creates += 1;
    const session = new FakeSession();
    session.sessionId = `short-${creates}`;
    const baseSubscribe = session.subscribe.bind(session);
    session.subscribe = (listener) => {
      const unsubscribe = baseSubscribe(listener);
      setTimeout(() => session.emit({ type: "closed", code: 1, signal: null }), 2);
      return unsubscribe;
    };
    return session;
  } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    retryPolicy: { baseDelayMs: 2, maxDelayMs: 4, maxAttempts: 2, stableWindowMs: 20 } });
  host.subscribe((event) => { if (event.type === "agent-status" && event.status === "error") errors.push(event.error); });
  await host.start([{ agentId: "cli_crashEpochA1", name: "cli_crashEpochA1", runtime: "pi", model: "p", workspaceDir: "/tmp" }]);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(creates, 3, "initial session plus two recreation attempts remain bounded");
  assert.ok(errors.some((message) => /recreation exhausted after 2 attempts/.test(message)), errors.join("\n"));
  await host.shutdown("test complete");
});
