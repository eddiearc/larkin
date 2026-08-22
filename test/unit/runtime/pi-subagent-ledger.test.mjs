import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  emptyDispatchedSubagentLedger,
  extractBackgroundPiSubagentDispatch,
  getDispatchedSubagent,
  ledgerFilePath,
  noteDispatchedSubagent,
  noteDispatchedSubagentTerminal,
  probePiSubagentOutputRecord,
  readDispatchedSubagentLedger,
  reconcileDispatchedSubagents,
  taskIdsFromCompletionKey,
  writeDispatchedSubagentLedger,
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

test("default output-file probe reports absent only when the known file is gone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-subagent-probe-"));
  try {
    const outputFile = path.join(root, "task-probe-1.output");
    fs.writeFileSync(outputFile, "alive\n");
    assert.equal(probePiSubagentOutputRecord({
      taskId: "task-probe-1", status: "dispatched", dispatchedAt: 1, lastActivityAt: 1, outputFile,
    }), "present");
    fs.rmSync(outputFile);
    assert.equal(probePiSubagentOutputRecord({
      taskId: "task-probe-1", status: "dispatched", dispatchedAt: 1, lastActivityAt: 1, outputFile,
    }), "absent");
    assert.equal(probePiSubagentOutputRecord({
      taskId: "task-probe-2", status: "dispatched", dispatchedAt: 1, lastActivityAt: 1,
    }), "present");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
