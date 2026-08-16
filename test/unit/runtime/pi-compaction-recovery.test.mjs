import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  COMPACTION_KEEP_RECENT_TOKENS,
  COMPACTION_RESERVE_TOKENS,
  PI_CONTEXT_WINDOW,
  PI_COMPACTION_THRESHOLD,
  assertEffectivePiCompactionSettings,
  ensureOwnedPiAgentDirectory,
  prepareOwnedPiDirectory,
  mergeOwnedPiSettings,
  hasProjectPiCompactionOverride,
  isPiNativeCompactionRequired,
  PiCompactionBreaker,
  PiCompactionRecoveryMachine,
  parsePiExecutableVersion,
  verifyPiCapabilities,
} from "../../../dist/runtime/pi-compaction-recovery.mjs";

test("Pi policy uses the exact effective settings and strict threshold boundary", () => {
  assert.equal(PI_CONTEXT_WINDOW, 272_000);
  assert.equal(COMPACTION_RESERVE_TOKENS, 40_800);
  assert.equal(COMPACTION_KEEP_RECENT_TOKENS, 20_000);
  assert.equal(PI_COMPACTION_THRESHOLD, 231_200);
  assert.equal(isPiNativeCompactionRequired(231_200), false);
  assert.equal(isPiNativeCompactionRequired(231_201), true);
  assert.doesNotThrow(() => assertEffectivePiCompactionSettings({
    contextWindow: 272_000, compaction: { enabled: true, reserveTokens: 40_800, keepRecentTokens: 20_000 },
  }));
  assert.throws(() => assertEffectivePiCompactionSettings({
    contextWindow: 272_000, compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  }), /reserveTokens/i);
});

test("Pi owned settings merge preserves unrelated external settings while owning compaction", () => {
  const merged = mergeOwnedPiSettings({ theme: "dark", packages: { enabled: true }, compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 2 } });
  assert.equal(merged.theme, "dark");
  assert.deepEqual(merged.packages, { enabled: true });
  assert.deepEqual(merged.compaction, { enabled: true, reserveTokens: 40_800, keepRecentTokens: 20_000 });
});

test("project compaction/context overrides are refused before Pi starts", () => {
  assert.equal(hasProjectPiCompactionOverride({}), false);
  assert.equal(hasProjectPiCompactionOverride({ compaction: { enabled: false } }), true);
  assert.equal(hasProjectPiCompactionOverride({ contextWindow: 128_000 }), true);
});

test("owned Pi directory is 0700, current-user owned, and never a symlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-owned-"));
  const directory = ensureOwnedPiAgentDirectory(root, "cli_ownedA1");
  const stat = fs.lstatSync(directory);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o700);
  assert.equal(path.basename(directory), "cli_ownedA1");
  assert.throws(() => ensureOwnedPiAgentDirectory(root, "../escape"), /invalid|unsafe/i);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-outside-"));
  const linked = path.join(root, "linked-parent");
  fs.symlinkSync(outside, linked);
  assert.throws(() => prepareOwnedPiDirectory(path.join(linked, "agent")), /unsafe|symlink/i);
  const linkedRoot = path.join(root, "linked-root"); fs.symlinkSync(outside, linkedRoot);
  assert.throws(() => ensureOwnedPiAgentDirectory(linkedRoot, "cli_linkedA1"), /unsafe|symlink/i);
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("Pi executable version parsing rejects spoofed suffixes and extra tokens", () => {
  assert.equal(parsePiExecutableVersion("0.84.2\n"), "0.84.2");
  assert.equal(parsePiExecutableVersion("pi-coding-agent version v0.84.2\n"), "0.84.2");
  for (const output of ["0.84.2-beta", "0.84.2 dirty", "0.84.2 extra", "pi 0.84.2 extra", "0.84.2\nattacker", "v0.84.2", "0x84x2", "0-84-2"]) {
    assert.throws(() => parsePiExecutableVersion(output), /exactly|version/i);
  }
});

test("external capability guard fails closed and accepts only the required Pi protocol", () => {
  assert.doesNotThrow(() => verifyPiCapabilities({
    distribution: "external", version: "0.84.2", contextWindow: 272_000, autoCompactionEnabled: true,
    reserveTokens: 40_800, keepRecentTokens: 20_000, compactRpc: true,
    events: ["compaction_start", "compaction_end", "agent_end", "agent_settled"],
  }));
  assert.throws(() => verifyPiCapabilities({
    distribution: "external", version: "0.82.0", contextWindow: 272_000, autoCompactionEnabled: true,
    reserveTokens: 40_800, keepRecentTokens: 20_000, compactRpc: true,
    events: ["compaction_start", "compaction_end", "agent_end", "agent_settled"],
  }), /version|capabilit/i);
  assert.throws(() => verifyPiCapabilities({
    distribution: "external", version: "0.84.2", contextWindow: 128_000, autoCompactionEnabled: true,
    reserveTokens: 40_800, keepRecentTokens: 20_000, compactRpc: true,
    events: ["compaction_start", "compaction_end", "agent_end", "agent_settled"],
  }), /context/i);
  assert.throws(() => verifyPiCapabilities({
    distribution: "external", version: "0.84.2", contextWindow: 272_000, autoCompactionEnabled: true,
    compactRpc: true,
  }), /unproven|reserve|event/i);
  assert.throws(() => verifyPiCapabilities({
    distribution: "external", version: "0.84.2", contextWindow: 272_000,
    reserveTokens: 40_800, keepRecentTokens: 20_000, compactRpc: true,
    events: ["compaction_start", "compaction_end", "agent_end", "agent_settled"],
  }), /boolean/i);
  assert.throws(() => verifyPiCapabilities({
    distribution: "external", version: "0.84.2", contextWindow: 272_000, autoCompactionEnabled: true,
    compactRpc: true, trustedProtocol: true,
  }), /external|trusted|unproven/i);
  assert.doesNotThrow(() => verifyPiCapabilities({
    distribution: "builtin", version: "0.84.2", contextWindow: 272_000, autoCompactionEnabled: true,
    compactRpc: true, trustedProtocol: true,
  }));
});

