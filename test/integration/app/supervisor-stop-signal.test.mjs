import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { readProcessState } from "../../../dist/platform/process-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT = "cli_stopSignalA1";

function writePrivate(file, value) {
  fs.writeFileSync(file, `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

test("supervisor logs the stop signal, and a closed terminal (SIGHUP) stops it like SIGTERM", { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-supervisor-signal-"));
  fs.chmodSync(root, 0o700);
  const binDir = path.join(root, "bin");
  const cliPackage = path.join(binDir, "node_modules", "@larksuite", "cli");
  fs.mkdirSync(path.join(cliPackage, "scripts"), { recursive: true, mode: 0o700 });
  writePrivate(path.join(cliPackage, "package.json"), {
    name: "@larksuite/cli", version: "1.0.80", bin: { "lark-cli": "scripts/run.mjs" },
  });
  const cliScript = path.join(cliPackage, "scripts", "run.mjs");
  fs.writeFileSync(cliScript, `#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.0.80"); process.exit(0); }
if (args[0] === "config" && args[1] === "bind" && args[2] === "--help") { console.log("--source lark-channel --identity bot-only"); process.exit(0); }
if (args[0] === "config" && args[1] === "bind") {
  const source = JSON.parse(fs.readFileSync(process.env.LARK_CHANNEL_CONFIG, "utf8"));
  const appId = source.accounts.app.id;
  const directory = path.join(process.env.LARKSUITE_CLI_CONFIG_DIR, "lark-channel");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ apps: [{ appId, name: appId, appSecret: { source: "keychain", id: \`appsecret:\${appId}\` }, defaultAs: "bot", strictMode: "bot", users: [] }] }) + "\\n", { mode: 0o600 });
  process.exit(0);
}
process.exit(0);
`, { mode: 0o700 });
  fs.symlinkSync(cliScript, path.join(binDir, "lark-cli"));
  writePrivate(path.join(root, "config.json"), {
    version: 3, serverId: "00000000-0000-0000-0000-000000000146", activeAgent: AGENT,
    agents: { [AGENT]: { runtime: "codex", model: "gpt-5.5" } },
  });
  fs.mkdirSync(path.join(root, "bots"), { mode: 0o700 });
  writePrivate(path.join(root, "bots", `${AGENT}.json`), { appId: AGENT, appSecret: "fixture-secret", tenant: "feishu" });

  const supervisor = spawn(process.execPath, [path.join(ROOT, "dist/app/run.mjs"), "--dry-run"], {
    cwd: ROOT,
    env: {
      ...process.env,
      LARKIN_CONFIG_DIR: root,
      LARKIN_INTERNAL_DISPATCH: "0",
      LARKIN_BUN_TEST_RUNNER: "1",
      LARKIN_FEISHU_DRYRUN: "1",
      LARKIN_TEST_DAEMON_SCRIPT: path.join(ROOT, "test/support/supervisor-hot-attach-daemon.mjs"),
      LARKIN_TEST_DASHBOARD_SCRIPT: path.join(ROOT, "test/support/dashboard-stable.mjs"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  supervisor.stdout.on("data", (chunk) => { output += chunk; });
  supervisor.stderr.on("data", (chunk) => { output += chunk; });
  try {
    const running = await waitUntil(() => {
      const state = readProcessState(root);
      return state.daemon.state === "owned" ? state : null;
    });
    assert.ok(running, `daemon did not start\n${output}`);
    supervisor.kill("SIGHUP");
    await waitUntil(() => supervisor.exitCode !== null || supervisor.signalCode !== null);
    assert.equal(supervisor.signalCode, null, `SIGHUP must not end the supervisor without a trace\n${output}`);
    assert.match(output, /\[start\] 收到 SIGHUP，停止服务/);
    assert.throws(() => process.kill(Number(running.daemon.pid), 0), "the daemon stops with the supervisor");
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
