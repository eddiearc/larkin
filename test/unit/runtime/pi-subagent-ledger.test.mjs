import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  emptyDispatchedSubagentLedger,
  effectivePiStateDir,
  extractBackgroundPiSubagentDispatch,
  getDispatchedSubagent,
  ledgerFilePath,
  ledgerStatusFromPiSubagentRecord,
  dispatchedSubagentRecordFile,
  noteDispatchedSubagent,
  noteDispatchedSubagentTerminal,
  noteDispatchedSubagentWakeAcknowledged,
  probePiSubagentRecord,
  readConsumedPiSubagentTerminal,
  readDispatchedSubagentLedger,
  reconcileDispatchedSubagents,
  sweepAbsentPiSubagentRecordFiles,
  taskIdsFromCompletionKey,
  undeliveredTerminalWakeKeys,
  writeDispatchedSubagentLedger,
  writeDispatchedSubagentRecordFile,
  PI_SUBAGENT_TERMINAL_NOTIFICATION_GRACE_MS,
} from "../../../dist/runtime/pi-subagent-ledger.mjs";

test("extractBackgroundPiSubagentDispatch reads Agent ID and output file from a background spawn", () => {
  const parsed = extractBackgroundPiSubagentDispatch({
    toolName: "Agent",
    args: { prompt: "do work", run_in_background: true },
    result: {
      content: [{
        type: "text",
        text: "Agent started in background.\nAgent ID: task-ledger-1\nType: general-purpose\nOutput file: /tmp/task-ledger-1.output\n",
      }],
      details: { agentId: "task-ledger-1", outputFile: "/tmp/task-ledger-1.output", status: "background" },
    },
  });
  assert.deepEqual(parsed, { taskId: "task-ledger-1", outputFile: "/tmp/task-ledger-1.output" });
});

test("extractBackgroundPiSubagentDispatch ignores foreground Agent calls", () => {
  assert.equal(extractBackgroundPiSubagentDispatch({
    toolName: "Agent",
    args: { prompt: "do work", run_in_background: false },
    result: { content: [{ type: "text", text: "Agent finished.\n" }] },
  }), null);
  assert.equal(extractBackgroundPiSubagentDispatch({
    toolName: "bash",
    args: { command: "echo hi" },
    result: { content: [{ type: "text", text: "hi" }] },
  }), null);
});

test("reconcile marks a missing Pi record orphaned once and keeps it queryable", () => {
  const now = 1_700_000_000_000;
  let ledger = noteDispatchedSubagent(emptyDispatchedSubagentLedger(), {
    taskId: "task-missing-1",
    outputFile: "/tmp/task-missing-1.output",
    now,
  });
  const first = reconcileDispatchedSubagents(ledger, {
    probe: () => "absent",
    now: now + 10,
    missingReason: "pi record missing",
  });
  assert.equal(first.orphaned.length, 1);
  assert.equal(first.orphaned[0].taskId, "task-missing-1");
  assert.equal(first.orphaned[0].status, "orphaned");
  assert.equal(first.orphaned[0].reason, "pi record missing");
  assert.equal(first.orphaned[0].outputFile, "/tmp/task-missing-1.output");
  assert.equal(first.orphaned[0].lastActivityAt, now);
  assert.equal(getDispatchedSubagent(first.ledger, "task-missing-1")?.status, "orphaned");

  const second = reconcileDispatchedSubagents(first.ledger, {
    probe: () => "absent",
    now: now + 20,
    missingReason: "pi record missing",
  });
  assert.deepEqual(second.orphaned, []);
  assert.equal(getDispatchedSubagent(second.ledger, "task-missing-1")?.status, "orphaned");
});

test("a canonical terminal notification is not marked orphaned", () => {
  const now = 1_700_000_100_000;
  let ledger = noteDispatchedSubagent(emptyDispatchedSubagentLedger(), {
    taskId: "task-done-1",
    outputFile: "/tmp/task-done-1.output",
    now,
  });
  ledger = noteDispatchedSubagentTerminal(ledger, {
    taskId: "task-done-1",
    status: "completed",
    wakeKey: "task-done-1",
    now: now + 5,
  });
  const result = reconcileDispatchedSubagents(ledger, {
    forceMissing: true,
    now: now + 10,
    missingReason: "pi record missing",
  });
  assert.deepEqual(result.orphaned, []);
  assert.equal(getDispatchedSubagent(result.ledger, "task-done-1")?.status, "completed");
});

