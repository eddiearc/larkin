import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
