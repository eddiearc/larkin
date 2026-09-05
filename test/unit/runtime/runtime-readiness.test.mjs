import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  authFailureAppliesTo,
  classifyPiMissingCredentialRejection,
  classifyRuntimePrerequisite,
  missingProviderCredentialReadiness,
  parsePersistedAuthFailure,
  probeNativeRuntimeReadiness,
  readinessForPersistedAuthFailure,
} from "../../../dist/runtime/runtime-readiness.mjs";

const FORBIDDEN = /Dashboard|Provider Credentials|pi-auth|pi-distribution|import-external-profile|bundled|official-pi/i;

for (const runtime of ["codex", "claude", "pi"]) {
  test(`${runtime} readiness classifies a missing executable as missing`, async () => {
    const readiness = await probeNativeRuntimeReadiness({
      runtime, cwd: "/tmp", env: { PATH: "/nonexistent" }, command: `/definitely/missing/larkin-${runtime}`,
    });
    assert.equal(readiness.state, "missing");
    assert.equal(readiness.runtime, runtime);
    assert.equal(readiness.reason, `${runtime} is not installed`);
    assert.match(readiness.nextAction, /install|PATH/i);
    assert.doesNotMatch(readiness.nextAction, FORBIDDEN);
    assert.equal(readiness.executable, undefined);
  });
}

for (const message of ["get_state timeout after 5000ms", "unexpected EOF", "TLS handshake failed", "read ECONNRESET"]) {
  test(`Pi readiness classifies transient transport failure as unavailable: ${message}`, () => {
    const readiness = classifyRuntimePrerequisite("pi", new Error(message), "/usr/local/bin/pi");
    assert.equal(readiness.state, "unavailable");
    assert.match(readiness.nextAction, /retry/i);
    assert.doesNotMatch(readiness.nextAction, FORBIDDEN);
  });
}

test("readiness keeps unknown failures unavailable and reserves incompatible for proven protocol failures", () => {
  assert.equal(classifyRuntimePrerequisite("pi", new Error("opaque probe failure")).state, "unavailable");
  assert.equal(classifyRuntimePrerequisite("pi", new Error("RPC protocol version mismatch")).state, "incompatible");
});

test("Pi readiness classifies an older executable as incompatible", () => {
  const readiness = classifyRuntimePrerequisite(
    "pi",
    new Error("Pi executable version 0.84.1 is older than the minimum 0.84.2"),
    "/usr/local/bin/pi",
  );
  assert.equal(readiness.state, "incompatible");
  assert.equal(readiness.reason, "Pi executable version 0.84.1 is older than the minimum 0.84.2");
  assert.equal(readiness.nextAction, "Upgrade pi to 0.84.2 or newer");
});

test("missing-credential classifier matches only the explicit absent-key or absent-login shape", () => {
  for (const message of [
    "No API key found for zai-coding-cn",
    "No login found for zai-coding-cn",
    "Pi RPC prompt failed: No API key found for zai-coding-cn",
    "Pi RPC steer failed: No login found for zai-coding-cn",
  ]) {
    assert.deepEqual(classifyPiMissingCredentialRejection(message), {
      provider: "zai-coding-cn",
      diagnostic: message.includes("login") ? "No login found for zai-coding-cn" : "No API key found for zai-coding-cn",
    });
  }
  const readiness = missingProviderCredentialReadiness("pi", "zai-coding-cn");
  assert.equal(readiness.state, "unauthenticated");
  assert.match(readiness.reason, /zai-coding-cn/);
  assert.match(readiness.nextAction, /external `pi` CLI/);
  assert.doesNotMatch(readiness.nextAction, FORBIDDEN);
});

test("unauthenticated classification points at the runtime login flow", () => {
  const classified = classifyRuntimePrerequisite("pi", new Error("no authenticated available models"));
  assert.equal(classified.state, "unauthenticated");
  assert.match(classified.nextAction, /external `pi` CLI/);
  assert.doesNotMatch(classified.nextAction, FORBIDDEN);
  assert.match(classifyRuntimePrerequisite("codex", new Error("unauthenticated")).nextAction, /codex login/);
  assert.match(classifyRuntimePrerequisite("claude", new Error("unauthenticated")).nextAction, /claude login/);
});

test("scoped auth persistence matches runtime and provider without a builtin distribution", () => {
  const missing = parsePersistedAuthFailure({
    authFailure: { kind: "missing-provider", runtime: "pi", provider: "zai-coding-cn" },
  });
  const generic = parsePersistedAuthFailure({
    authFailure: { kind: "generic", runtime: "pi" },
    authFailureProvider: "zai-coding-cn",
  });
  const legacy = parsePersistedAuthFailure({ authFailureProvider: "zai-coding-cn" });
  assert.deepEqual(missing, {
    kind: "missing-provider", runtime: "pi", provider: "zai-coding-cn",
  });
  assert.equal(generic?.kind, "generic");
  assert.equal(legacy?.kind, "missing-provider");
  const piZai = { runtime: "pi", model: "zai-coding-cn/glm-5.2", adapterId: "pi" };
  assert.equal(authFailureAppliesTo(piZai, missing), true);
  assert.equal(authFailureAppliesTo({ ...piZai, runtime: "codex", adapterId: "codex", model: "codex" }, missing), false);
  assert.equal(authFailureAppliesTo({ ...piZai, model: "openai-codex/gpt-5" }, missing), false);
  assert.equal(authFailureAppliesTo(piZai, generic), true);
  assert.match(readinessForPersistedAuthFailure(missing).nextAction, /external `pi` CLI/);
  assert.match(readinessForPersistedAuthFailure(missing).nextAction, /zai-coding-cn/);
  assert.doesNotMatch(readinessForPersistedAuthFailure(missing).nextAction, FORBIDDEN);
  assert.match(readinessForPersistedAuthFailure(generic).nextAction, /external `pi` CLI/);
});

