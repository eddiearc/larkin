import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const enabled = process.env.LARKIN_RUN_STANDALONE_RELEASE_TEST === "1";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test.skipIf(!enabled)("native standalone release embeds Dashboard assets, installs, and rolls back", { timeout: 180_000 }, async () => {
  assert.ok(process.versions.bun, "this release integration must run under the pinned Bun runtime");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-standalone-release-"));
  const releaseDirA = path.join(root, "release-a");
  const releaseDirB = path.join(root, "release-b");
  const installDir = path.join(root, "install");
  try {
    const platform = os.platform();
    const arch = os.arch();
    const rejectedOverrideEnv = { ...process.env };
    delete rejectedOverrideEnv.LARKIN_RELEASE_TEST_VERSION_OVERRIDE;
    const rejectedOverride = spawnSync(process.execPath, [
      "scripts/release/build.ts",
      "--target", `${platform}-${arch}`,
      "--out-dir", path.join(root, "rejected-version-override"),
      "--allow-dirty",
      "--test-version", "9.9.9-test",
    ], { cwd: ROOT, encoding: "utf8", env: rejectedOverrideEnv });
    assert.notEqual(rejectedOverride.status, 0, "test version override must fail closed without the explicit test environment gate");
    assert.match(rejectedOverride.stderr, /LARKIN_RELEASE_TEST_VERSION_OVERRIDE=1/);
    const buildA = spawnSync(process.execPath, ["scripts/release/build.ts", "--target", `${platform}-${arch}`, "--out-dir", releaseDirA, "--allow-dirty"], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000,
    });
    assert.equal(buildA.status, 0, buildA.stderr || buildA.stdout);
    const manifestA = JSON.parse(fs.readFileSync(path.join(releaseDirA, "release-manifest.json"), "utf8"));
    assert.equal(manifestA.bytecode, false);
    assert.equal(manifestA.artifacts.length, 1);
    const noticeA = fs.readFileSync(path.join(releaseDirA, "THIRD_PARTY_NOTICES.txt"), "utf8");
    assert.match(noticeA, /Copyright \(c\) 2025 Mario Zechner/);
    assert.match(noticeA, /MIT License/);
    assert.match(fs.readFileSync(path.join(releaseDirA, "SHA256SUMS"), "utf8"), /THIRD_PARTY_NOTICES\.txt/);
    const artifactA = path.join(releaseDirA, manifestA.artifacts[0].file);
    const versionA = spawnSync(artifactA, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(versionA.status, 0, versionA.stderr);
    assert.equal(versionA.stdout.trim(), `larkin ${manifestA.version}`);
    const upgradeVersion = `${manifestA.version}-upgrade-test`;
    const buildB = spawnSync(process.execPath, [
      "scripts/release/build.ts",
      "--target", `${platform}-${arch}`,
      "--out-dir", releaseDirB,
      "--allow-dirty",
      "--test-version", upgradeVersion,
    ], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, LARKIN_RELEASE_TEST_VERSION_OVERRIDE: "1" },
    });
    assert.equal(buildB.status, 0, buildB.stderr || buildB.stdout);
    const manifestB = JSON.parse(fs.readFileSync(path.join(releaseDirB, "release-manifest.json"), "utf8"));
    assert.equal(manifestB.version, upgradeVersion);
    assert.equal(manifestB.sourceCommit, manifestA.sourceCommit, "test version override must not alter source provenance");
    assert.equal(manifestB.sourceDirty, manifestA.sourceDirty, "test version override must report the real Git dirty state");
    const artifactB = path.join(releaseDirB, manifestB.artifacts[0].file);
    assert.notEqual(sha256(artifactB), sha256(artifactA), "upgrade artifact must contain distinct compiled bytes");
    const port = await freePort();
    const dashboardHome = path.join(root, "dashboard-home");
    const dashboard = spawn(artifactA, ["__internal", "dashboard", "--port", String(port)], {
      env: { PATH: "/usr/bin:/bin", LARKIN_CONFIG_DIR: dashboardHome, LARKIN_HOME: dashboardHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const dashboardExit = new Promise((resolve) => dashboard.once("exit", resolve));
    try {
      let response;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try { response = await fetch(`http://127.0.0.1:${port}/dashboard-assets/dashboard.js`); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      assert.equal(response?.status, 200);
      assert.ok((await response.arrayBuffer()).byteLength > 100_000);
      assert.equal((await fetch(`http://127.0.0.1:${port}/dashboard-assets/dashboard.css`)).status, 200);
      assert.equal((await fetch(`http://127.0.0.1:${port}/assets/larkin-mark.svg`)).status, 200);
    } finally {
      if (dashboard.exitCode === null && dashboard.signalCode === null) dashboard.kill("SIGTERM");
      await dashboardExit;
    }
    const install = (releaseDir) => spawnSync(process.execPath, ["scripts/release/install.ts", "--release-dir", releaseDir, "--install-dir", installDir, "--allow-dirty"], { cwd: ROOT, encoding: "utf8" });
    const installed = path.join(installDir, "larkin");
    const previous = path.join(installDir, "larkin.previous");
    assert.equal(install(releaseDirA).status, 0);
    assert.equal(sha256(installed), sha256(artifactA));
    assert.equal(install(releaseDirB).status, 0);
    assert.equal(sha256(installed), sha256(artifactB), "upgrade must atomically activate artifact B");
    assert.equal(sha256(previous), sha256(artifactA), "upgrade must retain artifact A as previous");
    const installedBVersion = spawnSync(installed, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(installedBVersion.status, 0, installedBVersion.stderr);
    assert.equal(installedBVersion.stdout.trim(), `larkin ${manifestB.version}`);
    const rollback = spawnSync(process.execPath, ["scripts/release/install.ts", "--install-dir", installDir, "--rollback"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.equal(sha256(installed), sha256(artifactA), "rollback must restore artifact A bytes");
    assert.equal(sha256(previous), sha256(artifactB), "rollback must retain displaced artifact B as previous");
    const rolledBackVersion = spawnSync(installed, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(rolledBackVersion.status, 0, rolledBackVersion.stderr);
    assert.equal(rolledBackVersion.stdout.trim(), `larkin ${manifestA.version}`);
    const badRelease = path.join(root, "bad-release");
    fs.cpSync(releaseDirA, badRelease, { recursive: true });
    const badManifestFile = path.join(badRelease, "release-manifest.json");
    const badManifest = JSON.parse(fs.readFileSync(badManifestFile, "utf8"));
    badManifest.artifacts[0].sha256 = "0".repeat(64);
    fs.writeFileSync(badManifestFile, `${JSON.stringify(badManifest, null, 2)}\n`);
    const rejectedDir = path.join(root, "rejected");
    const rejected = spawnSync(process.execPath, ["scripts/release/install.ts", "--release-dir", badRelease, "--install-dir", rejectedDir, "--allow-dirty"], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /checksum mismatch/);
    assert.equal(fs.existsSync(path.join(rejectedDir, "larkin")), false);
    const badNoticesRelease = path.join(root, "bad-notices-release");
    fs.cpSync(releaseDirA, badNoticesRelease, { recursive: true });
    fs.appendFileSync(path.join(badNoticesRelease, "THIRD_PARTY_NOTICES.txt"), "tampered\n");
    const rejectedNoticesDir = path.join(root, "rejected-notices");
    const rejectedNotices = spawnSync(process.execPath, [
      "scripts/release/install.ts", "--release-dir", badNoticesRelease, "--install-dir", rejectedNoticesDir, "--allow-dirty",
    ], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(rejectedNotices.status, 0);
    assert.match(rejectedNotices.stderr, /runtime notices (?:size|checksum)/);
    assert.equal(fs.existsSync(path.join(rejectedNoticesDir, "larkin")), false);
    assert.equal(fs.readdirSync(releaseDirA).some((name) => /\.(?:js|mjs|cjs|ts|map)$/.test(name)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
