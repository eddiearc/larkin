import assert from "node:assert/strict";
import { test } from "bun:test";
import { classifyRuntimePrerequisite, probeNativeRuntimeReadiness } from "../../../dist/runtime/runtime-readiness.mjs";

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

for (const message of ["get_state timeout after 5000ms", "unexpected EOF", "TLS handshake failed", "read ECONNRESET"]) {
  test(`Pi readiness classifies transient transport failure as unavailable: ${message}`, () => {
    const readiness = classifyRuntimePrerequisite("pi", new Error(message), "/usr/local/bin/pi");
    assert.equal(readiness.state, "unavailable");
    assert.match(readiness.nextAction, /retry/i);
  });
}

test("readiness keeps unknown failures unavailable and reserves incompatible for proven protocol failures", () => {
  assert.equal(classifyRuntimePrerequisite("pi", new Error("opaque probe failure")).state, "unavailable");
  assert.equal(classifyRuntimePrerequisite("pi", new Error("RPC protocol version mismatch")).state, "incompatible");
});
