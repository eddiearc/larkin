import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createAgentControlServer, initializeControlAuthority } from "../../dist/app/local-control.mjs";
import { currentProcessMetadata, inspectProcess } from "../../dist/platform/process-state.mjs";

const root = process.env.LARKIN_CONFIG_DIR;
const calls = process.env.LARKIN_CONTROL_CALLS;
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
const server = createAgentControlServer({
  larkinHome: root,
  authorityToken,
  async upsert(request) {
    fs.appendFileSync(calls, `start:${request.operationId}:${request.agentId}\n`);
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.LARKIN_CONTROL_DELAY_MS || 0)));
    fs.appendFileSync(calls, `end:${request.operationId}:${request.agentId}\n`);
  },
});
await server.start();
console.log("ready");
const stop = async () => { await server.close(); supervisor.kill("SIGTERM"); process.exit(0); };
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
