import assert from "node:assert/strict";
import { test } from "bun:test";
import { openOwnedDashboardWhenReady } from "../../../dist/app/setup-dashboard.mjs";

test("first setup waits for supervisor dashboard readiness and opens it through an injected seam", async () => {
  const observations = [
    { state: "dead", running: false },
    { state: "dead", running: false },
    { state: "owned", running: true, url: "http://localhost:9876" },
  ];
  const opened = [];
  const result = await openOwnedDashboardWhenReady("/isolated/larkin", {
    timeoutMs: 500,
    pollMs: 1,
    readDashboard() { return observations.shift() ?? { state: "owned", running: true, url: "http://localhost:9876" }; },
    opener(url) { opened.push(url); return true; },
  });
  assert.deepEqual(result, { readiness: { state: "owned", url: "http://localhost:9876" }, opened: true });
  assert.deepEqual(opened, ["http://localhost:9876"]);
});

test("setup dashboard readiness timeout never invokes a browser", async () => {
  let opened = false;
  const result = await openOwnedDashboardWhenReady("/isolated/larkin", {
    timeoutMs: 2,
    pollMs: 1,
    readDashboard() { return { state: "dead", running: false }; },
    opener() { opened = true; return true; },
  });
  assert.deepEqual(result, { readiness: { state: "timeout" }, opened: false });
  assert.equal(opened, false);
});