test("breaker refuses operations without an explicit canonical lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-breaker-no-lock-"));
  const breaker = new PiCompactionBreaker(root);
  assert.throws(() => breaker.get("missing"), /canonical Agent state lock/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test("durable breaker writes atomically and reloads ambiguous attempts without resending", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-breaker-"));
  const breaker = new PiCompactionBreaker(root, { now: () => "2026-01-01T00:00:00.000Z", withLock: (operation) => operation() });
  const key = "delivery-1:input-1";
  breaker.transition(key, {
    messageId: "message-1", deliveryId: "delivery-1", inputId: "input-1", sessionGeneration: 3,
  }, "eligible");
  breaker.transition(key, {}, "settled_for_manual");
  breaker.transition(key, { compactDeadlineAt: "2026-01-01T00:00:01.000Z" }, "manual_sent");
  const loaded = new PiCompactionBreaker(root, { now: () => "2026-01-01T00:00:02.000Z", withLock: (operation) => operation() });
  assert.equal(loaded.get(key).state, "manual_sent");
  assert.equal(loaded.get(key).manualAttempt, 1);
  assert.throws(() => loaded.transition(key, {}, "manual_sent"), /invalid|duplicate|attempt/i);
  assert.equal(fs.lstatSync(path.join(root, "piCompactionRecovery.json")).mode & 0o777, 0o600);
  fs.rmSync(root, { recursive: true, force: true });
});

test("stale breaker instances serialize one manual action through the shared canonical lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-breaker-race-"));
  let locked = false;
  const withLock = (operation) => {
    assert.equal(locked, false);
    locked = true;
    try { return operation(); } finally { locked = false; }
  };
  const first = new PiCompactionBreaker(root, { withLock });
  const second = new PiCompactionBreaker(root, { withLock });
  const key = "delivery-race:input-race";
  first.transition(key, { messageId: "message-race", deliveryId: "delivery-race", inputId: "input-race", sessionGeneration: 1 }, "eligible");
  first.transition(key, {}, "settled_for_manual");
  second.transition(key, { compactDeadlineAt: "2026-01-01T00:00:01.000Z" }, "manual_sent");
  assert.throws(() => first.transition(key, { compactDeadlineAt: "2026-01-01T00:00:01.000Z" }, "manual_sent"), /invalid|duplicate|attempt|terminal/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test("event machine distinguishes Pi-owned retry, native failure, manual success, late events, and second overflow", () => {
  const actions = [];
  const machine = new PiCompactionRecoveryMachine({
    breaker: { save() {}, get() { return undefined; } },
    key: "delivery-1:input-1", messageId: "message-1", deliveryId: "delivery-1", inputId: "input-1", sessionGeneration: 1,
    onAction: (action) => actions.push(action),
  });
  machine.agentEnd({ exactOverflow: true, willRetry: true });
  assert.equal(machine.state, "native_retry_owned");
  machine.compactionEnd({ reason: "overflow", success: true, willRetry: true });
  machine.agentSettled();
  assert.equal(machine.state, "native_succeeded");
  assert.equal(actions.filter((action) => action === "manual_compact").length, 0);

  const manualActions = [];
  const manual = new PiCompactionRecoveryMachine({
    breaker: { save() {}, get() { return undefined; } },
    key: "delivery-2:input-2", messageId: "message-2", deliveryId: "delivery-2", inputId: "input-2", sessionGeneration: 1,
    onAction: (action) => manualActions.push(action),
  });
  manual.agentEnd({ exactOverflow: true, willRetry: false });
  manual.agentSettled();
  assert.equal(manual.state, "settled_for_manual");
  manual.manualCompactSent("2026-01-01T00:01:00.000Z");
  manual.compactionEnd({ reason: "manual", success: true, willRetry: false });
  manual.compactResponse({ success: true });
  assert.equal(manual.state, "manual_succeeded");
  manual.retrySubmitted();
  assert.equal(manual.state, "retrying");
  manual.agentEnd({ exactOverflow: true, willRetry: false });
  assert.equal(manual.state, "second_overflow");
  assert.equal(manualActions.filter((action) => action === "manual_compact").length, 1);
  assert.equal(manualActions.filter((action) => action === "retry_input").length, 1);
  manual.compactionEnd({ reason: "manual", success: true, willRetry: false });
  assert.equal(manual.state, "second_overflow", "late lifecycle events cannot resurrect a second-overflow fallback");
});
