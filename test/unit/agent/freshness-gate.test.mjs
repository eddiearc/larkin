import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";

const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/agent/freshness-gate.mjs")).href;
const storeUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/agent/agent-state-store.mjs")).href;

test("generic freshness gate keeps cursor semantics inside a synthetic non-IM adapter", async () => {
  const { evaluateFreshness } = await import(moduleUrl);
  const adapter = {
    cursor: (snapshot) => snapshot.etag,
    compare: (seen, current) => current === null ? (seen === null ? "fresh" : "gap") : seen === current ? "fresh" : "conflict",
    unseen: (_seen, snapshot) => snapshot.body,
  };
  assert.equal(evaluateFreshness({ seen: "v2", probe: () => ({ etag: "v2", body: "same" }), adapter }).status, "fresh");
  assert.deepEqual(evaluateFreshness({ seen: "v1", probe: () => ({ etag: "v2", body: "changed" }), adapter }), {
    status: "conflict", current: "v2", snapshot: { etag: "v2", body: "changed" }, context: "changed",
  });
  assert.equal(evaluateFreshness({ seen: "v2", probe() { throw new Error("offline"); }, adapter }).status, "unavailable");
});

test("seen cursors are isolated by target and Runtime observation generation", async () => {
  const { createAgentStateStore } = await import(storeUrl);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-freshness-store-"));
  try {
    const store = createAgentStateStore(root, "cli_freshnessStoreA1");
    const merge = (previous, current) => previous === null || current > previous ? current : previous;
    store.mergeFreshnessCursor("provider/chat/a", 2, merge, "launch:1");
    assert.equal(store.readFreshnessCursor("provider/chat/a", "launch:1"), 2);
    assert.equal(store.readFreshnessCursor("provider/chat/b", "launch:1"), null);
    assert.equal(store.readFreshnessCursor("provider/chat/a", "launch:2"), null);
    store.mergeFreshnessCursor("provider/chat/a", 1, merge, "launch:2");
    assert.equal(store.readFreshnessCursor("provider/chat/a", "launch:2"), 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
