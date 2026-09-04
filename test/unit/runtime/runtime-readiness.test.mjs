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
  for (const message of [
    "No API key found for zai-coding-cn and extra text",
    "provider reported no API key found for zai-coding-cn",
    "No API key found for ../secret",
    "fetch failed: provider overloaded",
    "API key auth failed for zai-coding-cn",
  ]) {
    assert.equal(classifyPiMissingCredentialRejection(message), null);
  }
  const readiness = missingProviderCredentialReadiness("pi", "zai-coding-cn");
  assert.equal(readiness.state, "unauthenticated");
  assert.match(readiness.reason, /zai-coding-cn/);
  assert.match(readiness.nextAction, /Add the missing zai-coding-cn credential to this Agent's official store/);
  assert.doesNotMatch(readiness.nextAction, /larkin setup|profile import|pi-auth login|Dashboard/);
});

test("scoped auth persistence prefers current generic over a legacy missing-provider string", () => {
  const missing = parsePersistedAuthFailure({
    authFailure: { kind: "missing-provider", runtime: "pi", piDistribution: "builtin", provider: "zai-coding-cn" },
  });
  const generic = parsePersistedAuthFailure({
    authFailure: { kind: "generic", runtime: "pi", piDistribution: "builtin" },
    authFailureProvider: "zai-coding-cn",
  });
  const legacy = parsePersistedAuthFailure({ authFailureProvider: "zai-coding-cn" });
  assert.deepEqual(missing, {
    kind: "missing-provider", runtime: "pi", piDistribution: "builtin", provider: "zai-coding-cn",
  });
  assert.equal(generic?.kind, "generic");
  assert.equal(legacy?.kind, "missing-provider");
  const builtinZai = { runtime: "pi", piDistribution: "builtin", model: "zai-coding-cn/glm-5.2", adapterId: "pi" };
  assert.equal(authFailureAppliesTo(builtinZai, missing), true);
  assert.equal(authFailureAppliesTo({ ...builtinZai, piDistribution: "external" }, missing), false);
  assert.equal(authFailureAppliesTo({ ...builtinZai, runtime: "codex", adapterId: "codex", model: "codex" }, missing), false);
  assert.equal(authFailureAppliesTo({ ...builtinZai, model: "openai-codex/gpt-5" }, missing), false);
  assert.equal(authFailureAppliesTo(builtinZai, generic), true);
  const genericZai = parsePersistedAuthFailure({
    authFailure: { kind: "generic", runtime: "pi", piDistribution: "builtin", provider: "zai-coding-cn" },
  });
  assert.deepEqual(genericZai, {
    kind: "generic", runtime: "pi", piDistribution: "builtin", provider: "zai-coding-cn",
  });
  assert.equal(authFailureAppliesTo(builtinZai, genericZai), true);
  assert.equal(authFailureAppliesTo({ ...builtinZai, model: "openai-codex/gpt-5" }, genericZai), false);
  assert.equal(authFailureAppliesTo({ ...builtinZai, model: "openai-codex/gpt-5" }, generic), true,
    "unbound generic is conservative fallback only when the upstream provider was unavailable");
  assert.match(readinessForPersistedAuthFailure(generic).nextAction, /login|API-key resolver/);
  assert.doesNotMatch(readinessForPersistedAuthFailure(generic).nextAction, /official store/);
});

function writeReadinessPi(root, { failIfDirty = false } = {}) {
  const marker = path.join(root, "readiness-pi.ndjson");
  const script = path.join(root, "readiness-pi.mjs");
  fs.writeFileSync(marker, "");
  fs.writeFileSync(script, `
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const marker = ${JSON.stringify(marker)};
const args = process.argv.slice(2);
fs.appendFileSync(marker, JSON.stringify({ args, packageDir: process.env.PI_PACKAGE_DIR || null, agentDir: process.env.PI_CODING_AGENT_DIR || null }) + "\\n");
if (args.includes("--version")) {
  if (${failIfDirty ? "true" : "false"} && process.env.PI_PACKAGE_DIR) {
    const theme = path.join(process.env.PI_PACKAGE_DIR, "dist/modes/interactive/theme/dark.json");
    try { if (!fs.statSync(theme).isFile()) process.exit(1); } catch { process.exit(1); }
  }
  process.stdout.write("0.84.2\\n");
  process.exit(0);
}
const model = { provider: "plain", id: "chat", name: "Chat", reasoning: false, contextWindow: 32000 };
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  const data = request.type === "get_available_models" ? { models: [model] } : { model, thinkingLevel: "off" };
  process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }) + "\\n");
});
`);
  return { script, marker };
}

