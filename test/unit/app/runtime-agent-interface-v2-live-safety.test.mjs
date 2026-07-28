import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { onTestFinished, test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  acquireGlobalLaunchLock,
  createDeferredRuntimeHost,
  finalizeHoldHostResources,
  materializeBotOnlyProfile,
} from "../../live/runtime-agent-interface-v2-hold-host.mjs";
import {
  HOLD_DRIVER_BASENAME,
  HOLD_HOST_COMMAND_TOKEN,
  HOLD_READY_MAX_AGE_MS,
  HOLD_TEMP_ROOT_PREFIX,
  claimHoldHostRoot,
  cleanupClaimedHoldHostRoot,
  readyProofFor,
  redactedProcessFailureDiagnostic,
  redactedProcessOutputShape,
  runProviderWithLiveHoldReady,
  validateLiveHoldHostReady,
  writePrivateJson,
} from "../../support/runtime-agent-interface-v2-live-hold-safety.mjs";
import { inspectProcess } from "../../../dist/platform/process-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DRIVER = path.join(ROOT, "test", "live", "runtime-agent-interface-v2-hold-host.mjs");
const HARNESS = path.join(ROOT, "test", "live", "runtime-agent-interface-v2-live.test.mjs");

function freshHoldRoot(prefix = HOLD_TEMP_ROOT_PREFIX) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

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

test("provider JSON parse diagnostics expose only bounded output shape", () => {
  const sensitiveId = "om_fixtureSensitiveMessageId";
  const sensitiveText = "fixture-sensitive-content";
  const result = redactedProcessOutputShape({
    stdout: `${sensitiveId} ${sensitiveText}\n${"x".repeat(5000)}`,
    stderr: Array.from({ length: 30 }, (_, index) => `private-${index}`).join("\n"),
  });
  assert.deepEqual(result, {
    stdout: {
      present: true,
      byteLength: 4096,
      byteLengthCapped: true,
      lineCount: 2,
      lineCountCapped: false,
    },
    stderr: {
      present: true,
      byteLength: 319,
      byteLengthCapped: false,
      lineCount: 20,
      lineCountCapped: true,
    },
  });
  const diagnostic = JSON.stringify(result);
  assert.doesNotMatch(diagnostic, new RegExp(sensitiveId));
  assert.doesNotMatch(diagnostic, new RegExp(sensitiveText));
});

test("nonzero provider diagnostics expose only validated error categories, scopes, and identity", () => {
  const sensitiveId = "om_fixtureSensitiveMessageId";
  const sensitiveOpenId = "ou_fixtureSensitiveUserId";
  const sensitiveText = "fixture-sensitive-message-content";
  const result = redactedProcessFailureDiagnostic({
    stdout: JSON.stringify({
      ok: false,
      identity: "user",
      request_id: sensitiveId,
      args: ["--text", sensitiveText, "--open-id", sensitiveOpenId],
      content: sensitiveText,
      error: {
        type: "api_error",
        subtype: "app_scope_not_applied",
        code: 99991672,
        message: `${sensitiveText}: ${sensitiveId}`,
        hint: `contact ${sensitiveOpenId}`,
        log_id: sensitiveId,
        missing_scopes: [
          "im:message",
          "im:message.send_as_user",
          "im:chat.members:write_only",
          sensitiveId,
          "../private",
          `im:${sensitiveText}`,
          123,
        ],
      },
    }),
    stderr: JSON.stringify({
      identity: sensitiveOpenId,
      error: { type: sensitiveId, subtype: sensitiveText, code: sensitiveId },
      message: sensitiveText,
    }),
  });
  assert.deepEqual(result, {
    error: { type: "api_error", subtype: "app_scope_not_applied" },
    missing_scopes: ["im:message", "im:message.send_as_user"],
    identity: "user",
  });
  const diagnostic = JSON.stringify(result);
  for (const sensitive of [sensitiveId, sensitiveOpenId, sensitiveText]) {
    assert.equal(diagnostic.includes(sensitive), false, `diagnostic must redact ${sensitive}`);
  }
  for (const forbiddenKey of ["args", "content", "message", "hint", "log_id", "request_id"]) {
    assert.equal(Object.hasOwn(result, forbiddenKey), false, `diagnostic must omit ${forbiddenKey}`);
    assert.equal(Object.hasOwn(result.error, forbiddenKey), false, `diagnostic error must omit ${forbiddenKey}`);
  }
});

