import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createDeferredRuntimeHost } from "../../live/runtime-agent-interface-v2-hold-host.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DRIVER = path.join(ROOT, "test", "live", "runtime-agent-interface-v2-hold-host.mjs");
const HARNESS = path.join(ROOT, "test", "live", "runtime-agent-interface-v2-live.test.mjs");

test("live hold-host entry is default-deny and package script does not opt in", () => {
  const env = { ...process.env };
  delete env.LARKIN_RUN_RUNTIME_AGENT_INTERFACE_V2_HOLD_HOST;
  delete env.LARKIN_LIVE_HOLD_HOST_ALLOW_REAL_CHANNEL;
  const result = spawnSync(process.execPath, [DRIVER], { cwd: ROOT, env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /both explicit live channel gates must equal 1/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["test:live:runtime-agent-interface-v2:hold-host"],
    "bun run build && bun run test/live/runtime-agent-interface-v2-hold-host.mjs app/runtime-process.mjs");
});

test("hold RuntimeHost never starts a Runtime and always defers delivery", async () => {
  const host = createDeferredRuntimeHost();
  await assert.rejects(host.start([]), /exactly one Agent/);
  await host.start([{ agentId: "cli_fixtureA" }]);
  for (const messageId of ["om_first", "om_second"]) {
    const receipt = await host.deliver("cli_fixtureA", { message_id: messageId });
    assert.equal(receipt.status, "deferred");
    assert.match(receipt.deliveryId, /^hold_/);
    assert.match(receipt.reason, /canonical Inbox for explicit check\/poll/);
  }
});

test("driver proves the audited sole-Host boundary without managing launchd", () => {
  const source = fs.readFileSync(DRIVER, "utf8");
  assert.match(source, /com\.eddiearc\.larkin/);
  assert.match(source, /\/opt\/homebrew\/bin\/larkin/);
  assert.match(source, /\["print", `gui\/\$\{process\.getuid\(\)\}\/\$\{LAUNCHD_LABEL\}`\]/);
  assert.doesNotMatch(source, /\[\s*["'](?:bootout|bootstrap|kickstart|kill)["']/);
  assert.match(source, /isolatedAgentIds\.length !== 1/);
  assert.match(source, /HOLD_HOST_COMMAND_TOKEN = "app\/runtime-process\.mjs"/);
  assert.match(source, /currentProcessMetadata\(path\.basename\(fileURLToPath\(import\.meta\.url\)\)\)/);
  assert.match(source, /currentProcessMetadata\(HOLD_HOST_COMMAND_TOKEN\)/);
  assert.match(source, /path\.dirname\(readyFile\) !== targetRoot/);
  assert.match(source, /runtimeHost: createDeferredRuntimeHost\(\)/);
  assert.match(source, /execFileImpl: refuseAncillaryLarkCli/,
    "processing-eye reactions and other host-shell lark-cli calls must stay blocked");
});

test("history capability succeeds before any drain or external send in the write harness", () => {
  const source = fs.readFileSync(HARNESS, "utf8");
  const preflight = source.indexOf("\n  history();");
  const drain = source.indexOf("Runtime target pre-drain");
  const send = source.indexOf('"im", "+messages-send"');
  assert.ok(preflight >= 0, "history capability preflight must exist");
  assert.ok(preflight < drain, "history capability must precede target drain");
  assert.ok(preflight < send, "history capability must precede external send");
});
