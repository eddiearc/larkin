import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiRpcClient } from "../../dist/runtime/pi-rpc-client.mjs";

const RUN = process.env.LARKIN_RUN_BUILTIN_PI_OAUTH_E2E === "1";
const ROOT = path.resolve(import.meta.dirname, "../..");
const MODEL = String(process.env.LARKIN_BUILTIN_PI_OAUTH_MODEL || "openai-codex/gpt-5.6-sol").trim();
const PROVIDER = MODEL.split("/")[0];
const MARKER = String(process.env.LARKIN_BUILTIN_PI_OAUTH_MARKER || "BUILTIN_PI_OAUTH_OK").trim();
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:@+\/-]{0,255}$/.test(MODEL)) throw new Error("LARKIN_BUILTIN_PI_OAUTH_MODEL must be provider/model");
if (!/^[A-Z0-9_]{3,64}$/.test(MARKER)) throw new Error("LARKIN_BUILTIN_PI_OAUTH_MARKER must be a safe marker");

test.skipIf(!RUN)("compiled bundled Pi uses an existing official OAuth credential for a real turn without Feishu", { timeout: 240_000 }, async () => {
  const sourceInput = String(process.env.LARKIN_PI_OAUTH_CREDENTIAL_DIR || "");
  assert.equal(sourceInput.length > 0 && path.isAbsolute(sourceInput), true,
    "set LARKIN_PI_OAUTH_CREDENTIAL_DIR to an explicitly authorized official Pi credential directory");
  const sourceDir = path.resolve(sourceInput);
  assert.equal(fs.statSync(sourceDir).isDirectory(), true);
  const sourceAuth = JSON.parse(fs.readFileSync(path.join(sourceDir, "auth.json"), "utf8"));
  assert.equal(sourceAuth[PROVIDER]?.type, "oauth", `authorized credential must contain OAuth for ${PROVIDER}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-builtin-pi-oauth-live-"));
  let client;
  try {
    const releaseDir = path.join(temp, "release");
    const build = spawnSync(process.execPath, ["scripts/release/build.ts", "--target", `${os.platform()}-${os.arch()}`,
      "--out-dir", releaseDir, "--allow-dirty"], { cwd: ROOT, env: process.env, encoding: "utf8", timeout: 180_000 });
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "release-manifest.json"), "utf8"));
    const artifact = path.join(releaseDir, manifest.artifacts[0].file);
    const agentDir = path.join(temp, "providers", "pi", "cli_oauthLiveA1");
    const workspace = path.join(temp, "workspace");
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(agentDir, "auth.json"), `${JSON.stringify({ [PROVIDER]: sourceAuth[PROVIDER] }, null, 2)}\n`, { mode: 0o600 });
    const child = spawn(artifact, ["__internal", "pi-rpc", "--mode", "rpc", "--no-session", "--model", MODEL], {
      cwd: workspace,
      env: { HOME: temp, PATH: "/usr/bin:/bin", LARKIN_CONFIG_DIR: temp, LARKIN_HOME: temp,
        LARKIN_PI_DISTRIBUTION: "builtin", PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    client = new PiRpcClient(child, { requestTimeoutMs: 120_000 });
    const events = [];
    const complete = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("bundled OAuth turn timed out")), 120_000);
      client.subscribe((event) => {
        events.push(event);
        if (event.type === "agent_end") { clearTimeout(timer); resolve(); }
      });
      client.subscribeFailure((error) => { clearTimeout(timer); reject(error); });
    });
    await client.request("prompt", { message: `Reply exactly ${MARKER}` });
    await complete;
    const serialized = JSON.stringify(events);
    assert.match(serialized, new RegExp(MARKER));
    const usageEvents = events.filter((event) => event.type === "message_end").map((event) => ({
      role: event.message?.role,
      usageKeys: Object.keys(event.message?.usage || {}),
    }));
    assert.equal(usageEvents.some((entry) => entry.role === "assistant" && entry.usageKeys.includes("totalTokens")), true,
      JSON.stringify(usageEvents));
    const after = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    assert.equal(after[PROVIDER]?.type, "oauth", "official request path must retain/refresh the OAuth credential in its own store");
  } finally {
    await client?.close().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
