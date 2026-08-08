import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  bundledPiSubagentExtensionPath,
  parsePiVersion,
  piVersionSupportsSubagents,
  resolvePiSubagentExtensionArg,
} from "../../../dist/runtime/pi-subagent-injection.mjs";

test("parsePiVersion extracts major/minor from pi --version output", () => {
  assert.deepEqual(parsePiVersion("pi 0.83.0 (2026-07-29)"), { major: 0, minor: 83 });
  assert.deepEqual(parsePiVersion("1.2.3"), { major: 1, minor: 2 });
  assert.deepEqual(parsePiVersion("0.79.2"), { major: 0, minor: 79 });
});

test("parsePiVersion rejects missing or unparseable output", () => {
  assert.equal(parsePiVersion(undefined), null);
  assert.equal(parsePiVersion(""), null);
  assert.equal(parsePiVersion("not a version"), null);
  assert.equal(parsePiVersion("v"), null);
});

test("piVersionSupportsSubagents enforces the >=0.80.0 peer requirement", () => {
  assert.equal(piVersionSupportsSubagents({ major: 0, minor: 80 }), true);
  assert.equal(piVersionSupportsSubagents({ major: 0, minor: 83 }), true);
  assert.equal(piVersionSupportsSubagents({ major: 1, minor: 0 }), true);
  assert.equal(piVersionSupportsSubagents({ major: 0, minor: 79 }), false);
  assert.equal(piVersionSupportsSubagents(null), false);
});

test("builtin always injects when the bundle artifact exists (bundled pi 0.83.0)", () => {
  const bundle = bundledPiSubagentExtensionPath();
  assert.equal(typeof bundle, "string");
  const decision = resolvePiSubagentExtensionArg(
    { distribution: "builtin", piCommand: "pi", env: { LARKIN_PI_DISTRIBUTION: "builtin" } },
    () => null, // builtin ignores the probe; version comes from BUNDLED_PI_VERSION
  );
  assert.equal(decision, bundle);
});

test("external injects when the probed pi version satisfies the gate", () => {
  const bundle = bundledPiSubagentExtensionPath();
  const decision = resolvePiSubagentExtensionArg(
    { distribution: "external", piCommand: "pi", env: {} },
    () => ({ major: 0, minor: 84 }),
  );
  assert.equal(decision, bundle);
});

test("external does not inject when the probed pi version is below 0.80", () => {
  const decision = resolvePiSubagentExtensionArg(
    { distribution: "external", piCommand: "pi", env: {} },
    () => ({ major: 0, minor: 79 }),
  );
  assert.equal(decision, null);
});

test("external does not inject when the version cannot be probed", () => {
  const decision = resolvePiSubagentExtensionArg(
    { distribution: "external", piCommand: "/missing/pi", env: {} },
    () => null,
  );
  assert.equal(decision, null);
});