test("pure-alphanumeric and in-range numeric secrets cannot masquerade as failure diagnostics", () => {
  const syntheticSecret = "syntheticsecret987654321";
  const processResult = {
    stdout: JSON.stringify({
      identity: syntheticSecret,
      error: {
        type: syntheticSecret,
        subtype: syntheticSecret,
        code: 123456789,
        missing_scopes: [`im:${syntheticSecret}`],
      },
    }),
    stderr: "",
  };
  const result = redactedProcessFailureDiagnostic(processResult);
  assert.deepEqual(result, { outputShape: redactedProcessOutputShape(processResult) });
  assert.equal(JSON.stringify(result).includes(syntheticSecret), false);
});

test("non-JSON provider failures retain only bounded output shape", () => {
  const sensitiveId = "om_fixtureOpaqueFailureId";
  const sensitiveText = "fixture-opaque-sensitive-content";
  const result = redactedProcessFailureDiagnostic({
    stdout: `${sensitiveId} ${sensitiveText}\n${"x".repeat(5000)}`,
    stderr: `${sensitiveText}\n${sensitiveId}`,
  });
  assert.deepEqual(result, {
    outputShape: {
      stdout: { present: true, byteLength: 4096, byteLengthCapped: true, lineCount: 2, lineCountCapped: false },
      stderr: { present: true, byteLength: 58, byteLengthCapped: false, lineCount: 2, lineCountCapped: false },
    },
  });
  const diagnostic = JSON.stringify(result);
  assert.equal(diagnostic.includes(sensitiveId), false);
  assert.equal(diagnostic.includes(sensitiveText), false);
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

test("hold root claim rejects unsafe path/mode and cleanup requires the sentinel before removing credentials", () => {
  const wrongName = freshHoldRoot("larkin-wrong-live-root-");
  assert.throws(() => claimHoldHostRoot(wrongName), /system-temp child/);
  fs.rmdirSync(wrongName);

  const wrongMode = freshHoldRoot();
  fs.chmodSync(wrongMode, 0o755);
  assert.throws(() => claimHoldHostRoot(wrongMode), /owned 0700/);
  fs.chmodSync(wrongMode, 0o700);
  fs.rmdirSync(wrongMode);

  const target = freshHoldRoot();
  const claim = claimHoldHostRoot(target, { nonce: "fixture-root-nonce", ownerPid: process.pid });
  const privateDir = path.join(claim.targetRoot, "bots");
  fs.mkdirSync(privateDir, { mode: 0o700 });
  fs.writeFileSync(path.join(privateDir, "credential.json"), "fixture", { mode: 0o600 });
  fs.chmodSync(claim.sentinelFile, 0o644);
  assert.throws(() => cleanupClaimedHoldHostRoot(claim), /0600/);
  assert.equal(fs.existsSync(claim.targetRoot), true, "failed ownership proof must preserve the root");
  fs.chmodSync(claim.sentinelFile, 0o600);
  cleanupClaimedHoldHostRoot(claim);
  assert.equal(fs.existsSync(target), false, "validated cleanup must remove the whole credential-bearing root");
});

test("source launch lock rejects a competing hold-host owner", () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-live-source-lock-"));
  fs.chmodSync(sourceRoot, 0o700);
  const commandToken = path.basename(process.execPath);
  const first = acquireGlobalLaunchLock(sourceRoot, commandToken);
  try {
    assert.throws(() => acquireGlobalLaunchLock(sourceRoot, commandToken), /lock.*(?:占用|occupied)/i);
  } finally {
    first.release();
    fs.rmdirSync(sourceRoot);
  }
});

test("abnormal finalization cleans the claimed credential root and releases the global lock before failing", async () => {
  const target = freshHoldRoot();
  const claim = claimHoldHostRoot(target);
  fs.mkdirSync(path.join(claim.targetRoot, "bots"), { mode: 0o700 });
  fs.writeFileSync(path.join(claim.targetRoot, "bots", "credential.json"), "fixture", { mode: 0o600 });
  const order = [];
  const host = { async shutdown() { order.push("shutdown"); throw new Error("fixture shutdown failure"); } };
  const launchLock = { release() { order.push("release"); } };
  await assert.rejects(
    finalizeHoldHostResources({ host, claim, launchLock, failure: new Error("fixture primary failure") }),
    /fixture primary failure.*Host shutdown failed/,
  );
  assert.deepEqual(order, ["shutdown", "release"]);
  assert.equal(fs.existsSync(target), false, "abnormal finalization must still remove the credential-bearing root");
});

test("direct Bot-only profile materialization keeps the secret local and never creates a keychain reference", () => {
  const target = freshHoldRoot();
  const claim = claimHoldHostRoot(target);
  const stateDir = path.join(claim.targetRoot, "state", "agents", "cli_fixtureA");
  const larkConfigDir = path.join(stateDir, "lark-cli-config");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    materializeBotOnlyProfile({
      stateDir,
      larkConfigDir,
      feishuAppId: "cli_fixtureA",
      feishuAppSecret: "fixture-secret",
      feishuDomain: "https://open.feishu.cn",
    });
    const profile = JSON.parse(fs.readFileSync(path.join(larkConfigDir, "config.json"), "utf8"));
    assert.deepEqual(profile.apps, [{
      appId: "cli_fixtureA", name: "cli_fixtureA", appSecret: "fixture-secret", brand: "feishu",
      defaultAs: "bot", strictMode: "bot", users: [],
    }]);
    assert.equal(typeof profile.apps[0].appSecret, "string");
    assert.equal(fs.existsSync(path.join(stateDir, "runtime-bin", "lark-cli")), true);
  } finally {
    cleanupClaimedHoldHostRoot(claim);
  }
});