test("late terminal notification after orphan does not change the queryable orphaned status", () => {
  const now = 1_700_000_200_000;
  let ledger = noteDispatchedSubagent(emptyDispatchedSubagentLedger(), { taskId: "task-late-1", now });
  const orphaned = reconcileDispatchedSubagents(ledger, { forceMissing: true, now: now + 1 });
  ledger = noteDispatchedSubagentTerminal(orphaned.ledger, {
    taskId: "task-late-1",
    status: "completed",
    now: now + 2,
  });
  assert.equal(getDispatchedSubagent(ledger, "task-late-1")?.status, "orphaned");
});

test("taskIdsFromCompletionKey splits the existing drain key", () => {
  assert.deepEqual(taskIdsFromCompletionKey("task-a|task-b"), ["task-a", "task-b"]);
  assert.deepEqual(taskIdsFromCompletionKey("task-only"), ["task-only"]);
});

test("ledger file persists orphaned state after the Pi record is gone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-subagent-ledger-"));
  try {
    const file = ledgerFilePath(root);
    let ledger = noteDispatchedSubagent(emptyDispatchedSubagentLedger(), {
      taskId: "task-persist-1",
      outputFile: "/tmp/task-persist-1.output",
      now: 10,
    });
    ledger = reconcileDispatchedSubagents(ledger, { forceMissing: true, now: 11 }).ledger;
    writeDispatchedSubagentLedger(file, ledger);
    const loaded = readDispatchedSubagentLedger(file);
    assert.equal(getDispatchedSubagent(loaded, "task-persist-1")?.status, "orphaned");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default probe uses the Pi record sidecar and ignores a leftover transcript", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-subagent-probe-"));
  try {
    const outputFile = path.join(root, "task-probe-1.output");
    const recordFile = writeDispatchedSubagentRecordFile(root, "task-probe-1");
    fs.writeFileSync(outputFile, "leftover transcript\n");
    assert.equal(probePiSubagentRecord({
      taskId: "task-probe-1", status: "dispatched", dispatchedAt: 1, lastActivityAt: 1, outputFile, recordFile,
    }), "present");
    fs.rmSync(recordFile);
    assert.equal(probePiSubagentRecord({
      taskId: "task-probe-1", status: "dispatched", dispatchedAt: 1, lastActivityAt: 1, outputFile, recordFile,
    }), "absent", "a leftover transcript must not count as a present Pi record");
    assert.ok(fs.existsSync(outputFile));
    assert.equal(probePiSubagentRecord({
      taskId: "task-probe-2", status: "dispatched", dispatchedAt: 1, lastActivityAt: 1, outputFile,
    }), "absent", "tasks without a record sidecar are not unconditionally present");
    assert.equal(probePiSubagentRecord({
      taskId: "task-probe-3", status: "dispatched", dispatchedAt: 1, lastActivityAt: 1,
    }), "absent");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile orphans when the Pi record sidecar is gone even if the transcript remains", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-subagent-leftover-"));
  try {
    const outputFile = path.join(root, "task-leftover-1.output");
    fs.writeFileSync(outputFile, "still here\n");
    const recordFile = writeDispatchedSubagentRecordFile(root, "task-leftover-1");
    let ledger = noteDispatchedSubagent(emptyDispatchedSubagentLedger(), {
      taskId: "task-leftover-1", outputFile, recordFile, now: 10,
    });
    fs.rmSync(recordFile);
    const result = reconcileDispatchedSubagents(ledger, {
      probe: probePiSubagentRecord,
      now: 11,
      missingReason: "pi record missing",
    });
    assert.equal(result.orphaned.length, 1);
    assert.equal(result.orphaned[0].taskId, "task-leftover-1");
    assert.equal(result.orphaned[0].status, "orphaned");
    assert.equal(result.orphaned[0].wakeState, "pending");
    assert.equal(result.orphaned[0].outputFile, outputFile);
    assert.ok(fs.existsSync(outputFile));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile persists transcript mtime into lastActivityAt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-subagent-mtime-"));
  try {
    const outputFile = path.join(root, "task-mtime-1.output");
    fs.writeFileSync(outputFile, "alive\n");
    const now = 1_000;
    let ledger = noteDispatchedSubagent(emptyDispatchedSubagentLedger(), {
      taskId: "task-mtime-1", outputFile, now,
    });
    const later = new Date(5_000);
    fs.utimesSync(outputFile, later, later);
    const result = reconcileDispatchedSubagents(ledger, {
      probe: () => "present",
      now: 10_000,
    });
    assert.deepEqual(result.orphaned, []);
    assert.equal(getDispatchedSubagent(result.ledger, "task-mtime-1")?.lastActivityAt, 5_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pending terminal wakes stay queryable until acknowledged", () => {
  const now = 1_700_000_300_000;
  let ledger = noteDispatchedSubagent(emptyDispatchedSubagentLedger(), { taskId: "task-wake-1", now });
  ledger = reconcileDispatchedSubagents(ledger, { forceMissing: true, now: now + 1 }).ledger;
  assert.deepEqual(undeliveredTerminalWakeKeys(ledger), ["task-wake-1"]);
  ledger = noteDispatchedSubagentWakeAcknowledged(ledger, { completionKey: "task-wake-1", now: now + 2 });
  assert.deepEqual(undeliveredTerminalWakeKeys(ledger), []);
  assert.equal(getDispatchedSubagent(ledger, "task-wake-1")?.wakeState, "acknowledged");
});

test("consumed completed result is bridged into the sidecar and is not orphaned", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-subagent-consumed-"));
  try {
    const consumedFile = writeDispatchedSubagentRecordFile(root, "task-consumed");
    const missingFile = writeDispatchedSubagentRecordFile(root, "task-missing");
    const recordDir = path.dirname(consumedFile);
    const live = new Map([
      ["task-consumed", { status: "completed", resultConsumed: true }],
    ]);
    let ledger = noteDispatchedSubagent(emptyDispatchedSubagentLedger(), {
      taskId: "task-consumed", recordFile: consumedFile, now: 10,
    });
    ledger = noteDispatchedSubagent(ledger, {
      taskId: "task-missing", recordFile: missingFile, now: 10,
    });

    const firstRemoved = sweepAbsentPiSubagentRecordFiles(recordDir, (taskId) => live.get(taskId));
    assert.deepEqual(firstRemoved, ["task-missing"]);
    assert.ok(fs.existsSync(consumedFile));
    assert.deepEqual(readConsumedPiSubagentTerminal(consumedFile), {
      taskId: "task-consumed",
      status: "completed",
    });
    assert.equal(probePiSubagentRecord({
      taskId: "task-consumed", status: "dispatched", dispatchedAt: 10, lastActivityAt: 10, recordFile: consumedFile,
    }), "consumed");

    live.delete("task-consumed");
    const secondRemoved = sweepAbsentPiSubagentRecordFiles(recordDir, (taskId) => live.get(taskId));
    assert.deepEqual(secondRemoved, [], "a consumed terminal sidecar must not be treated as absent after cleanup");
    assert.ok(fs.existsSync(consumedFile));

    const result = reconcileDispatchedSubagents(ledger, {
      probe: probePiSubagentRecord,
      now: 11,
    });
    assert.deepEqual(result.orphaned.map((task) => task.taskId), ["task-missing"]);
    assert.equal(getDispatchedSubagent(result.ledger, "task-consumed")?.status, "completed");
    assert.equal(getDispatchedSubagent(result.ledger, "task-consumed")?.wakeState, "acknowledged");
    assert.equal(fs.existsSync(consumedFile), false, "acknowledged consumed sidecar must be retired");
    assert.equal(getDispatchedSubagent(result.ledger, "task-missing")?.status, "orphaned");
    assert.deepEqual(undeliveredTerminalWakeKeys(result.ledger), ["task-missing"]);

    const again = reconcileDispatchedSubagents(result.ledger, {
      probe: probePiSubagentRecord,
      now: 12,
    });
    assert.deepEqual(again.orphaned, [], "a genuine missing record orphans only once");
    assert.equal(getDispatchedSubagent(again.ledger, "task-missing")?.status, "orphaned");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sweep persists an unconsumed terminal before eviction can delete the sidecar", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-subagent-evict-"));
  try {
    const recordFile = writeDispatchedSubagentRecordFile(root, "task-evict-1", "session-a");
    const recordDir = path.dirname(recordFile);
    const live = new Map([
      ["task-evict-1", { status: "completed" }],
    ]);
    let ledger = noteDispatchedSubagent(emptyDispatchedSubagentLedger(), {
      taskId: "task-evict-1", recordFile, now: 10,
    });

    const firstRemoved = sweepAbsentPiSubagentRecordFiles(recordDir, (taskId) => live.get(taskId));
    assert.deepEqual(firstRemoved, []);
    assert.ok(fs.existsSync(recordFile));
    const persisted = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    assert.equal(persisted.taskId, "task-evict-1");
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.owner, "session-a");
    assert.equal(persisted.resultConsumed, undefined);
    assert.equal(readConsumedPiSubagentTerminal(recordFile), null);
    assert.equal(probePiSubagentRecord({
      taskId: "task-evict-1", status: "dispatched", dispatchedAt: 10, lastActivityAt: 10, recordFile,
    }), "terminal");

    live.delete("task-evict-1");
    const secondRemoved = sweepAbsentPiSubagentRecordFiles(recordDir, (taskId) => live.get(taskId));
    assert.deepEqual(secondRemoved, [], "an evicted unconsumed terminal must keep its persisted sidecar");
    assert.ok(fs.existsSync(recordFile));
    assert.equal(probePiSubagentRecord({
      taskId: "task-evict-1", status: "dispatched", dispatchedAt: 10, lastActivityAt: 10, recordFile,
    }), "terminal");

    const duringGrace = reconcileDispatchedSubagents(ledger, {
      probe: probePiSubagentRecord,
      now: 11,
    });
    assert.deepEqual(duringGrace.orphaned, []);
    assert.deepEqual(duringGrace.terminals, []);
    assert.equal(getDispatchedSubagent(duringGrace.ledger, "task-evict-1")?.status, "dispatched");

    const persistedAt = 1_700_000_400_000;
    fs.utimesSync(recordFile, new Date(persistedAt), new Date(persistedAt));
    const afterGrace = reconcileDispatchedSubagents(duringGrace.ledger, {
      probe: probePiSubagentRecord,
      now: persistedAt + PI_SUBAGENT_TERMINAL_NOTIFICATION_GRACE_MS,
    });
    assert.deepEqual(afterGrace.orphaned, []);
    assert.equal(afterGrace.terminals.length, 1);
    assert.equal(afterGrace.terminals[0].taskId, "task-evict-1");
    assert.equal(afterGrace.terminals[0].status, "completed");
    assert.equal(afterGrace.terminals[0].wakeState, "pending");
    assert.equal(getDispatchedSubagent(afterGrace.ledger, "task-evict-1")?.status, "completed");
    assert.deepEqual(undeliveredTerminalWakeKeys(afterGrace.ledger), ["task-evict-1"]);
    assert.ok(fs.existsSync(recordFile), "unconsumed terminal sidecar stays until the wake is acknowledged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repeated sweeps do not reset the terminal notification grace clock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-subagent-grace-clock-"));
  try {
    const recordFile = writeDispatchedSubagentRecordFile(root, "task-grace-clock-1", "session-a");
    const recordDir = path.dirname(recordFile);
    const live = new Map([
      ["task-grace-clock-1", { status: "completed" }],
    ]);
    let ledger = noteDispatchedSubagent(emptyDispatchedSubagentLedger(), {
      taskId: "task-grace-clock-1", recordFile, now: 10,
    });

    assert.deepEqual(sweepAbsentPiSubagentRecordFiles(recordDir, (taskId) => live.get(taskId)), []);
    const persistedAt = fs.statSync(recordFile).mtimeMs;
    assert.ok(Number.isFinite(persistedAt));

    assert.deepEqual(sweepAbsentPiSubagentRecordFiles(recordDir, (taskId) => live.get(taskId)), []);
    assert.deepEqual(sweepAbsentPiSubagentRecordFiles(recordDir, (taskId) => live.get(taskId)), []);
    assert.equal(
      fs.statSync(recordFile).mtimeMs,
      persistedAt,
      "an unchanged terminal sidecar must keep the original grace-clock mtime",
    );

    const duringGrace = reconcileDispatchedSubagents(ledger, {
      probe: probePiSubagentRecord,
      now: persistedAt + PI_SUBAGENT_TERMINAL_NOTIFICATION_GRACE_MS - 1,
    });
    assert.deepEqual(duringGrace.orphaned, []);
    assert.deepEqual(duringGrace.terminals, []);
    assert.equal(getDispatchedSubagent(duringGrace.ledger, "task-grace-clock-1")?.status, "dispatched");

    const afterGrace = reconcileDispatchedSubagents(duringGrace.ledger, {
      probe: probePiSubagentRecord,
      now: persistedAt + PI_SUBAGENT_TERMINAL_NOTIFICATION_GRACE_MS,
    });
    assert.deepEqual(afterGrace.orphaned, []);
    assert.equal(afterGrace.terminals.length, 1);
    assert.equal(afterGrace.terminals[0].taskId, "task-grace-clock-1");
    assert.equal(afterGrace.terminals[0].status, "completed");
    assert.equal(afterGrace.terminals[0].wakeState, "pending");
    assert.deepEqual(undeliveredTerminalWakeKeys(afterGrace.ledger), ["task-grace-clock-1"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("force-missing immediately advances a persisted unconsumed terminal instead of orphaning it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-subagent-force-terminal-"));
  try {
    const recordFile = writeDispatchedSubagentRecordFile(root, "task-force-1", "session-a");
    sweepAbsentPiSubagentRecordFiles(path.dirname(recordFile), () => ({ status: "error" }));
    let ledger = noteDispatchedSubagent(emptyDispatchedSubagentLedger(), {
      taskId: "task-force-1", recordFile, now: 10,
    });
    const result = reconcileDispatchedSubagents(ledger, {
      probe: probePiSubagentRecord,
      forceMissing: true,
      now: 11,
      missingReason: "pi session gone",
    });
    assert.deepEqual(result.orphaned, []);
    assert.equal(result.terminals.length, 1);
    assert.equal(result.terminals[0].status, "failed");
    assert.equal(result.terminals[0].wakeState, "pending");
    assert.equal(getDispatchedSubagent(result.ledger, "task-force-1")?.status, "failed");
    assert.deepEqual(undeliveredTerminalWakeKeys(result.ledger), ["task-force-1"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sweep removes record sidecars only after the Pi record is gone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-subagent-sweep-"));
  try {
    const alive = writeDispatchedSubagentRecordFile(root, "task-alive");
    const gone = writeDispatchedSubagentRecordFile(root, "task-gone");
    const present = new Set(["task-alive"]);
    const removed = sweepAbsentPiSubagentRecordFiles(
      path.dirname(alive),
      (taskId) => present.has(taskId) ? { id: taskId } : undefined,
    );
    assert.deepEqual(removed, ["task-gone"]);
    assert.ok(fs.existsSync(alive));
    assert.equal(fs.existsSync(gone), false);
    assert.equal(dispatchedSubagentRecordFile(root, "task-alive"), alive);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sweep leaves another session's owner-tagged sidecar in place", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-subagent-owner-"));
  try {
    const mine = writeDispatchedSubagentRecordFile(root, "task-mine", "session-a");
    const theirs = writeDispatchedSubagentRecordFile(root, "task-theirs", "session-b");
    const untagged = writeDispatchedSubagentRecordFile(root, "task-untagged");
    const removed = sweepAbsentPiSubagentRecordFiles(
      path.dirname(mine),
      () => undefined,
      { owner: "session-a" },
    );
    assert.deepEqual(removed, ["task-mine"]);
    assert.equal(fs.existsSync(mine), false);
    assert.ok(fs.existsSync(theirs), "a staged session must not delete another session's sidecar");
    assert.ok(fs.existsSync(untagged), "untagged sidecars are not owned by the sweeping session");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ledger cap evicts acknowledged terminals before active or pending-wake records", () => {
  let ledger = emptyDispatchedSubagentLedger();
  for (let index = 0; index < 2048; index += 1) {
    const taskId = `task-ack-${index}`;
    ledger = noteDispatchedSubagentTerminal(ledger, { taskId, status: "completed", now: index + 1 });
    ledger = noteDispatchedSubagentWakeAcknowledged(ledger, { completionKey: taskId, now: index + 1 });
  }
  ledger = noteDispatchedSubagent(ledger, { taskId: "task-keep-dispatched", now: 3000 });
  ledger = noteDispatchedSubagentTerminal(ledger, {
    taskId: "task-keep-pending", status: "failed", wakeKey: "task-keep-pending", now: 3001,
  });
  assert.equal(getDispatchedSubagent(ledger, "task-keep-dispatched")?.status, "dispatched");
  assert.equal(getDispatchedSubagent(ledger, "task-keep-pending")?.wakeState, "pending");
  assert.equal(getDispatchedSubagent(ledger, "task-ack-0"), null);
  assert.equal(getDispatchedSubagent(ledger, "task-ack-1"), null);
  assert.ok(getDispatchedSubagent(ledger, "task-ack-2"));
  assert.equal(ledger.tasks.length, 2048);
});

test("consumed Pi record mapper treats aborted as timed_out and stopped as cancelled", () => {
  assert.equal(ledgerStatusFromPiSubagentRecord({ status: "aborted", resultConsumed: true }), "timed_out");
  assert.equal(ledgerStatusFromPiSubagentRecord({ status: "stopped", resultConsumed: true }), "cancelled");
  assert.equal(ledgerStatusFromPiSubagentRecord({ status: "error", resultConsumed: true }), "failed");
});

test("effectivePiStateDir matches the Pi adapter implicit root", () => {
  assert.equal(effectivePiStateDir({ workspaceDir: "/ws", stateDir: "/explicit" }), "/explicit");
  assert.equal(effectivePiStateDir({ workspaceDir: "/ws" }), path.join("/ws", ".larkin"));
});
