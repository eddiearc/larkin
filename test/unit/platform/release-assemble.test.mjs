import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { assembleRelease } from "../../../scripts/release/assemble.ts";
import { generateRuntimeNotices } from "../../../scripts/generate-third-party-notices.mjs";

const targets = [
  ["darwin", "arm64", "adhoc"],
  ["darwin", "x64", "adhoc"],
  ["linux", "arm64", "unsigned"],
  ["linux", "x64", "unsigned"],
  ["windows", "x64", "unsigned"],
];

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("assembles four independently built platform artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-release-assemble-"));
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const noticeBody = generateRuntimeNotices();
  const notices = { file: "THIRD_PARTY_NOTICES.txt", sha256: hash(noticeBody), size: Buffer.byteLength(noticeBody), scope: "runtime-closure" };
  for (const [platform, arch, signing] of targets) {
    const directory = path.join(input, `release-${platform}-${arch}`);
    fs.mkdirSync(directory, { recursive: true });
    const file = `larkin-v1.2.3-${platform}-${arch}${platform === "windows" ? ".exe" : ""}`;
    const body = Buffer.from(`${platform}-${arch}`);
    fs.writeFileSync(path.join(directory, file), body, { mode: 0o755 });
    fs.writeFileSync(path.join(directory, `release-manifest-${platform}-${arch}.json`), `${JSON.stringify({
      schemaVersion: 1,
      version: "1.2.3",
      sourceCommit: "a".repeat(40),
      sourceDirty: false,
      bunVersion: "1.3.14",
      bytecode: false,
      notices,
      artifacts: [{ platform, arch, file, sha256: hash(body), size: body.length, signing }],
    }, null, 2)}\n`);
  }

  const manifest = assembleRelease(input, output);
  assert.equal(manifest.artifacts.length, 5);
  assert.deepEqual(manifest.artifacts.map(({ platform, arch }) => `${platform}-${arch}`), [
    "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64",
  ]);
  assert.match(fs.readFileSync(path.join(output, "SHA256SUMS"), "utf8"), /larkin-v1\.2\.3-linux-x64/);
  assert.match(fs.readFileSync(path.join(output, "SHA256SUMS"), "utf8"), /larkin-v1\.2\.3-windows-x64\.exe/);
  assert.match(fs.readFileSync(path.join(output, "SHA256SUMS"), "utf8"), /^[a-f0-9]{64}  THIRD_PARTY_NOTICES\.txt$/m);
  assert.equal(fs.readFileSync(path.join(output, "LICENSE"), "utf8"), fs.readFileSync(path.join(import.meta.dirname, "../../../LICENSE"), "utf8"));
  assert.equal(
    fs.readFileSync(path.join(output, "THIRD_PARTY_NOTICES.txt"), "utf8"),
    generateRuntimeNotices(),
  );
  assert.deepEqual(manifest.notices, notices);
  for (const artifact of manifest.artifacts) {
    assert.equal(hash(fs.readFileSync(path.join(output, artifact.file))), artifact.sha256);
  }
});

test("rejects platform manifests whose runtime notices are not bound to the release output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-release-assemble-notices-"));
  const input = path.join(root, "input");
  const noticeBody = generateRuntimeNotices();
  const notices = { file: "THIRD_PARTY_NOTICES.txt", sha256: hash(noticeBody), size: Buffer.byteLength(noticeBody), scope: "runtime-closure" };
  for (const [platform, arch, signing] of targets) {
    const directory = path.join(input, `release-${platform}-${arch}`);
    fs.mkdirSync(directory, { recursive: true });
    const file = `larkin-v1.2.3-${platform}-${arch}${platform === "windows" ? ".exe" : ""}`;
    const body = Buffer.from(`${platform}-${arch}`);
    fs.writeFileSync(path.join(directory, file), body);
    fs.writeFileSync(path.join(directory, `release-manifest-${platform}-${arch}.json`), `${JSON.stringify({
      schemaVersion: 1, version: "1.2.3", sourceCommit: "a".repeat(40), sourceDirty: false,
      bunVersion: "1.3.14", bytecode: false, notices: platform === "linux" && arch === "x64" ? { ...notices, sha256: "0".repeat(64) } : notices,
      artifacts: [{ platform, arch, file, sha256: hash(body), size: body.length, signing }],
    })}\n`);
  }
  assert.throws(() => assembleRelease(input, path.join(root, "output")), /runtime notices do not match/);
});

test("rejects incomplete release input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-release-assemble-missing-"));
  fs.mkdirSync(path.join(root, "input"));
  assert.throws(() => assembleRelease(path.join(root, "input"), path.join(root, "output")), /expected 5/);
});
