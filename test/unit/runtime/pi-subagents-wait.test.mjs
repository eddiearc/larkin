import assert from "node:assert/strict";
import { test } from "bun:test";
import { waitForSubagentResult } from "../../../dist/runtime/pi-subagents.bundle.js";

function deferred() {
  let resolve;
  const promise = new Promise((value) => { resolve = value; });
  return { promise, resolve };
}

test("subagent result wait times out without cancelling a running child", async () => {
  const child = deferred();
  const record = { status: "running", promise: child.promise };
  const timedOut = await waitForSubagentResult(record, 25);

  assert.equal(timedOut, true);
  child.resolve("completed later");
  assert.equal(await child.promise, "completed later");
});

test("subagent result wait returns completion before its deadline", async () => {
  const record = {
    status: "running",
    promise: new Promise((resolve) => setTimeout(() => resolve("completed"), 10)),
  };

  const timedOut = await waitForSubagentResult(record, 250);

  assert.equal(timedOut, false);
  assert.equal(await record.promise, "completed");
});
