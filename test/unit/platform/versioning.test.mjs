import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "bun:test";

import {
  assertReleaseTag,
  nextStableVersion,
  updateManifestVersion,
} from "../../../scripts/versioning.mjs";

describe("explicit semantic versioning", () => {
  test("computes patch, minor, major, and exact upgrades", () => {
    assert.equal(nextStableVersion("0.2.28", "patch"), "0.2.29");
    assert.equal(nextStableVersion("0.2.28", "minor"), "0.3.0");
    assert.equal(nextStableVersion("0.2.28", "major"), "1.0.0");
    assert.equal(nextStableVersion("0.2.28", "2.4.0"), "2.4.0");
  });

  test("rejects invalid, equal, and lower explicit versions", () => {
    assert.throws(() => nextStableVersion("0.2.28", "v1.0.0"), /稳定 semver/);
    assert.throws(() => nextStableVersion("0.2.28", "0.2.28"), /必须高于/);
    assert.throws(() => nextStableVersion("0.2.28", "0.1.99"), /必须高于/);
  });

  test("updates only the manifest version", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-versioning-"));
    const file = path.join(directory, "package.json");
    fs.writeFileSync(file, `${JSON.stringify({ name: "fixture", version: "1.2.3", private: true }, null, 2)}\n`);
    assert.deepEqual(updateManifestVersion(file, "minor"), { current: "1.2.3", version: "1.3.0" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { name: "fixture", version: "1.3.0", private: true });
  });

  test("requires the pushed tag to match package.json exactly", () => {
    assert.equal(assertReleaseTag("1.2.3", "v1.2.3"), "1.2.3");
    assert.throws(() => assertReleaseTag("1.2.3", "v1.2.4"), /不一致/);
  });
});
