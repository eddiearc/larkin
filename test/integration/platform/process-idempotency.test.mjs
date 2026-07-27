import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentProcessMetadata } from "../../../dist/platform/process-state.mjs";

process.env.LARKIN_BUN_TEST_RUNNER = "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-idempotent-"));
const larkinHome = temp;
fs.mkdirSync(larkinHome, { recursive: true });
fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({
  version: 3,
  serverId: "test-server",
  activeAgent: "cli_agenta",
  agents: {
    cli_agenta: { runtime: "codex", model: "gpt-5.5" },
    cli_agentb: { runtime: "codex", model: "gpt-5.5" },
  },
}), { mode: 0o600 });
const current = currentProcessMetadata(path.basename(process.argv[1]));
fs.writeFileSync(path.join(larkinHome, "supervisor-status.json"), JSON.stringify({
  ...current,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  daemonPid: process.pid + 1,
  dashboardPid: process.pid,
}));
fs.writeFileSync(path.join(larkinHome, "dashboard-status.json"), JSON.stringify({
  ...current,
  pid: process.pid,
  startedAt: new Date().toISOString(),
}));

const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, "dist/app/run.mjs"), ...args], {
  cwd: ROOT,
  env: { ...process.env, LARKIN_CONFIG_DIR: temp },
  encoding: "utf8",
});

const runRuntime = fs.readFileSync(path.join(ROOT, "dist/app/run.mjs"), "utf8");
assert.match(runRuntime, /^#!\/usr\/bin\/env bun/);
assert.match(runRuntime, /function main/);
assert.doesNotMatch(runRuntime, /packages\/larkin-shell|fork\/feishu/);
const runSource = fs.readFileSync(path.join(ROOT, "src/app/run.ts"), "utf8");
assert.match(runSource, /before\.supervisor\.state === "owned"/);
assert.match(runSource, /supervisor-launch\.lock\.json/);

try {
  const same = run("--agent", "cli_agenta");
  assert.equal(same.status, 0);
  assert.match(same.stdout, /统一 supervisor 运行.*不重复启动/);

  const defaultStart = run();
  assert.equal(defaultStart.status, 0);
  assert.match(defaultStart.stdout, /统一 supervisor 运行.*不重复启动/);

  const missing = run("--agent", "cli_agentb");
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /统一 supervisor 运行.*不重复启动/);
  console.log("  ✓ start 检测现有统一 supervisor，不重复启动 daemon/dashboard");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
