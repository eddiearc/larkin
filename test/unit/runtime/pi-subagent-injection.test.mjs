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

test("embedded bundle materializes under configDir with private permissions", async () => {
  const { materializeEmbeddedPiSubagentBundle } = await import("../../../dist/runtime/pi-subagent-injection.mjs");
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-subagents-embedded-"));
  try {
    const marker = "larkin-embedded-marker-" + Math.random().toString(16).slice(2);
    const previous = globalThis.__LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__;
    globalThis.__LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__ = `console.log("${marker}");`;
    try {
      const target = materializeEmbeddedPiSubagentBundle(pathMod.join(root, "config"));
      assert.ok(target, "embedded bundle must materialize");
      assert.match(target, /providers[\\/]pi[\\/]extensions[\\/]pi-subagents\.bundle\.js$/);
      assert.ok(fsMod.existsSync(target));
      assert.equal(fsMod.statSync(target).mode & 0o777, 0o600);
      const dir = pathMod.dirname(target);
      assert.equal(fsMod.statSync(dir).mode & 0o777, 0o700);
      // idempotent second call returns same path
      assert.equal(materializeEmbeddedPiSubagentBundle(pathMod.join(root, "config")), target);
    } finally {
      globalThis.__LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__ = previous;
    }
  } finally {
    fsMod.rmSync(root, { recursive: true, force: true });
  }
});

test("embedded materialize returns null without embedded asset or configDir", async () => {
  const { materializeEmbeddedPiSubagentBundle } = await import("../../../dist/runtime/pi-subagent-injection.mjs");
  const previous = globalThis.__LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__;
  globalThis.__LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__ = undefined;
  try {
    assert.equal(materializeEmbeddedPiSubagentBundle("/tmp/some-config"), null);
    assert.equal(materializeEmbeddedPiSubagentBundle(undefined), null);
  } finally {
    globalThis.__LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__ = previous;
  }
});

test("userPiAlreadyHasSubagentsExtension detects settings packages and npm dir", async () => {
  const { userPiAlreadyHasSubagentsExtension } = await import("../../../dist/runtime/pi-subagent-injection.mjs");
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-subagents-conflict-"));
  try {
    const agentDir = pathMod.join(root, ".pi", "agent");
    fsMod.mkdirSync(agentDir, { recursive: true });
    // 1) settings.json packages entry
    fsMod.writeFileSync(pathMod.join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-codex-goal", "npm:@tintinweb/pi-subagents"] }));
    assert.equal(userPiAlreadyHasSubagentsExtension({ HOME: root, PI_CODING_AGENT_DIR: agentDir }), true);
    // 2) without the entry -> false
    fsMod.writeFileSync(pathMod.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-codex-goal"] }));
    assert.equal(userPiAlreadyHasSubagentsExtension({ HOME: root, PI_CODING_AGENT_DIR: agentDir }), false);
    // 3) npm dir fallback even without settings entry
    const npmDir = pathMod.join(agentDir, "npm", "node_modules", "@tintinweb");
    fsMod.mkdirSync(npmDir, { recursive: true });
    fsMod.writeFileSync(pathMod.join(npmDir, "pi-subagents"), "");
    assert.equal(userPiAlreadyHasSubagentsExtension({ HOME: root, PI_CODING_AGENT_DIR: agentDir }), true);
    // 4) unreadable/missing config -> false (injection stays safe)
    fsMod.rmSync(pathMod.join(agentDir, "settings.json"));
    fsMod.rmSync(npmDir, { recursive: true, force: true });
    assert.equal(userPiAlreadyHasSubagentsExtension({ HOME: root, PI_CODING_AGENT_DIR: agentDir }), false);
  } finally {
    fsMod.rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePiSubagentExtensionArg skips injection when user already installed the extension", async () => {
  const { resolvePiSubagentExtensionArg, userPiAlreadyHasSubagentsExtension, bundledPiSubagentExtensionPath } =
    await import("../../../dist/runtime/pi-subagent-injection.mjs");
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-subagents-skip-"));
  try {
    const agentDir = pathMod.join(root, ".pi", "agent");
    fsMod.mkdirSync(agentDir, { recursive: true });
    fsMod.writeFileSync(pathMod.join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:@tintinweb/pi-subagents"] }));
    const bundle = bundledPiSubagentExtensionPath();
    const decision = resolvePiSubagentExtensionArg(
      { distribution: "external", piCommand: "pi", env: { PI_CODING_AGENT_DIR: agentDir } },
      () => ({ major: 0, minor: 84 }),
    );
    assert.equal(decision, null, "must not inject when user already has pi-subagents");
    // builtin is unaffected (managed agent dir, no user config)
    const builtin = resolvePiSubagentExtensionArg(
      { distribution: "builtin", piCommand: "pi", env: { PI_CODING_AGENT_DIR: agentDir } },
      () => null,
    );
    assert.equal(typeof bundle, "string");
    assert.equal(builtin, bundle);
  } finally {
    fsMod.rmSync(root, { recursive: true, force: true });
  }
});
