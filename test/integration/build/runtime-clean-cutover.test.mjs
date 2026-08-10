import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("authored source and generated runtime use the seven-domain mirrored layout", () => {
  const domains = ["agent", "app", "dashboard", "feishu", "platform", "runtime", "setup"];
  assert.deepEqual(
    fs.readdirSync(path.join(ROOT, "src"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
    domains,
  );
  assert.deepEqual(
    fs.readdirSync(path.join(ROOT, "src")).filter((name) => /\.(?:ts|cts)$/.test(name)),
    [],
    "src root must not retain flat production modules",
  );
  const packageJson = JSON.parse(source("package.json"));
  assert.equal(packageJson.bin.larkin, "dist/app/cli.mjs");
  assert.equal(packageJson.packageManager, "bun@1.3.14");
  assert.equal(fs.existsSync(path.join(ROOT, "bun.lock")), true);
  assert.equal(fs.existsSync(path.join(ROOT, "package-lock.json")), false);
  for (const relative of [
    "app/cli.mjs",
    "app/runtime-process.mjs",
    "runtime/runtime-host.mjs",
    "feishu/host-shell.mjs",
    "agent/agent-transport.cjs",
    "app/dashboard.mjs",
    "setup/setup-bind.mjs",
    "platform/config.cjs",
  ]) assert.equal(fs.existsSync(path.join(ROOT, "dist", relative)), true, relative);
});

test("production build, start, and Agent CLI graph contain only current entries", () => {
  const packageJson = JSON.parse(source("package.json"));
  assert.equal(packageJson.private, false, "the source checkout must remain publishable to the npm registry");
  assert.equal(packageJson.larkinPackageRole, "npm-published");
  assert.deepEqual(packageJson.files, [
    "dist/",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "artifacts/release/THIRD_PARTY_NOTICES.txt",
  ], "the npm package inventory must stay explicit");
  assert.equal(packageJson.scripts.prepack, undefined);
  assert.equal(packageJson.scripts[["pack", "dist"].join(":")], undefined);
  assert.equal(packageJson.scripts[["test", "installed", "tarball"].join(":")], undefined);
  assert.equal(fs.existsSync(path.join(ROOT, "scripts/package.mjs")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "scripts/refuse-source-pack.mjs")), false);
  assert.match(source("scripts/release/build.ts"), /release-manifest\.json/);
  assert.match(source("scripts/release/build.ts"), /SHA256SUMS/);
  assert.match(source("scripts/release/smoke.ts"), /selectReleaseArtifact|verifyReleaseArtifact/);
  assert.match(source("scripts/release/install.ts"), /larkin\.previous/);
  assert.match(source("scripts/release/install.ts"), /--rollback/);
});

test("a clean standalone shell build contains the complete new production entry graph", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-clean-build-"));
  try {
    const outDir = path.join(temp, "dist");
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/build.mjs"), "--out-dir", outDir], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const entry of ["app/runtime-process.mjs", "runtime/runtime-host.mjs", "runtime/runtime-adapters.mjs", "agent/context-prompt.mjs", "app/agent-cli.mjs"]) {
      assert.equal(fs.existsSync(path.join(outDir, entry)), true, `clean build missing ${entry}`);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
