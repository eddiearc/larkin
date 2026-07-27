// 本地集成测试：占住起始端口，确认 dashboard 自动监听下一个端口。
// 默认跳过，避免 CI 启动真实监听；运行：RUN_DASHBOARD_PORT_TEST=1 bun test test/integration/dashboard/dashboard-port-fallback.test.mjs
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { once } from "node:events";
import { test } from "bun:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const enabled = process.env.RUN_DASHBOARD_PORT_TEST === "1";

test.skipIf(!enabled)("dashboard falls back to the next port and preserves its owner record", {
  timeout: 20_000,
}, async () => {
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-fallback-"));
const larkinHome = temp;
fs.mkdirSync(larkinHome, { recursive: true });
fs.chmodSync(larkinHome, 0o700);
fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({
  version: 3, serverId: "test-server", activeAgent: null, agents: {},
}), { mode: 0o600 });
const blocker = net.createServer();
await new Promise((resolve, reject) => blocker.once("error", reject).listen(0, "127.0.0.1", resolve));
const startPort = blocker.address().port;
if (startPort >= 65535) throw new Error("无法取得可递增的测试端口");

const child = spawn(process.execPath, [path.join(root, "dist/app/dashboard.mjs")], {
  cwd: root,
  env: { ...process.env, LARKIN_CONFIG_DIR: temp, LARKIN_DASHBOARD_PORT: String(startPort) },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

try {
  const deadline = Date.now() + 5000;
  while (!output.includes(`http://localhost:${startPort + 1}`) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!output.includes(`端口 ${startPort} 已被占用，尝试 ${startPort + 1}`)) throw new Error("没有记录端口递增");
  if (!output.includes(`http://localhost:${startPort + 1}`)) throw new Error("没有监听递增后的端口");
  const status = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${startPort + 1}/api/status`, (res) => { res.resume(); resolve(res.statusCode); }).once("error", reject);
  });
  if (status !== 200) throw new Error(`状态接口返回 ${status}`);
  const second = spawn(process.execPath, [path.join(root, "dist/app/dashboard.mjs")], {
    cwd: root,
    env: { ...process.env, LARKIN_CONFIG_DIR: temp, LARKIN_DASHBOARD_PORT: String(startPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let secondOutput = "";
  second.stdout.on("data", (chunk) => { secondOutput += chunk; });
  second.stderr.on("data", (chunk) => { secondOutput += chunk; });
  await new Promise((resolve) => second.once("exit", resolve));
  if (second.exitCode !== 0 || !/dashboard 已在运行|启动锁/.test(secondOutput)) throw new Error(`并发 dashboard 未复用/阻断：${secondOutput}`);
  const record = JSON.parse(fs.readFileSync(path.join(larkinHome, "dashboard-status.json"), "utf8"));
  if (record.pid !== child.pid || record.port !== startPort + 1) throw new Error("并发启动改写了 dashboard owner/port");
  console.log(`PASS dashboard port fallback: ${startPort} → ${startPort + 1}`);
} finally {
  if (child.exitCode === null) { child.kill("SIGINT"); await once(child, "exit"); }
  await new Promise((resolve) => blocker.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
});
