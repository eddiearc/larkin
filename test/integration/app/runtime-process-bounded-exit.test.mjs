import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HARNESS = path.join(ROOT, "test/support/runtime-process-exit-harness.mjs");

const waitUntil = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition timeout");
};

const waitForExit = (child, timeoutMs, output) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`runtime-process required SIGKILL\n${output()}`));
    }, timeoutMs);
    const onExit = (code, signal) => { clearTimeout(timer); resolve({ code, signal }); };
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("exit", onExit);
      clearTimeout(timer);
      resolve({ code: child.exitCode, signal: child.signalCode });
    }
  });
};

for (const mode of ["signal", "fatal"]) {
  test(`production runtime-process ${mode} path exits after ordered shutdown despite a ref'd channel handle`, async () => {
    // Unix-domain socket paths are bounded on Darwin; use the canonical short
    // temporary alias so this test exercises lifecycle rather than sun_path limits.
    const temp = fs.mkdtempSync(path.join("/tmp", `larkin-rp-${mode}-`));
    const root = path.join(temp, "root");
    const readyFile = path.join(temp, "ready");
    const orderFile = path.join(temp, "order");
    const agentId = `cli_exit${mode === "signal" ? "Signal" : "Fatal"}A1`;
    const agent = {
      agentId, name: agentId, runtime: "codex", model: "gpt", feishuAppId: agentId,
      feishuAppSecret: "fixture-secret", feishuProfile: agentId, feishuDomain: "https://open.feishu.cn",
      workspaceDir: path.join(root, "agents", agentId), stateDir: path.join(root, "state", "agents", agentId),
    };
    const child = spawn(process.execPath, [HARNESS, "app/runtime-process.mjs"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: path.join(temp, "home"),
        LARKIN_HOME: root,
        LARKIN_CONFIG_DIR: root,
        LARKIN_SERVER_ID: "server-runtime-process-exit",
        LARKIN_AGENTS_CONFIG: JSON.stringify([agent]),
        LARKIN_INBOUND_DROUGHT_SEC: "0",
        RUNTIME_PROCESS_EXIT_MODE: mode,
        RUNTIME_PROCESS_ORDER_FILE: orderFile,
        RUNTIME_PROCESS_READY_FILE: readyFile,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    try {
      await waitUntil(() => fs.existsSync(readyFile) || child.exitCode !== null, 2_000);
      assert.equal(fs.existsSync(readyFile), true, output);
      const startedAt = Date.now();
      if (mode === "signal") child.kill("SIGTERM");
      const result = await waitForExit(child, 1_000, () => output);
      assert.ok(Date.now() - startedAt < 1_000, `runtime-process ${mode} exit exceeded bound`);
      assert.deepEqual(result, { code: mode === "signal" ? 143 : 1, signal: null }, output);
      assert.deepEqual(fs.readFileSync(orderFile, "utf8").trim().split("\n"), [
        "channel-disconnect-start",
        "runtime-shutdown",
      ]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
