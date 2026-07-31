import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { resolveReleaseIntent } from "../../../scripts/release/intent.mjs";

const SOURCE_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

describe("package-version release intent", () => {
  test("main version increments derive one same-run tag publication", () => {
    assert.deepEqual(resolveReleaseIntent({
      ref: "refs/heads/main",
      sourceSha: SOURCE_SHA,
      currentVersion: "0.2.35",
      previousVersion: "0.2.34",
      tagTargetSha: null,
      releaseState: "absent",
      publishedVersions: ["0.2.34"],
    }), {
      mode: "main",
      releaseTag: "v0.2.35",
      sourceSha: SOURCE_SHA,
      shouldCreateTag: true,
      shouldPublish: true,
    });
  });

  test("matching draft resumes and matching published release is an idempotent no-op", () => {
    const input = {
      ref: "refs/heads/main",
      sourceSha: SOURCE_SHA,
      currentVersion: "0.2.35",
      previousVersion: "0.2.34",
      tagTargetSha: SOURCE_SHA,
      publishedVersions: ["0.2.34"],
    };
    assert.deepEqual(resolveReleaseIntent({ ...input, releaseState: "draft" }), {
      mode: "main",
      releaseTag: "v0.2.35",
      sourceSha: SOURCE_SHA,
      shouldCreateTag: false,
      shouldPublish: true,
    });
    assert.equal(resolveReleaseIntent({ ...input, releaseState: "published" }).shouldPublish, false);
  });

  test("an explicit matching tag retains the same immutable pipeline", () => {
    assert.deepEqual(resolveReleaseIntent({
      ref: "refs/tags/v0.2.35",
      sourceSha: SOURCE_SHA,
      currentVersion: "0.2.35",
      tagTargetSha: SOURCE_SHA,
      releaseState: "absent",
      publishedVersions: ["0.2.34"],
    }), {
      mode: "tag",
      releaseTag: "v0.2.35",
      sourceSha: SOURCE_SHA,
      shouldCreateTag: false,
      shouldPublish: true,
    });
  });

  test("conflicts, non-increments, downgrades, and unsupported refs fail closed", () => {
    const main = {
      ref: "refs/heads/main",
      sourceSha: SOURCE_SHA,
      currentVersion: "0.2.35",
      previousVersion: "0.2.34",
      tagTargetSha: null,
      releaseState: "absent",
      publishedVersions: ["0.2.34"],
    };
    assert.throws(() => resolveReleaseIntent({ ...main, previousVersion: "0.2.35" }), /increase/);
    assert.throws(() => resolveReleaseIntent({ ...main, previousVersion: "0.3.0" }), /increase/);
    assert.throws(() => resolveReleaseIntent({ ...main, tagTargetSha: OTHER_SHA }), /another source commit/);
    assert.throws(() => resolveReleaseIntent({ ...main, releaseState: "draft" }), /without its immutable tag/);
    assert.throws(() => resolveReleaseIntent({ ...main, publishedVersions: [] }), /predecessor release/);
    assert.throws(() => resolveReleaseIntent({ ...main, publishedVersions: ["0.2.34", "0.2.36"] }), /older than published/);
    assert.throws(() => resolveReleaseIntent({ ...main, ref: "refs/heads/feature" }), /unsupported release ref/);
    assert.throws(() => resolveReleaseIntent({
      ...main,
      ref: "refs/tags/v0.2.34",
      tagTargetSha: SOURCE_SHA,
    }), /does not match/);
    assert.throws(() => resolveReleaseIntent({
      ...main,
      ref: "refs/tags/v0.2.35",
      tagTargetSha: null,
    }), /pushed tag is unavailable/);
  });
});