test("ready proof binds a fresh channel to the live exact process, root inode, config, and daemon status", async () => {
  const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)", HOLD_DRIVER_BASENAME, HOLD_HOST_COMMAND_TOKEN], {
    stdio: "ignore",
  });
  onTestFinished(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const inspected = inspectProcess(child.pid);
  assert.equal(inspected.ok, true, inspected.reason);
  const target = freshHoldRoot();
  const claim = claimHoldHostRoot(target, { nonce: "ready-fixture-nonce", ownerPid: child.pid });
  const agentId = "cli_fixtureA";
  const connectedAt = new Date().toISOString();
  try {
    writePrivateJson(path.join(claim.targetRoot, "config.json"), {
      version: 4, serverId: "fixture", mentionPolicy: "require", activeAgent: agentId,
      agents: { [agentId]: { runtime: "codex", model: "fixture" } },
    });
    writePrivateJson(path.join(claim.targetRoot, "daemon-status.json"), {
      pid: child.pid, processStartToken: inspected.startToken, commandToken: HOLD_HOST_COMMAND_TOKEN, agents: [agentId],
    });
    writeJson(path.join(claim.targetRoot, "state", "agents", agentId, "status.json"), {
      connectedVia: "channel", connectedAt, reconnectingAt: null,
    });
    const identity = { pid: child.pid, processStartToken: inspected.startToken, commandToken: HOLD_HOST_COMMAND_TOKEN };
    writePrivateJson(claim.readyFile, readyProofFor(claim, { agentId, identity, connectedAt }));
    const validated = validateLiveHoldHostReady(claim.targetRoot, agentId);
    assert.equal(validated.inspected.startToken, inspected.startToken);
    assert.throws(() => validateLiveHoldHostReady(claim.targetRoot, agentId, {
      nowMs: Date.parse(connectedAt) + HOLD_READY_MAX_AGE_MS + 1,
    }), /stale/);
    fs.chmodSync(claim.readyFile, 0o644);
    assert.throws(() => validateLiveHoldHostReady(claim.targetRoot, agentId), /0600/);
    fs.chmodSync(claim.readyFile, 0o600);

    writeJson(path.join(claim.targetRoot, "state", "agents", agentId, "status.json"), {
      connectedVia: "channel",
      connectedAt,
      reconnectingAt: null,
      recentErrors: [
        { at: connectedAt, text: "larkApi POST reactions: hold-host blocked" },
        { at: connectedAt, text: "channel ws 连接错误" },
      ],
    });
    assert.throws(() => validateLiveHoldHostReady(claim.targetRoot, agentId), /websocket error/);
    writeJson(path.join(claim.targetRoot, "state", "agents", agentId, "status.json"), {
      connectedVia: "channel", connectedAt, reconnectingAt: null,
      recentErrors: [{ at: connectedAt, text: "larkApi POST reactions: hold-host blocked" }],
    });
    assert.doesNotThrow(() => validateLiveHoldHostReady(claim.targetRoot, agentId),
      "expected blocked processing-eye errors must not look like a channel failure");

    const wrong = JSON.parse(fs.readFileSync(claim.readyFile, "utf8"));
    wrong.processStartToken = "wrong-start-token";
    fs.writeFileSync(claim.readyFile, `${JSON.stringify(wrong)}\n`);
    assert.throws(() => validateLiveHoldHostReady(claim.targetRoot, agentId), /process identity/);
    fs.writeFileSync(claim.readyFile, `${JSON.stringify(readyProofFor(claim, { agentId, identity, connectedAt }))}\n`);

    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    let providerCalls = 0;
    for (const stage of ["controlled user send", "stale Runtime Bot send", "current Runtime Bot send"]) {
      assert.throws(() => runProviderWithLiveHoldReady(
        claim.targetRoot,
        agentId,
        () => { providerCalls += 1; },
        { stage },
      ), new RegExp(`${stage} blocked.*process identity`));
      assert.equal(providerCalls, 0, `${stage}: dead proof must block the provider runner`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    cleanupClaimedHoldHostRoot(claim);
  }
});

test("driver proves the audited sole-Host boundary without managing launchd", () => {
  const source = fs.readFileSync(DRIVER, "utf8");
  assert.match(source, /com\.eddiearc\.larkin/);
  assert.match(source, /\/opt\/homebrew\/bin\/larkin/);
  assert.match(source, /spawnSync\(LAUNCHCTL, \["print"/);
  assert.doesNotMatch(source, /\[\s*["'](?:bootout|bootstrap|kickstart|kill)["']/);
  assert.match(source, /isolatedAgentIds\.length !== 1/);
  assert.match(source, /currentProcessMetadata\(HOLD_DRIVER_BASENAME\)/);
  assert.match(source, /currentProcessMetadata\(HOLD_HOST_COMMAND_TOKEN\)/);
  assert.match(source, /acquireGlobalLaunchLock\(sourceRoot\)/);
  assert.match(source, /cleanupClaimedHoldHostRoot\(claim\)/);
  assert.match(source, /runtimeHost: createDeferredRuntimeHost\(\)/);
  assert.match(source, /execFileImpl: refuseAncillaryLarkCli/,
    "processing-eye reactions and other host-shell lark-cli calls must stay blocked");
  assert.doesNotMatch(source, /syncAgentProfile|\[\s*"config"\s*,\s*"init"|keychain-downgrade/i,
    "live driver must not execute lark-cli configuration or keychain commands");
  assert.match(source, /writes the supported plaintext Bot-only profile/);
  for (const absolute of ["/usr/bin/plutil", "/bin/launchctl", "/bin/ps"]) assert.match(source, new RegExp(absolute));
});

test("history capability succeeds before any drain or external send in the write harness", () => {
  const source = fs.readFileSync(HARNESS, "utf8");
  const preflight = source.indexOf("\n  history();");
  const ready = source.indexOf("validateLiveHoldHostReady(configDir, agentId)");
  const drain = source.indexOf("Runtime target pre-drain");
  const send = source.indexOf("messageSendArgs(", source.indexOf("messageSendArgs(") + 1);
  assert.ok(preflight >= 0, "history capability preflight must exist");
  assert.ok(ready > preflight, "live process/root/channel proof must follow external read capability");
  assert.ok(ready < drain, "live process/root/channel proof must precede target drain");
  assert.ok(preflight < drain, "history capability must precede target drain");
  assert.ok(preflight < send, "history capability must precede external send");
  for (const stage of ["controlled user send", "stale Runtime Bot send", "current Runtime Bot send"]) {
    assert.match(source, new RegExp(`provider\\("${stage}"`), `${stage} must revalidate immediately around its provider call`);
  }
  assert.match(source, /function messageSendArgs\(\.\.\.args\) \{\s*return \["im", "\+messages-send", \.\.\.args, "--json"\];/,
    "every provider message send must request the native CLI JSON output contract");
  assert.equal(source.match(/messageSendArgs\(/g)?.length, 4,
    "the shared JSON-send builder must serve exactly the three provider sends");
  assert.equal(source.match(/"\+messages-send"/g)?.length, 1,
    "provider sends must not bypass the shared JSON-send builder");
  assert.match(source, /redacted output shape=.*redactedProcessOutputShape\(completed\)/,
    "JSON parse failures must report only bounded redacted process-output shape");
  assert.match(source, /redacted failure=.*redactedProcessFailureDiagnostic\(result\)/,
    "nonzero provider failures must use the strict JSON allowlist or bounded output shape");
});
