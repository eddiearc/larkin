import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { ensureCompatibleGlobalLarkCli } from "../../dist/app/runtime-cli-binding.mjs";

const liveTest = process.env.LARKIN_RUN_GLOBAL_CLI_BINDING_LIVE === "1" ? test : test.skip;

liveTest("real user shell resolves a protocol-v1 global lark-cli", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-global-cli-live-"));
  fs.chmodSync(root, 0o700);
  try {
    const record = ensureCompatibleGlobalLarkCli(root);
    assert.equal(record.protocolVersion, 1);
    assert.ok(record.version);
    assert.equal(path.isAbsolute(record.executable), true);
    assert.equal(fs.realpathSync(record.executable), record.executable);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
