import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { assembleRelease } from "../../../scripts/release/assemble.ts";

const targets = [
  ["darwin", "arm64", "adhoc"],
  ["darwin", "x64", "adhoc"],
  ["linux", "arm64", "unsigned"],
  ["linux", "x64", "unsigned"],
];

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("assembles four independently built platform artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-release-assemble-"));
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  for (const [platform, arch, signing] of targets) {
    const directory = path.join(input, `release-${platform}-${arch}`);
    fs.mkdirSync(directory, { recursive: true });
    const file = `larkin-v1.2.3-${platform}-${arch}`;
    const body = Buffer.from(`${platform}-${arch}`);
    fs.writeFileSync(path.join(directory, file), body, { mode: 0o755 });
    fs.writeFileSync(path.join(directory, `release-manifest-${platform}-${arch}.json`), `${JSON.stringify({
      schemaVersion: 1,
      version: "1.2.3",
      sourceCommit: "a".repeat(40),
      sourceDirty: false,
      bunVersion: "1.3.14",
      bytecode: false,
      artifacts: [{ platform, arch, file, sha256: hash(body), size: body.length, signing }],
    }, null, 2)}\n`);
  }

  const manifest = assembleRelease(input, output);
  assert.equal(manifest.artifacts.length, 4);
  assert.deepEqual(manifest.artifacts.map(({ platform, arch }) => `${platform}-${arch}`), [
    "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64",
  ]);
  assert.match(fs.readFileSync(path.join(output, "SHA256SUMS"), "utf8"), /larkin-v1\.2\.3-linux-x64/);
  assert.equal(fs.readFileSync(path.join(output, "LICENSE"), "utf8"), fs.readFileSync(path.join(import.meta.dirname, "../../../LICENSE"), "utf8"));
  assert.equal(
    fs.readFileSync(path.join(output, "THIRD_PARTY_NOTICES.md"), "utf8"),
    fs.readFileSync(path.join(import.meta.dirname, "../../../THIRD_PARTY_NOTICES.md"), "utf8"),
  );
  for (const artifact of manifest.artifacts) {
    assert.equal(hash(fs.readFileSync(path.join(output, artifact.file))), artifact.sha256);
  }
});

test("rejects incomplete release input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-release-assemble-missing-"));
  fs.mkdirSync(path.join(root, "input"));
  assert.throws(() => assembleRelease(path.join(root, "input"), path.join(root, "output")), /expected 4/);
});
