import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE = path.join(ROOT, "dist", "setup", "run-credential-preflight.mjs");
const preflight = await import(pathToFileURL(MODULE).href);

test("run credential preflight accepts only the strict record schema", () => {
  const valid = { appId: "cli_credA1", appSecret: "secret", tenant: "feishu", ownerOpenId: null, createdAt: "2026-07-16T00:00:00.000Z" };
  assert.equal(preflight.validCredentialRecord(valid, valid.appId), true);
  assert.equal(preflight.validCredentialRecord({ ...valid, appId: "cli_other" }, valid.appId), false);
  assert.equal(preflight.validCredentialRecord({ ...valid, appSecret: "" }, valid.appId), false);
  assert.equal(preflight.validCredentialRecord({ ...valid, tenant: "unknown" }, valid.appId), false);
  assert.equal(preflight.validCredentialRecord({ ...valid, extra: true }, valid.appId), false);
  assert.equal(preflight.validCredentialRecord({ ...valid, createdAt: "not-a-date" }, valid.appId), false);
  assert.equal(preflight.validCredentialRecord(Object.assign(Object.create({ inherited: true }), valid), valid.appId), false);
  const callback = { ...valid, capabilities: { cardActionCallback: {
    status: "verified-effective", requestedAt: "2026-07-23T00:00:00.000Z", verifiedAt: "2026-07-23T00:01:00.000Z",
  } } };
  assert.equal(preflight.validCredentialRecord(callback, valid.appId), true);
  assert.equal(preflight.validCredentialRecord({ ...valid, capabilities: { cardActionCallback: "requested-long-connection" } }, valid.appId), false);
});

test("run credential preflight enforces owned 0700 directory and no-follow 0600 files", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-run-credentials-"));
  const appId = "cli_credB2";
  try {
    const bots = path.join(temp, "bots");
    fs.mkdirSync(bots, { mode: 0o700 });
    const credential = path.join(bots, `${appId}.json`);
    const record = { appId, appSecret: "fixture-secret", tenant: "lark", updatedAt: "2026-07-16T01:00:00.000Z" };
    fs.writeFileSync(credential, JSON.stringify(record), { mode: 0o600 });

    assert.doesNotThrow(() => preflight.assertSecureBotsDirectory(bots));
    assert.deepEqual(preflight.loadValidatedBotCredential(bots, appId), record);

    fs.chmodSync(credential, 0o644);
    assert.throws(() => preflight.readSecureBotCredential(bots, appId), /security attributes/);
    fs.chmodSync(credential, 0o600);

    const target = path.join(temp, "outside.json");
    fs.writeFileSync(target, JSON.stringify(record), { mode: 0o600 });
    fs.rmSync(credential);
    fs.symlinkSync(target, credential);
    assert.throws(() => preflight.readSecureBotCredential(bots, appId));

    fs.rmSync(credential);
    fs.chmodSync(bots, 0o755);
    assert.throws(() => preflight.assertSecureBotsDirectory(bots), /unsafe bots directory/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("run consumes the authored TypeScript preflight through the direct build output", () => {
  const built = fs.readFileSync(path.join(ROOT, "dist", "setup", "run-credential-preflight.mjs"), "utf8");
  assert.match(built, /assertSecureBotsDirectory|readSecureBotCredential|validCredentialRecord/);
  assert.doesNotMatch(built, /packages\/larkin-shell|fork\/feishu/);
  const run = fs.readFileSync(path.join(ROOT, "src", "app", "run.ts"), "utf8");
  const runtimeAgentConfig = fs.readFileSync(path.join(ROOT, "src", "app", "runtime-agent-config.ts"), "utf8");
  assert.match(run, /from ["']\.\/runtime-agent-config\.js["']/);
  assert.match(runtimeAgentConfig, /from ["']\.\.\/setup\/run-credential-preflight\.js["']/);
  assert.doesNotMatch(run, /BOT_CREDENTIAL_FIELDS|function\s+validCredentialRecord|O_NOFOLLOW/);
  assert.doesNotMatch(runtimeAgentConfig, /BOT_CREDENTIAL_FIELDS|function\s+validCredentialRecord/);
  assert.match(runtimeAgentConfig, /O_NOFOLLOW/, "profile snapshot must independently reject symlink replacement");
});
