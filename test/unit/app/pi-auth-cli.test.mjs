import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");

test("public pi-auth status is non-sensitive and logout preserves unrelated provider credentials", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-auth-cli-"));
  const agentId = "cli_authCliA1";
  const marker = path.join(temp, "command-marker");
  const deepseekKey = `!touch ${marker}`;
  const oauthAccess = "oauth-access-secret-sentinel";
  try {
    fs.chmodSync(temp, 0o700);
    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-auth-cli", mentionPolicy: "require", activeAgent: agentId,
      agents: { [agentId]: { runtime: "pi", piDistribution: "builtin", model: "deepseek/deepseek-v4-pro", createdAt: "2026-08-06T00:00:00.000Z" } },
    }, null, 2)}\n`, { mode: 0o600 });
    const directory = path.join(temp, "providers", "pi", agentId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const original = {
      deepseek: { type: "api_key", key: deepseekKey },
      anthropic: { type: "oauth", access: oauthAccess, refresh: "oauth-refresh-secret", expires: Date.now() + 3_600_000 },
    };
    const authPath = path.join(directory, "auth.json");
    const originalBytes = `${JSON.stringify(original, null, 2)}\n`;
    fs.writeFileSync(authPath, originalBytes, { mode: 0o600 });
    const env = { ...process.env, LARKIN_CONFIG_DIR: temp, LARKIN_HOME: temp };
    const status = spawnSync(process.execPath, ["dist/app/binary-entry.mjs", "pi-auth", "status", "--agent", agentId, "--json"], {
      cwd: ROOT, env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.agentId, agentId);
    assert.deepEqual(payload.credentials.map(({ providerId, credentialType, stored }) => ({ providerId, credentialType, stored })), [
      { providerId: "anthropic", credentialType: "oauth", stored: true },
      { providerId: "deepseek", credentialType: "api_key", stored: true },
    ]);
    assert.doesNotMatch(status.stdout + status.stderr, new RegExp(`${deepseekKey}|${oauthAccess}|oauth-refresh-secret`));
    assert.equal(fs.existsSync(marker), false, "status must not execute !command API keys");
    assert.equal(fs.readFileSync(authPath, "utf8"), originalBytes, "status must preserve exact auth bytes");
    assert.equal(fs.existsSync(path.join(directory, "models.json")), false);
    assert.equal(fs.existsSync(path.join(directory, "models-store.json")), false);

    const logout = spawnSync(process.execPath, ["dist/app/binary-entry.mjs", "pi-auth", "logout", "deepseek", "--agent", agentId], {
      cwd: ROOT, env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(logout.status, 0, logout.stderr);
    const remaining = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.equal(remaining.deepseek, undefined);
    assert.deepEqual(remaining.anthropic, original.anthropic);
    assert.equal(fs.existsSync(marker), false, "logout must not execute the removed !command API key");
    assert.doesNotMatch(logout.stdout + logout.stderr, new RegExp(`${deepseekKey}|${oauthAccess}|oauth-refresh-secret`));
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("pi-auth providers is a redacted catalog and login rejects API keys in argv", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-auth-login-cli-"));
  const agentId = "cli_authCliB2";
  const secret = "argv-super-secret-key";
  try {
    fs.chmodSync(temp, 0o700);
    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-auth-cli-login", mentionPolicy: "require", activeAgent: agentId,
      agents: { [agentId]: { runtime: "pi", piDistribution: "builtin", model: "default", createdAt: "2026-09-04T00:00:00.000Z" } },
    }, null, 2)}\n`, { mode: 0o600 });
    fs.mkdirSync(path.join(temp, "providers", "pi", agentId), { recursive: true, mode: 0o700 });
    const env = { ...process.env, LARKIN_CONFIG_DIR: temp, LARKIN_HOME: temp };
    const providers = spawnSync(process.execPath, ["dist/app/binary-entry.mjs", "pi-auth", "providers", "--json"], {
      cwd: ROOT, env, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(providers.status, 0, providers.stderr);
    const catalog = JSON.parse(providers.stdout);
    assert.ok(catalog.providers.some((entry) => entry.id === "deepseek" && entry.defaultModel === "deepseek/deepseek-v4-pro"));
    assert.ok(catalog.providers.some((entry) => entry.id === "custom" && entry.openaiCompatible && entry.custom));
    assert.doesNotMatch(providers.stdout, /api[_-]?key|sk-|Bearer /i);

    const rejected = spawnSync(process.execPath, [
      "dist/app/binary-entry.mjs", "pi-auth", "login", "deepseek", "--agent", agentId, "--api-key", secret,
    ], { cwd: ROOT, env, encoding: "utf8", timeout: 15_000 });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /api-key-stdin|TTY prompt/i);
    assert.doesNotMatch(`${rejected.stdout}\n${rejected.stderr}`, new RegExp(secret));
    assert.equal(fs.existsSync(path.join(temp, "providers", "pi", agentId, "auth.json")), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("stdin API key strips every trailing newline and leaves embedded newlines rejected", async () => {
  const { normalizeStdinApiKey } = await import(new URL(`file://${path.join(ROOT, "dist/app/pi-auth-cli.mjs")}`).href);
  assert.equal(normalizeStdinApiKey("secret\n"), "secret");
  assert.equal(normalizeStdinApiKey("secret\n\n"), "secret");
  assert.equal(normalizeStdinApiKey("secret\r\n\r\n"), "secret");
  assert.equal(normalizeStdinApiKey("secret\r\n\n"), "secret");
  assert.equal(normalizeStdinApiKey("\uFEFFsecret\n\n"), "secret");
  assert.equal(normalizeStdinApiKey("sec\nret\n\n"), "sec\nret");
});

function startNeverEndingKeyPipe(prefix) {
  return spawn(process.execPath, ["-e", `
    process.stdout.write(${JSON.stringify(prefix)} + "A".repeat(20_000));
    setInterval(() => {
      try { process.stdout.write("B".repeat(4096)); } catch { /* 读端关闭后停止 */ }
    }, 10);
  `], { stdio: ["ignore", "pipe", "pipe"] });
}

test("bounded stdin strips trailing newlines on the fd path and rejects an oversized pipe before EOF", async () => {
  const { readStdinSecret } = await import(new URL(`file://${path.join(ROOT, "dist/app/pi-auth-cli.mjs")}`).href);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-auth-stdin-bound-"));
  const secret = "bounded-fd-newline-secret";
  const sentinel = "oversize-pipe-secret-sentinel";
  const writer = startNeverEndingKeyPipe(sentinel);
  try {
    fs.writeFileSync(path.join(temp, "key"), `\uFEFF${secret}\r\n\n`);
    const fd = fs.openSync(path.join(temp, "key"), "r");
    try {
      assert.equal(await readStdinSecret({ fd, isTTY: false }), secret);
    } finally { fs.closeSync(fd); }

    fs.writeFileSync(path.join(temp, "oversize"), `${sentinel}${"A".repeat(20_000)}${"C".repeat(64_000)}`);
    const oversizeFd = fs.openSync(path.join(temp, "oversize"), "r");
    try {
      await assert.rejects(() => readStdinSecret({ fd: oversizeFd, isTTY: false }), (error) => {
        assert.match(String(error.message), /API Key|控制字符/);
        assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, new RegExp(sentinel));
        return true;
      });
    } finally { fs.closeSync(oversizeFd); }

    const started = Date.now();
    await assert.rejects(() => readStdinSecret(writer.stdout), (error) => {
      assert.match(String(error.message), /API Key|控制字符/);
      assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, new RegExp(sentinel));
      return true;
    });
    assert.ok(Date.now() - started < 2_000, "must reject the oversized pipe without waiting for EOF");
  } finally {
    writer.kill("SIGTERM");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("oversized --api-key-stdin pipe does not persist or leak before daemon apply", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-auth-oversize-"));
  const agentId = "cli_authCliOversize1";
  const sentinel = "compiled-oversize-pipe-secret";
  fs.chmodSync(temp, 0o700);
  fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-auth-oversize", mentionPolicy: "require", activeAgent: agentId,
    agents: { [agentId]: { runtime: "pi", piDistribution: "builtin", model: "default", createdAt: "2026-09-04T00:00:00.000Z" } },
  }, null, 2)}\n`, { mode: 0o600 });
  fs.mkdirSync(path.join(temp, "providers", "pi", agentId), { recursive: true, mode: 0o700 });
  const login = spawn(process.execPath, [
    path.join(ROOT, "dist/app/binary-entry.mjs"),
    "pi-auth", "login", "deepseek", "--agent", agentId, "--api-key-stdin", "--json",
  ], {
    cwd: ROOT,
    env: { ...process.env, LARKIN_CONFIG_DIR: temp, LARKIN_HOME: temp },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    login.stdin.write(`${sentinel}${"A".repeat(20_000)}`);
    const pump = setInterval(() => {
      if (!login.stdin.writableEnded) {
        try { login.stdin.write("B".repeat(4096)); } catch { /* 子进程已退出 */ }
      }
    }, 10);
    const finished = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("compiled CLI hung waiting for stdin EOF")), 3_000);
      let stdout = "";
      let stderr = "";
      login.stdout.on("data", (chunk) => { stdout += chunk; });
      login.stderr.on("data", (chunk) => { stderr += chunk; });
      login.on("error", (error) => {
        clearTimeout(timer);
        clearInterval(pump);
        reject(error);
      });
      login.on("exit", (status) => {
        clearTimeout(timer);
        clearInterval(pump);
        resolve({ status, stdout, stderr });
      });
    });
    assert.notEqual(finished.status, 0);
    assert.match(`${finished.stdout}\n${finished.stderr}`, /API Key|控制字符|api-key-stdin/i);
    assert.doesNotMatch(`${finished.stdout}\n${finished.stderr}`, new RegExp(sentinel));
    assert.equal(fs.existsSync(path.join(temp, "providers", "pi", agentId, "auth.json")), false);
  } finally {
    if (login.exitCode === null && login.signalCode === null) login.kill("SIGTERM");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("non-TTY login without --api-key-stdin is rejected and does not persist", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-auth-nontty-"));
  const agentId = "cli_authCliC3";
  try {
    fs.chmodSync(temp, 0o700);
    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-auth-nontty", mentionPolicy: "require", activeAgent: agentId,
      agents: { [agentId]: { runtime: "pi", piDistribution: "builtin", model: "default", createdAt: "2026-09-04T00:00:00.000Z" } },
    }, null, 2)}\n`, { mode: 0o600 });
    fs.mkdirSync(path.join(temp, "providers", "pi", agentId), { recursive: true, mode: 0o700 });
    const { main } = await import(new URL(`file://${path.join(ROOT, "dist/app/pi-auth-cli.mjs")}`).href);
    await assert.rejects(() => main(
      ["login", "deepseek", "--agent", agentId],
      { ...process.env, LARKIN_CONFIG_DIR: temp, LARKIN_HOME: temp },
      { stdin: process.stdin, stdout: process.stdout, isTTY: false },
    ), /api-key-stdin/);
    assert.equal(fs.existsSync(path.join(temp, "providers", "pi", agentId, "auth.json")), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
