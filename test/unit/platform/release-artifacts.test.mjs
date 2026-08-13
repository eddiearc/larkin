import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");

test("release x64 artifacts use Bun's pre-AVX2 baseline targets", async () => {
  const { RELEASE_TARGETS } = await import(path.join(ROOT, "dist/platform/release-artifacts.mjs"));
  assert.deepEqual(RELEASE_TARGETS, [
    { platform: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64" },
    { platform: "darwin", arch: "x64", bunTarget: "bun-darwin-x64-baseline" },
    { platform: "linux", arch: "arm64", bunTarget: "bun-linux-arm64" },
    { platform: "linux", arch: "x64", bunTarget: "bun-linux-x64-baseline" },
    { platform: "windows", arch: "x64", bunTarget: "bun-windows-x64-baseline" },
  ]);
});

test("windows artifacts use a .exe suffix and win32 platform normalizes", async () => {
  const { artifactFilename, normalizeReleasePlatform, selectReleaseArtifact, sha256File } = await import(
    path.join(ROOT, "dist/platform/release-artifacts.mjs")
  );
  assert.equal(normalizeReleasePlatform("win32"), "windows");
  assert.equal(normalizeReleasePlatform("linux"), "linux");
  assert.equal(artifactFilename("0.2.77", "windows", "x64"), "larkin-v0.2.77-windows-x64.exe");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-release-win-"));
  try {
    const file = artifactFilename("0.2.77", "windows", "x64");
    fs.writeFileSync(path.join(directory, file), "windows binary");
    const record = { platform: "windows", arch: "x64", file, sha256: sha256File(path.join(directory, file)), size: 14, signing: "unsigned" };
    const manifest = { schemaVersion: 1, version: "0.2.77", sourceCommit: "a".repeat(40), sourceDirty: false, bunVersion: "1.3.14", bytecode: false, notices: { file: "THIRD_PARTY_NOTICES.txt", sha256: "0".repeat(64), size: 1, scope: "runtime-closure" }, artifacts: [record] };
    assert.equal(selectReleaseArtifact(manifest, "win32", "x64"), record);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("release artifact selection is allowlisted and checksum-verified", async () => {
  const { artifactFilename, selectReleaseArtifact, sha256File, verifyReleaseArtifact, verifyReleaseNotices } = await import(
    path.join(ROOT, "dist/platform/release-artifacts.mjs")
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-release-artifact-"));
  try {
    const file = artifactFilename("1.2.3", "darwin", "arm64");
    fs.writeFileSync(path.join(directory, file), "binary bytes");
    const record = { platform: "darwin", arch: "arm64", file, sha256: sha256File(path.join(directory, file)), size: 12, signing: "adhoc" };
    const noticesFile = path.join(directory, "THIRD_PARTY_NOTICES.txt");
    fs.writeFileSync(noticesFile, "runtime notices\n");
    const notices = { file: "THIRD_PARTY_NOTICES.txt", sha256: sha256File(noticesFile), size: fs.statSync(noticesFile).size, scope: "runtime-closure" };
    const manifest = { schemaVersion: 1, version: "1.2.3", sourceCommit: "a".repeat(40), sourceDirty: false, bunVersion: "1.3.14", bytecode: false, notices, artifacts: [record] };
    assert.equal(selectReleaseArtifact(manifest, "darwin", "arm64"), record);
    assert.equal(verifyReleaseArtifact(directory, record), path.join(directory, file));
    assert.equal(verifyReleaseNotices(directory, manifest), noticesFile);
    fs.writeFileSync(noticesFile, "tampered notices\n");
    assert.throws(() => verifyReleaseNotices(directory, manifest), /runtime notices (?:size|checksum)/);
    assert.throws(() => selectReleaseArtifact(manifest, "win32", "x64"), /unsupported platform/);
    fs.writeFileSync(path.join(directory, file), "tamper bytes");
    assert.throws(() => verifyReleaseArtifact(directory, record), /checksum mismatch/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
