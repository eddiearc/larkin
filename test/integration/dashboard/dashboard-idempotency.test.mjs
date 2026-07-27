import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-"));
const larkinHome = temp;
fs.mkdirSync(larkinHome, { recursive: true });
fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({
  version: 3,
  serverId: "test-server",
  activeAgent: null,
  agents: {},
}), { mode: 0o600 });

const probe = net.createServer();
await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const env = { ...process.env, LARKIN_CONFIG_DIR: temp };
const args = [path.join(ROOT, "dist/app/dashboard.mjs"), "--port", String(port)];
const first = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
first.stdout.on("data", (chunk) => { output += chunk; });
first.stderr.on("data", (chunk) => { output += chunk; });

try {
  const statusFile = path.join(larkinHome, "dashboard-status.json");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(statusFile) && first.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fs.existsSync(statusFile), true, `dashboard 未就绪：${output}`);
  const record = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.equal(record.pid, first.pid);
  assert.equal(record.port, port);

  const second = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8" });
  assert.equal(second.status, 0);
  assert.match(second.stdout, /dashboard 已在运行.*pid/);
  assert.equal(JSON.parse(fs.readFileSync(statusFile, "utf8")).pid, first.pid);

  first.kill("SIGINT");
  await new Promise((resolve) => first.once("exit", resolve));
  assert.equal(fs.existsSync(statusFile), false);
  console.log("  ✓ dashboard 复用已有 PID/端口，不重复监听");
} finally {
  if (first.exitCode === null) first.kill("SIGKILL");
  fs.rmSync(temp, { recursive: true, force: true });
}
