import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const LARKIN = path.join(ROOT, "dist", "app", "cli.mjs");

function writePrivate(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-transparent-process-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const workspace = path.join(root, "workspace");
  const agentId = "cli_transparentA1";
  const packageDir = path.join(root, "official", "node_modules", "@larksuite", "cli");
  const official = path.join(packageDir, "scripts", "run.mjs");
  const pidFile = path.join(root, "official.pid");
  for (const directory of [home, bin, workspace]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writePrivate(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "transparent-process", mentionPolicy: "require", activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "default" } },
  })}\n`);
  writePrivate(path.join(root, "state", "agents", agentId, "lark-cli-config", "config.json"), `${JSON.stringify({
    apps: [{ appId: agentId, name: agentId, appSecret: "fixture", brand: "feishu", defaultAs: "bot", strictMode: "bot", users: [] }],
  })}\n`);
  writePrivate(path.join(root, "state", "agents", agentId, "lark-channel-source", "config.json"), `${JSON.stringify({
    accounts: { app: { id: agentId, secret: { source: "exec", provider: "larkin-bot-credential", id: agentId } } },
    secrets: { providers: { "larkin-bot-credential": { source: "exec", command: process.execPath, args: [], env: {
      LARKIN_AGENT_ID: agentId, LARKIN_SECRET_PROVIDER_CONTEXT: "bind",
    } } } },
  })}\n`);
  writePrivate(path.join(root, "state", "agents", agentId, "lark-cli-config", "lark-channel", "config.json"), `${JSON.stringify({ apps: [{
    appId: agentId, appSecret: { source: "keychain", id: `appsecret:${agentId}` }, defaultAs: "bot", strictMode: "bot", users: [],
  }] })}\n`);
  writePrivate(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@larksuite/cli", version: "1.0.79", bin: { "lark-cli": "scripts/run.mjs" },
  }));
  writePrivate(official, `#!${process.execPath}
import fs from "node:fs";
if (process.argv[2] === "--version") { console.log("1.0.79"); process.exit(0); }
if (process.argv[2] === "config" && process.argv[3] === "bind" && process.argv[4] === "--help") {
  console.log("--source lark-channel --identity bot-only"); process.exit(0);
}
if (process.argv[2] === "docs" && process.argv[3] === "+stdin-echo") {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  process.stderr.write("official-stderr\\n");
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input }) + "\\n");
  process.exit(23);
}
if (process.argv[2] === "docs" && process.argv[3] === "+wait-for-term") {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  process.stdout.write("official-ready\\n");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
process.exit(64);
`, 0o700);
  fs.symlinkSync(official, path.join(bin, "lark-cli"));
  const shell = fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
  const profile = `export PATH=${JSON.stringify(bin)}:${JSON.stringify(path.dirname(process.execPath))}:/usr/bin:/bin\n`;
  writePrivate(path.join(home, ".zprofile"), profile);
  writePrivate(path.join(home, ".bash_profile"), profile);
  const env = {
    ...process.env, HOME: home, ZDOTDIR: home, BASH_ENV: path.join(home, ".bash_profile"), SHELL: shell,
    PATH: `/usr/bin:/bin:${bin}`, LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId,
  };
  return { root, workspace, pidFile, env };
}

function collect(child, input) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

test("allowed native passthrough preserves argv cwd piped stdin stdout stderr and exit code", async () => {
  const f = fixture();
  try {
    const argv = ["docs", "+stdin-echo", "argument with spaces", "--", "literal-value"];
    const child = spawn(process.execPath, [LARKIN, ...argv], { cwd: f.workspace, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
    const result = await collect(child, "piped input\nsecond line\n");
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: 23, signal: null });
    assert.equal(result.stderr, "official-stderr\n");
    assert.deepEqual(JSON.parse(result.stdout), {
      argv, cwd: fs.realpathSync(f.workspace), input: "piped input\nsecond line\n",
    });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("SIGTERM crosses the larkin wrapper chain and terminates the official CLI", { timeout: 15_000 }, async () => {
  const f = fixture();
  let officialPid;
  try {
    const child = spawn(process.execPath, [LARKIN, "docs", "+wait-for-term"], {
      cwd: f.workspace, env: f.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    await new Promise((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => reject(new Error("official CLI did not become ready")), 10_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("official-ready\n")) { clearTimeout(timer); resolve(); }
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`wrapper exited before ready: ${code}/${signal}`)));
    });
    officialPid = Number(fs.readFileSync(f.pidFile, "utf8"));
    const exit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child.kill("SIGTERM");
    const result = await exit;
    assert.deepEqual(result, { code: null, signal: "SIGTERM" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(officialPid, 0), { code: "ESRCH" });
  } finally {
    if (officialPid) { try { process.kill(officialPid, "SIGKILL"); } catch { /* Already terminated. */ } }
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
