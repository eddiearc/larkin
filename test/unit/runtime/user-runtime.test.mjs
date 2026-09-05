import assert from "node:assert/strict";
import { test } from "bun:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const {
  RUNTIME_OPTIONS, fromUserRuntime, isAdapterRuntime, isUserRuntime,
  runtimeOptionOf, runtimeOptionTarget, toUserRuntime,
} = await import(pathToFileURL(path.join(ROOT, "dist/runtime/user-runtime.mjs")).href);

test("user-facing runtimes are the three external ids", () => {
  assert.deepEqual([...RUNTIME_OPTIONS], ["codex", "claude", "pi"]);
  assert.deepEqual(fromUserRuntime("pi"), { runtime: "pi" });
  assert.deepEqual(runtimeOptionTarget("pi"), { runtime: "pi" });
  assert.deepEqual(fromUserRuntime("codex"), { runtime: "codex" });
  assert.deepEqual(fromUserRuntime("claude"), { runtime: "claude" });
  assert.equal(toUserRuntime("pi"), "pi");
  assert.equal(runtimeOptionOf({ runtime: "pi" }), "pi");
  assert.equal(toUserRuntime("codex"), "codex");
  assert.equal(isUserRuntime("pi"), true);
  assert.equal(isUserRuntime("codex"), true);
  assert.equal(isUserRuntime("claude"), true);
  assert.equal(isUserRuntime("builtin-pi"), false);
  assert.equal(isAdapterRuntime("builtin-pi"), false);
  assert.equal(isAdapterRuntime("pi"), true);
  assert.throws(() => fromUserRuntime("builtin-pi"), /未知 runtime：builtin-pi/);
  assert.throws(() => runtimeOptionTarget("builtin-pi"), /未知 runtime：builtin-pi/);
});
