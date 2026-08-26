import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
fs.appendFileSync(marker, JSON.stringify({ args, packageDir: process.env.PI_PACKAGE_DIR || null }) + "\\n");
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
  const { script, marker } = writeReadinessPi(root);
  const real = writeThemeRoot(root, "nix-store-pi");
  const minimal = path.join(root, ".larkin-official-pi-package");
  fs.mkdirSync(path.join(minimal, "theme"), { recursive: true });
  fs.writeFileSync(path.join(minimal, "theme", "dark.json"), "{}\n");
  const broken = path.join(root, "broken-link");
  fs.symlinkSync(path.join(root, "missing-target"), broken);
  try {
    const ready = await probeNativeRuntimeReadiness({
      runtime: "pi", cwd: root, command: process.execPath, commandArgs: [script],
      env: { PI_PACKAGE_DIR: real, LARKIN_PI_DISTRIBUTION: "external" },
    });
    assert.equal(ready.state, "ready", JSON.stringify(ready));
    const strippedMinimal = await probeNativeRuntimeReadiness({
      runtime: "pi", cwd: root, command: process.execPath, commandArgs: [script],
      env: { PI_PACKAGE_DIR: minimal, LARKIN_PI_DISTRIBUTION: "external" },
    });
    assert.equal(strippedMinimal.state, "ready", JSON.stringify(strippedMinimal));
    const strippedBroken = await probeNativeRuntimeReadiness({
      runtime: "pi", cwd: root, command: process.execPath, commandArgs: [script],
      env: { PI_PACKAGE_DIR: broken, LARKIN_PI_DISTRIBUTION: "external" },
    });
    assert.equal(strippedBroken.state, "ready", JSON.stringify(strippedBroken));
    const rows = fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const realRows = rows.filter((row) => row.packageDir && row.packageDir.includes("nix-store-pi"));
    const dirtyRows = rows.filter((row) => row.packageDir && (String(row.packageDir).includes(".larkin-official-pi-package") || String(row.packageDir).includes("broken-link")));
    assert.ok(realRows.some((row) => row.args.includes("--version")), JSON.stringify(rows));
    assert.ok(realRows.some((row) => row.args.includes("--mode") && row.args.includes("rpc")), JSON.stringify(rows));
    assert.ok(realRows.length >= 2, JSON.stringify(rows));
    assert.equal(dirtyRows.length, 0, JSON.stringify(rows));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