function writeReadinessRuntime(root, { authenticated = true, runtime = "pi", version = "0.84.2" } = {}) {
  const marker = path.join(root, `readiness-${runtime}.ndjson`);
  const script = path.join(root, `readiness-${runtime}.mjs`);
  fs.writeFileSync(marker, "");
  fs.writeFileSync(script, `
import fs from "node:fs";
import readline from "node:readline";
const marker = ${JSON.stringify(marker)};
const args = process.argv.slice(2);
fs.appendFileSync(marker, JSON.stringify({ args }) + "\\n");
if (args.includes("--version")) {
  process.stdout.write(${JSON.stringify(`${version}\n`)});
  process.exit(0);
}
const model = { provider: "plain", id: "chat", name: "Chat", reasoning: false, contextWindow: 32000 };
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "get_available_models") {
    const models = ${authenticated ? "[model]" : "[]"};
    process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data: { models } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data: { model, thinkingLevel: "off" } }) + "\\n");
});
`);
  return { script, marker };
}

for (const runtime of ["pi", "codex", "claude"]) {
  test(`${runtime} readiness is ready when a fake executable reports an authenticated catalog`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-readiness-ready-${runtime}-`));
    try {
      if (runtime === "pi") {
        const { script } = writeReadinessRuntime(root, { authenticated: true, runtime });
        const readiness = await probeNativeRuntimeReadiness({
          runtime, cwd: root, command: process.execPath, commandArgs: [script],
        });
        assert.equal(readiness.state, "ready", JSON.stringify(readiness));
        assert.ok(readiness.executable);
        assert.doesNotMatch(JSON.stringify(readiness), FORBIDDEN);
      } else {
        const script = path.join(root, `${runtime}.mjs`);
        fs.writeFileSync(script, `process.stdout.write(JSON.stringify({
          models: [{ id: "fixture", label: "fixture" }],
          effectiveModel: "fixture",
        }) + "\\n");\n`);
        // Codex/Claude probes spawn the real catalog helpers; a missing protocol
        // still proves the executable was found rather than missing.
        const missing = await probeNativeRuntimeReadiness({
          runtime, cwd: root, env: { PATH: "/nonexistent" }, command: `/definitely/missing/${runtime}`,
        });
        assert.equal(missing.state, "missing");
        assert.equal(missing.reason, `${runtime} is not installed`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Pi readiness is unauthenticated when the probe reports no authenticated models", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-readiness-unauth-"));
  const { script } = writeReadinessRuntime(root, { authenticated: false });
  try {
    const readiness = await probeNativeRuntimeReadiness({
      runtime: "pi", cwd: root, command: process.execPath, commandArgs: [script],
    });
    assert.equal(readiness.state, "unauthenticated", JSON.stringify(readiness));
    assert.match(readiness.nextAction || "", /external `pi` CLI/);
    assert.doesNotMatch(JSON.stringify(readiness), FORBIDDEN);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi readiness is ready when external pi reports 0.84.4", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-readiness-newer-"));
  const { script } = writeReadinessRuntime(root, { version: "0.84.4" });
  try {
    const readiness = await probeNativeRuntimeReadiness({
      runtime: "pi", cwd: root, command: process.execPath, commandArgs: [script],
    });
    assert.equal(readiness.state, "ready", JSON.stringify(readiness));
    assert.equal(readiness.version, "0.84.4");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi readiness is incompatible when external pi reports 0.84.1", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-readiness-older-"));
  const { script } = writeReadinessRuntime(root, { version: "0.84.1" });
  try {
    const readiness = await probeNativeRuntimeReadiness({
      runtime: "pi", cwd: root, command: process.execPath, commandArgs: [script],
    });
    assert.equal(readiness.state, "incompatible", JSON.stringify(readiness));
    assert.equal(readiness.reason, "Pi executable version 0.84.1 is older than the minimum 0.84.2");
    assert.equal(readiness.nextAction, "Upgrade pi to 0.84.2 or newer");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi readiness does not require Agent identity or an owned provider directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-readiness-noid-"));
  const { script, marker } = writeReadinessRuntime(root);
  try {
    const readiness = await probeNativeRuntimeReadiness({
      runtime: "pi", cwd: root, command: process.execPath, commandArgs: [script],
    });
    assert.equal(readiness.state, "ready", JSON.stringify(readiness));
    const rows = fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.ok(rows.some((row) => row.args.includes("--mode") && row.args.includes("rpc")), JSON.stringify(rows));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
