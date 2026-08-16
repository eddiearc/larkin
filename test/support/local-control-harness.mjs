import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createAgentControlServer, initializeControlAuthority } from "../../dist/app/local-control.mjs";
import { currentProcessMetadata, inspectProcess } from "../../dist/platform/process-state.mjs";
import { createRuntimeHost } from "../../dist/runtime/runtime-host.mjs";
import { createHostShell } from "../../dist/feishu/host-shell.mjs";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { createAgentStateStore } from "../../dist/agent/agent-state-store.mjs";
import { RuntimePrerequisiteError } from "../../dist/runtime/runtime-readiness.mjs";

const root = process.env.LARKIN_CONFIG_DIR;
const calls = process.env.LARKIN_CONTROL_CALLS;
const recoveryWorkflow = process.env.LARKIN_RECOVERY_WORKFLOW === "1";
if (!root || !calls) throw new Error("harness env missing");
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
fs.chmodSync(root, 0o700);
const supervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "app/run.mjs"], { stdio: "ignore" });
// Bun can expose the child PID before macOS `ps lstart` has settled to its
// final second. Do not persist an identity sampled during that launch edge.
await new Promise((resolve) => setTimeout(resolve, 150));
const inspectedSupervisor = inspectProcess(supervisor.pid);
if (!inspectedSupervisor.ok || !inspectedSupervisor.startToken) throw new Error("test supervisor inspection failed");
fs.writeFileSync(path.join(root, "supervisor-status.json"), JSON.stringify({
  pid: supervisor.pid,
  commandToken: "app/run.mjs",
  processStartToken: inspectedSupervisor.startToken,
  nonce: "test-supervisor",
}), { mode: 0o600 });
const authorityToken = initializeControlAuthority(root, {
  pid: supervisor.pid,
  processStartToken: inspectedSupervisor.startToken,
});
fs.writeFileSync(path.join(root, "daemon-status.json"), JSON.stringify({
  ...currentProcessMetadata("test/support/local-control-harness.mjs"),
  pid: process.pid,
  agents: ["cli_existingA1"],
}), { mode: 0o600 });
class ResetSession {
  listeners = new Set(); closes = []; sessionId;
  constructor(id, replayStore = null) { this.sessionId = id; this.replayStore = replayStore; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async prompt(input) {
    if (this.replayStore) setTimeout(() => { try { this.emit({ type: "turn-start" }); this.replayStore.pollInbox({ limit: 1 }); this.emit({ type: "turn-end" }); } catch {} }, 0);
    if (this.replayStore) fs.appendFileSync(calls, `replay:${input.deliveryId}:${input.inputId}\n`);
    return { status: "accepted", inputId: input.inputId };
  }
  async busyInput(input) { return this.prompt(input); }
  async cancel() {} async close(reason) { this.closes.push(reason); }
}
const resetAgentId = "cli_newA1";
let resetGeneration = 0;
const resetStore = createAgentStateStore(root, resetAgentId);
const resetRuntimeHost = createRuntimeHost({
  adapterFor: () => ({ id: "pi", capabilities: {}, async createSession() {
    return new ResetSession(`control-session-${++resetGeneration}`, recoveryWorkflow ? resetStore : null);
  } }),
  promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => resetStore, assertOfficialCliReady: () => {},
});
const resetAgent = { agentId: resetAgentId, name: resetAgentId, runtime: "pi", model: "fixture-model",
  feishuAppId: resetAgentId, feishuProfile: resetAgentId, feishuAppSecret: "fixture-secret", feishuDomain: "https://open.feishu.cn",
  larkConfigDir: path.join(root, "lark-cli-config"), workspaceDir: path.join(root, "agents", resetAgentId),
  stateDir: path.join(root, "state", "agents", resetAgentId) };
const resetHost = createHostShell({ env: { ...process.env, LARKIN_HOME: root, LARKIN_CONFIG_DIR: root,
  LARKIN_SERVER_ID: "server-control", LARKIN_AGENTS_CONFIG: JSON.stringify([resetAgent]), LARKIN_INBOUND_DROUGHT_SEC: "0" },
  runtimeHost: resetRuntimeHost, eventSourceStartDelayMs: 60_000,
  managedCliForAgent: () => ({ command: { command: "/test/lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} }),
  channelPackage: { createLarkChannel() { throw new Error("not started in control harness"); } }, logImpl: () => {} });
if (recoveryWorkflow) {
  for (let index = 0; index < 4; index += 1) resetStore.appendNdjson("inbox", { message_id: `om_workflow_context_${index}`, chat_id: "oc_workflow_context", content: "synthetic" });
  resetStore.writeJson("runtimeDeliveries", { version: 1, records: Array.from({ length: 4 }, (_, index) => ({
    deliveryId: `workflow-delivery-${index}`, messageId: `om_workflow_context_${index}`, status: "error", retryable: false,
    reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window",
    input: { inputId: `workflow-input-${index}`, deliveryId: `workflow-delivery-${index}`, kind: "wake", text: "synthetic", attempt: 0 }, updatedAt: "before",
  })) });
}
await resetHost.start();
resetStore.writeJson("status", { ...resetStore.readJson("status", {}), connectedAt: new Date().toISOString(), connectedVia: "mock",
  ...(recoveryWorkflow ? {} : { reconnectingAt: "2020-01-01T00:00:02.000Z", reconnectedAt: "2020-01-01T00:00:01.000Z" }) });
const serverOptions = {
  larkinHome: root,
  authorityToken,
  maxRememberedOperations: 3,
  async upsert(request) {
    fs.appendFileSync(calls, `start:${request.operationId}:${request.agentId}\n`);
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.LARKIN_CONTROL_DELAY_MS || 0)));
    if (request.operationId === "operation_failed_conflict_1") throw new RuntimePrerequisiteError({
      runtime: "pi", state: "unavailable", reason: "fixture readiness must not leak",
    });
    fs.appendFileSync(calls, `end:${request.operationId}:${request.agentId}\n`);
  },
  async resetSession(request) {
    fs.appendFileSync(calls, `reset:${request.agentId}\n`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const result = await resetHost.resetSession(request.agentId, request.waitReadyMs);
    return { ok: result.readyForFreshScenario, agentId: request.agentId, ...result };
  },
  async recoverSession(request) {
    if (recoveryWorkflow) {
      const result = await resetHost.recoverSession(request.agentId, request.reason, request.waitReadyMs);
      return { ok: result.recoveryCommitted, agentId: request.agentId, ...result };
    }
    return { ok: true, agentId: request.agentId, recoveryCommitted: true, generationChanged: true,
      sessionChanged: true, turns: 0, runtimeReady: false, channelConnected: true, reconnecting: false,
      pendingCount: 4, rearmedCount: 4, replayStatus: "pending", remainingPendingCount: 4,
      readyForFreshScenario: false, inboundObserved: false,
      readiness: { runtime: "pi", state: "unavailable", executable: "/private/bin/pi", reason: "raw /private response", nextAction: "raw secret" } };
  },
};
let server = createAgentControlServer(serverOptions);
await server.start();
console.log("ready");
process.on("SIGUSR2", () => { void (async () => {
  await server.close();
  fs.mkdirSync(JSON.parse(fs.readFileSync(path.join(root, "daemon-control-auth.json"), "utf8")).socketRoot, { recursive: true, mode: 0o700 });
  server = createAgentControlServer(serverOptions);
  await server.start();
  fs.writeFileSync(path.join(root, "control-restarted"), "ready");
})().catch((error) => { console.error(error); process.exit(1); }); });
const stop = async () => { await server.close(); await resetHost.shutdown("control harness stop"); supervisor.kill("SIGTERM"); process.exit(0); };
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
