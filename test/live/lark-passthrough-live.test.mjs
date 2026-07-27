// Real API smoke for top-level lark-cli passthrough: hits the real lark-cli + Feishu backend with the
// configured Agent's own bot identity. Default-skipped so CI never touches real dependencies.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = path.join(ROOT, "dist", "app", "cli.mjs");
const ENABLED = process.env.LARKIN_RUN_FEISHU_LIVE_TEST === "1";
const SKIP_REASON = "set LARKIN_RUN_FEISHU_LIVE_TEST=1 to hit the real lark-cli with the configured bot identity";

function firstJson(text) {
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try { return JSON.parse(trimmed); } catch { /* keep scanning */ }
  }
  try { return JSON.parse(text); } catch { return null; }
}

test.skipIf(!ENABLED)(`larkin top-level passthrough reaches the real Feishu backend as the Agent's own bot (${SKIP_REASON})`, () => {
  const result = spawnSync(process.execPath, [ENTRY, "im", "+chat-list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = firstJson(result.stdout) || firstJson(result.stderr);
  assert.ok(payload, `expected JSON output from lark-cli, got: ${(result.stdout || result.stderr).slice(0, 200)}`);
  assert.equal(payload.ok, true, `real chat-list must succeed for the locked bot identity: ${JSON.stringify(payload.error || {}).slice(0, 200)}`);
});
