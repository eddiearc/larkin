import assert from "node:assert/strict";
import { test } from "bun:test";
import {
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

test("resolve returns null when the bundle resolver yields nothing", () => {
  const decision = resolvePiSubagentExtensionArg(
    { distribution: "external", piCommand: "pi", env: { PI_CODING_AGENT_DIR: "/missing/larkin-pi-agent" } },
    () => null,
    () => null,
  );
  assert.equal(decision, null);
});

test("external injects when the probed pi version satisfies the gate", () => {
  const fakeBundle = "/tmp/fake/pi-subagents.bundle.js";
  const decision = resolvePiSubagentExtensionArg(
    { distribution: "external", piCommand: "pi", env: { PI_CODING_AGENT_DIR: "/missing/larkin-pi-agent" } },
    () => ({ major: 0, minor: 84 }),
    () => fakeBundle,
  );
  assert.equal(decision, fakeBundle);
});

test("external does not inject when the probed pi version is below 0.80", () => {
  const decision = resolvePiSubagentExtensionArg(
    { distribution: "external", piCommand: "pi", env: { PI_CODING_AGENT_DIR: "/missing/larkin-pi-agent" } },
    () => ({ major: 0, minor: 79 }),
    () => "/tmp/fake/pi-subagents.bundle.js",
  );
  assert.equal(decision, null);
});

test("external does not inject when the version cannot be probed", () => {
  const decision = resolvePiSubagentExtensionArg(
    { distribution: "external", piCommand: "/missing/pi", env: { PI_CODING_AGENT_DIR: "/missing/larkin-pi-agent" } },
    () => null,
    () => "/tmp/fake/pi-subagents.bundle.js",
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

test("userPiAlreadyHasSubagentsExtension detects settings packages and package dir", async () => {
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
      JSON.stringify({ packages: ["n" + "pm:pi-codex-goal", "n" + "pm:@tintinweb/pi-subagents"] }));
    assert.equal(userPiAlreadyHasSubagentsExtension({ HOME: root, PI_CODING_AGENT_DIR: agentDir }), true);
    // 2) without the entry -> false
    fsMod.writeFileSync(pathMod.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-codex-goal"] }));
    assert.equal(userPiAlreadyHasSubagentsExtension({ HOME: root, PI_CODING_AGENT_DIR: agentDir }), false);
    // 3) package dir fallback even without settings entry
    const npmDir = pathMod.join(agentDir, "n" + "pm", "node_modules", "@tintinweb");
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

test("resolvePiSubagentExtensionArg refuses an unbounded user-installed extension", async () => {
  const { resolvePiSubagentExtensionArg } =
    await import("../../../dist/runtime/pi-subagent-injection.mjs");
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-subagents-skip-"));
  const fakeBundle = "/tmp/fake/pi-subagents.bundle.js";
  try {
    const agentDir = pathMod.join(root, ".pi", "agent");
    fsMod.mkdirSync(agentDir, { recursive: true });
    fsMod.writeFileSync(pathMod.join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["n" + "pm:@tintinweb/pi-subagents"] }));
    assert.throws(() => resolvePiSubagentExtensionArg(
      { distribution: "external", piCommand: "pi", env: { PI_CODING_AGENT_DIR: agentDir } },
      () => ({ major: 0, minor: 84 }),
      () => fakeBundle,
    ), /WARNING: refusing external Pi.*unbounded or unverifiable/);
  } finally {
    fsMod.rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePiSubagentExtensionArg accepts a user extension with the bounded capability in Pi's declared entry", async () => {
  const { resolvePiSubagentExtensionArg } =
    await import("../../../dist/runtime/pi-subagent-injection.mjs");
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-subagents-bounded-"));
  try {
    const agentDir = pathMod.join(root, ".pi", "agent");
    const packageDir = pathMod.join(agentDir, "n" + "pm", "node_modules", "@tintinweb", "pi-subagents");
    fsMod.mkdirSync(pathMod.join(packageDir, "src"), { recursive: true });
    fsMod.mkdirSync(pathMod.join(packageDir, "dist"), { recursive: true });
    fsMod.writeFileSync(pathMod.join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["n" + "pm:@tintinweb/pi-subagents"] }));
    fsMod.writeFileSync(pathMod.join(packageDir, "package.json"),
      JSON.stringify({ pi: { extensions: ["./src/index.ts"] } }));
    fsMod.writeFileSync(pathMod.join(packageDir, "src", "index.ts"),
      "larkin-pi-subagents-bounded-wait-v1\nlarkin-pi-subagents-command-wait-v1");
    fsMod.writeFileSync(pathMod.join(packageDir, "dist", "index.js"), "upstream build");
    const decision = resolvePiSubagentExtensionArg(
      { distribution: "external", piCommand: "pi", env: { PI_CODING_AGENT_DIR: agentDir } },
      () => ({ major: 0, minor: 84 }),
      () => "/tmp/fake/pi-subagents.bundle.js",
    );
    assert.equal(decision, null, "must not inject a verified bounded duplicate");
  } finally {
    fsMod.rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePiSubagentExtensionArg rejects a user extension that only has the old bounded-wait marker", async () => {
  const { resolvePiSubagentExtensionArg } =
    await import("../../../dist/runtime/pi-subagent-injection.mjs");
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-subagents-old-marker-"));
  try {
    const agentDir = pathMod.join(root, ".pi", "agent");
    const packageDir = pathMod.join(agentDir, "n" + "pm", "node_modules", "@tintinweb", "pi-subagents");
    fsMod.mkdirSync(pathMod.join(packageDir, "src"), { recursive: true });
    fsMod.writeFileSync(pathMod.join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["n" + "pm:@tintinweb/pi-subagents"] }));
    fsMod.writeFileSync(pathMod.join(packageDir, "package.json"),
      JSON.stringify({ pi: { extensions: ["./src/index.ts"] } }));
    fsMod.writeFileSync(pathMod.join(packageDir, "src", "index.ts"),
      "larkin-pi-subagents-bounded-wait-v1");
    assert.throws(() => resolvePiSubagentExtensionArg(
      { distribution: "external", piCommand: "pi", env: { PI_CODING_AGENT_DIR: agentDir } },
      () => ({ major: 0, minor: 84 }),
      () => "/tmp/fake/pi-subagents.bundle.js",
    ), /command-wait-v1/);
  } finally {
    fsMod.rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePiSubagentExtensionArg rejects a dist-only capability when Pi loads the declared source entry", async () => {
  const { resolvePiSubagentExtensionArg } =
    await import("../../../dist/runtime/pi-subagent-injection.mjs");
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-subagents-dist-only-"));
  try {
    const agentDir = pathMod.join(root, ".pi", "agent");
    const packageDir = pathMod.join(agentDir, "n" + "pm", "node_modules", "@tintinweb", "pi-subagents");
    fsMod.mkdirSync(pathMod.join(packageDir, "src"), { recursive: true });
    fsMod.mkdirSync(pathMod.join(packageDir, "dist"), { recursive: true });
    fsMod.writeFileSync(pathMod.join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["n" + "pm:@tintinweb/pi-subagents"] }));
    fsMod.writeFileSync(pathMod.join(packageDir, "package.json"),
      JSON.stringify({ pi: { extensions: ["./src/index.ts"] } }));
    fsMod.writeFileSync(pathMod.join(packageDir, "src", "index.ts"), "upstream source");
    fsMod.writeFileSync(pathMod.join(packageDir, "dist", "index.js"),
      "larkin-pi-subagents-bounded-wait-v1");
    assert.throws(() => resolvePiSubagentExtensionArg(
      { distribution: "external", piCommand: "pi", env: { PI_CODING_AGENT_DIR: agentDir } },
      () => ({ major: 0, minor: 84 }),
      () => "/tmp/fake/pi-subagents.bundle.js",
    ), /WARNING: refusing external Pi.*unbounded or unverifiable/);
  } finally {
    fsMod.rmSync(root, { recursive: true, force: true });
  }
});
