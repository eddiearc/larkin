import assert from "node:assert/strict";
import { test } from "bun:test";
import { resolvePiBashTimeoutExtensionArg } from "../../../dist/runtime/pi-bash-timeout-injection.mjs";

test("resolve returns null when the bundle resolver yields nothing", () => {
  const decision = resolvePiBashTimeoutExtensionArg(
    { distribution: "external", piCommand: "pi", env: {} },
    () => null,
    () => null,
  );
  assert.equal(decision, null);
});

test("external injects when the probed pi version satisfies the gate", () => {
  const fakeBundle = "/tmp/fake/pi-bash-timeout.bundle.js";
  const decision = resolvePiBashTimeoutExtensionArg(
    { distribution: "external", piCommand: "pi", env: {} },
    () => ({ major: 0, minor: 84 }),
    () => fakeBundle,
  );
  assert.equal(decision, fakeBundle);
});

test("external does not inject when the probed pi version is below 0.80", () => {
  const decision = resolvePiBashTimeoutExtensionArg(
    { distribution: "external", piCommand: "pi", env: {} },
    () => ({ major: 0, minor: 79 }),
    () => "/tmp/fake/pi-bash-timeout.bundle.js",
  );
  assert.equal(decision, null);
});

test("external does not inject when the version cannot be probed", () => {
  const decision = resolvePiBashTimeoutExtensionArg(
    { distribution: "external", piCommand: "/missing/pi", env: {} },
    () => null,
    () => "/tmp/fake/pi-bash-timeout.bundle.js",
  );
  assert.equal(decision, null);
});

test("embedded bundle materializes under configDir with private permissions", async () => {
  const { materializeEmbeddedPiBashTimeoutBundle } = await import("../../../dist/runtime/pi-bash-timeout-injection.mjs");
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-bash-timeout-embedded-"));
  try {
    const marker = "larkin-embedded-marker-" + Math.random().toString(16).slice(2);
    const previous = globalThis.__LARKIN_EMBEDDED_PI_BASH_TIMEOUT_BUNDLE__;
    globalThis.__LARKIN_EMBEDDED_PI_BASH_TIMEOUT_BUNDLE__ = `console.log("${marker}");`;
    try {
      const target = materializeEmbeddedPiBashTimeoutBundle(pathMod.join(root, "config"));
      assert.ok(target, "embedded bundle must materialize");
      assert.match(target, /providers[\\/]pi[\\/]extensions[\\/]pi-bash-timeout\.bundle\.js$/);
      assert.ok(fsMod.existsSync(target));
      assert.equal(fsMod.statSync(target).mode & 0o777, 0o600);
      const dir = pathMod.dirname(target);
      assert.equal(fsMod.statSync(dir).mode & 0o777, 0o700);
      // idempotent second call returns same path
      assert.equal(materializeEmbeddedPiBashTimeoutBundle(pathMod.join(root, "config")), target);
    } finally {
      globalThis.__LARKIN_EMBEDDED_PI_BASH_TIMEOUT_BUNDLE__ = previous;
    }
  } finally {
    fsMod.rmSync(root, { recursive: true, force: true });
  }
});

test("embedded materialize returns null without embedded asset or configDir", async () => {
  const { materializeEmbeddedPiBashTimeoutBundle } = await import("../../../dist/runtime/pi-bash-timeout-injection.mjs");
  const previous = globalThis.__LARKIN_EMBEDDED_PI_BASH_TIMEOUT_BUNDLE__;
  globalThis.__LARKIN_EMBEDDED_PI_BASH_TIMEOUT_BUNDLE__ = undefined;
  try {
    assert.equal(materializeEmbeddedPiBashTimeoutBundle("/tmp/some-config"), null);
    assert.equal(materializeEmbeddedPiBashTimeoutBundle(undefined), null);
  } finally {
    globalThis.__LARKIN_EMBEDDED_PI_BASH_TIMEOUT_BUNDLE__ = previous;
  }
});