function writeThemeRoot(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "dist", "modes", "interactive", "theme"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "modes", "interactive", "theme", "dark.json"), "{}\n");
  return dir;
}

test("external Pi readiness keeps a real package root and strips minimal or broken roots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-readiness-pkg-"));
  const agentId = "cli_readinessPkgA1";
  const { script, marker } = writeReadinessPi(root);
  const real = writeThemeRoot(root, "nix-store-pi");
  const minimal = path.join(root, ".larkin-official-pi-package");
  fs.mkdirSync(path.join(minimal, "theme"), { recursive: true });
  fs.writeFileSync(path.join(minimal, "theme", "dark.json"), "{}\n");
  const broken = path.join(root, "broken-link");
  fs.symlinkSync(path.join(root, "missing-target"), broken);
  const ownedDir = path.join(root, "providers", "pi", agentId);
  const envFor = (packageDir) => ({
    PI_PACKAGE_DIR: packageDir, LARKIN_PI_DISTRIBUTION: "external",
    LARKIN_CONFIG_DIR: root, PI_CODING_AGENT_DIR: path.join(root, "decoy-pi"),
  });
  try {
    const ready = await probeNativeRuntimeReadiness({
      runtime: "pi", agentId, cwd: root, command: process.execPath, commandArgs: [script],
      env: envFor(real),
    });
    assert.equal(ready.state, "ready", JSON.stringify(ready));
    const strippedMinimal = await probeNativeRuntimeReadiness({
      runtime: "pi", agentId, cwd: root, command: process.execPath, commandArgs: [script],
      env: envFor(minimal),
    });
    assert.equal(strippedMinimal.state, "ready", JSON.stringify(strippedMinimal));
    const strippedBroken = await probeNativeRuntimeReadiness({
      runtime: "pi", agentId, cwd: root, command: process.execPath, commandArgs: [script],
      env: envFor(broken),
    });
    assert.equal(strippedBroken.state, "ready", JSON.stringify(strippedBroken));
    const rows = fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const realRows = rows.filter((row) => row.packageDir && row.packageDir.includes("nix-store-pi"));
    const dirtyRows = rows.filter((row) => row.packageDir && (String(row.packageDir).includes(".larkin-official-pi-package") || String(row.packageDir).includes("broken-link")));
    assert.ok(realRows.some((row) => row.args.includes("--version")), JSON.stringify(rows));
    assert.ok(realRows.some((row) => row.args.includes("--mode") && row.args.includes("rpc")), JSON.stringify(rows));
    assert.ok(realRows.length >= 2, JSON.stringify(rows));
    assert.equal(dirtyRows.length, 0, JSON.stringify(rows));
    const rpcRows = rows.filter((row) => row.args.includes("--mode") && row.args.includes("rpc"));
    assert.ok(rpcRows.length > 0 && rpcRows.every((row) => row.agentDir === ownedDir), JSON.stringify(rows));
    assert.equal(rpcRows.some((row) => String(row.agentDir).includes("decoy-pi")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("external Pi readiness without Agent identity does not fall through to host Pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-readiness-noid-"));
  const { script, marker } = writeReadinessPi(root);
  try {
    const readiness = await probeNativeRuntimeReadiness({
      runtime: "pi", cwd: root, command: process.execPath, commandArgs: [script],
      env: { LARKIN_PI_DISTRIBUTION: "external", PI_CODING_AGENT_DIR: path.join(root, "decoy-pi") },
    });
    assert.equal(readiness.state, "unavailable", JSON.stringify(readiness));
    assert.match(readiness.reason || "", /requires Agent ID/);
    assert.equal(fs.readFileSync(marker, "utf8").trim(), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
