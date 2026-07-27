import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { main } from "../../dist/app/runtime-process.mjs";
import { initializeControlAuthority } from "../../dist/app/local-control.mjs";
import { inspectProcess } from "../../dist/platform/process-state.mjs";

const mode = process.env.RUNTIME_PROCESS_EXIT_MODE;
const orderFile = process.env.RUNTIME_PROCESS_ORDER_FILE;
const readyFile = process.env.RUNTIME_PROCESS_READY_FILE;
if (!mode || !orderFile || !readyFile) throw new Error("runtime-process exit harness configuration missing");
const root = process.env.LARKIN_CONFIG_DIR;
if (!root) throw new Error("LARKIN_CONFIG_DIR missing");
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
fs.chmodSync(root, 0o700);
const supervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "app/run.mjs"], { stdio: "ignore" });
const inspectedSupervisor = inspectProcess(supervisor.pid);
if (!inspectedSupervisor.ok || !inspectedSupervisor.startToken) throw new Error("supervisor inspection failed");
fs.writeFileSync(path.join(root, "supervisor-status.json"), JSON.stringify({
  pid: supervisor.pid, commandToken: "app/run.mjs", processStartToken: inspectedSupervisor.startToken,
}), { mode: 0o600 });
process.env.LARKIN_CONTROL_AUTHORIZATION = initializeControlAuthority(root, {
  pid: supervisor.pid, processStartToken: inspectedSupervisor.startToken,
});
process.on("exit", () => supervisor.kill("SIGTERM"));

const appendOrder = (entry) => fs.appendFileSync(orderFile, `${entry}\n`);
const runtimeHost = {
  subscribe() { return () => {}; },
  async start() {},
  async deliver() { throw new Error("not used"); },
  async stop() {},
  async shutdown() { appendOrder("runtime-shutdown"); },
};
const channelPackage = {
  createLarkChannel() {
    setInterval(() => {}, 60_000);
    return {
      botIdentity: { openId: "ou_exit", name: "Exit Harness" },
      rawClient: null,
      dispatcher: { register() {} },
      on() {},
      connect() {
        fs.writeFileSync(readyFile, "ready");
        return mode === "fatal"
          ? Promise.reject(new Error("unauthorized channel canary"))
          : Promise.resolve();
      },
      disconnect() {
        appendOrder("channel-disconnect-start");
        return new Promise(() => {});
      },
    };
  },
};

main(process.env, {
  runtimeHost,
  channelPackage,
  eventSourceStartDelayMs: 0,
  channelDisconnectTimeoutMs: 50,
});
