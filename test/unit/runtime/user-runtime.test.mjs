import assert from "node:assert/strict";
import { test } from "bun:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const {
  RUNTIME_OPTIONS, fromUserRuntime, isAdapterRuntime, isUserRuntime, piCatalogDistributionForUserRuntime,
  runtimeOptionOf, runtimeOptionTarget, toUserRuntime,
} = await import(pathToFileURL(path.join(ROOT, "dist/runtime/user-runtime.mjs")).href);

test("user-facing siblings project to stored adapter id plus distribution", () => {
  assert.deepEqual([...RUNTIME_OPTIONS], ["codex", "claude", "pi", "builtin-pi"]);
  assert.deepEqual(fromUserRuntime("builtin-pi"), { runtime: "pi", piDistribution: "builtin" });
  assert.deepEqual(runtimeOptionTarget("pi"), { runtime: "pi", piDistribution: "external" });
  assert.deepEqual(fromUserRuntime("codex"), { runtime: "codex" });
  assert.deepEqual(fromUserRuntime("claude"), { runtime: "claude" });
  assert.equal(toUserRuntime("pi", "builtin"), "builtin-pi");
  assert.equal(runtimeOptionOf({ runtime: "pi", piDistribution: "external" }), "pi");
  assert.equal(toUserRuntime("pi"), "pi");
  assert.equal(toUserRuntime("pi", null), "pi");
  assert.equal(toUserRuntime("codex"), "codex");
  assert.equal(piCatalogDistributionForUserRuntime("builtin-pi"), "builtin");
  assert.equal(piCatalogDistributionForUserRuntime("pi"), "external");
  assert.equal(isUserRuntime("builtin-pi"), true);
  assert.equal(isAdapterRuntime("builtin-pi"), false);
  assert.equal(isAdapterRuntime("pi"), true);
});
