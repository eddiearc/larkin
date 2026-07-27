import assert from "node:assert/strict";
import { test } from "bun:test";
import { probeNativeRuntimeReadiness } from "../../../dist/runtime/runtime-readiness.mjs";

for (const runtime of ["codex", "claude", "pi"]) {
  test(`${runtime} readiness classifies an unresolved configured command as missing`, async () => {
    const readiness = await probeNativeRuntimeReadiness({
      runtime, cwd: "/tmp", env: { PATH: "/nonexistent" }, command: `/definitely/missing/larkin-${runtime}`,
    });
    assert.equal(readiness.state, "missing");
    assert.equal(readiness.runtime, runtime);
    assert.match(readiness.nextAction, /install|PATH/i);
    assert.equal(readiness.executable, undefined);
  });
}
