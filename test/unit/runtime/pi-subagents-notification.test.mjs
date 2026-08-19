import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  buildCanonicalPiSubagentAssistantMessage,
  buildCanonicalPiSubagentNotificationContent,
  extractCanonicalPiSubagentCompletionKeyFromMessages,
  extractCanonicalPiSubagentNotification,
} from "../../../dist/runtime/pi-subagents-notification.mjs";

function mixedContent(blocks) {
  return {
    role: "assistant",
    content: [{
      type: "custom",
      customType: "subagent-notification",
      content: blocks.join("\n"),
    }],
  };
}

test("failed and aborted canonical notifications still produce a completion key", () => {
  const cases = [
    {
      taskId: "task-error-1",
      status: "Error: provider failed",
      summary: "Agent \"fixture\" error",
      result: "partial error output",
    },
    {
      taskId: "task-aborted-1",
      status: "Aborted (max turns exceeded)",
      summary: "Agent \"fixture\" aborted (aborted — hit the turn limit before completion; output may be incomplete)",
      result: "partial aborted output",
    },
    {
      taskId: "task-stopped-1",
      status: "Stopped",
      summary: "Agent \"fixture\" stopped (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)",
      result: "partial stopped output",
    },
    {
      taskId: "task-steered-1",
      status: "Wrapped up (turn limit)",
      summary: "Agent \"fixture\" steered (wrapped up at the turn limit — output may be partial)",
      result: "partial steered output",
    },
    {
      taskId: "task-raw-error",
      status: "error",
      summary: "Agent \"fixture\" error",
      result: "raw error",
    },
    {
      taskId: "task-raw-turn-limit",
      status: "turn-limit",
      summary: "Agent \"fixture\" steered",
      result: "raw turn limit",
    },
  ];
  for (const options of cases) {
    const key = extractCanonicalPiSubagentCompletionKeyFromMessages([
      buildCanonicalPiSubagentAssistantMessage(options),
    ]);
    assert.equal(key, options.taskId, `terminal status ${options.status} must produce a completion key`);
  }
});

test("mixed-status groups keep terminal successes instead of dropping the whole group", () => {
  const parsed = extractCanonicalPiSubagentNotification([mixedContent([
    buildCanonicalPiSubagentNotificationContent({
      taskId: "task-running",
      status: "running",
      summary: "Agent \"still going\" running",
      result: "not done",
    }),
    buildCanonicalPiSubagentNotificationContent({
      taskId: "task-done",
      status: "Done",
      summary: "Agent \"ok\" completed",
      result: "success",
    }),
    buildCanonicalPiSubagentNotificationContent({
      taskId: "task-error",
      status: "Error: boom",
      summary: "Agent \"fail\" error",
      result: "failed",
    }),
    "<task-notification><task-id>task-malformed</task-id><status>Done</status></task-notification>",
  ])]);
  assert.ok(parsed);
  assert.deepEqual(parsed.taskIds, ["task-done", "task-error"]);
  assert.equal(parsed.key, "task-done|task-error");
  assert.equal(parsed.notifications[0].status, "Done");
  assert.match(parsed.notifications[1].status, /^Error:/);
});

test("only customType subagent-notification content is parsed", () => {
  const xml = buildCanonicalPiSubagentNotificationContent({
    taskId: "task-other-type",
    status: "Done",
    summary: "Agent \"fixture\" completed",
    result: "should not parse",
  });
  assert.equal(extractCanonicalPiSubagentCompletionKeyFromMessages([{
    role: "assistant",
    content: [{ type: "custom", customType: "other-notification", content: xml }],
  }]), null);
  assert.equal(extractCanonicalPiSubagentCompletionKeyFromMessages([{
    role: "assistant",
    content: xml,
  }]), null);
  assert.equal(extractCanonicalPiSubagentCompletionKeyFromMessages([
    buildCanonicalPiSubagentAssistantMessage({ taskId: "task-official" }),
  ]), "task-official");
});

test("queued or running notifications do not produce a completion key", () => {
  const key = extractCanonicalPiSubagentCompletionKeyFromMessages([
    buildCanonicalPiSubagentAssistantMessage({
      taskId: "task-running",
      status: "running",
      summary: "Agent \"fixture\" running",
      result: "not terminal",
    }),
  ]);
  assert.equal(key, null);
});
