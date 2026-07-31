import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const HELPER = path.join(ROOT, "scripts/release/intent.mjs");
const SOURCE_SHA = "a".repeat(40);
const BEFORE_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);
const TAG_OBJECT_SHA = "d".repeat(40);

const FAKE_GIT = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const source = process.env.FAKE_SOURCE_SHA;
const before = process.env.FAKE_BEFORE_SHA;
if (args[0] === "rev-parse" && args[1] === "HEAD") console.log(source);
else if (args[0] === "show-ref") process.exit(process.env.FAKE_SHOW_REF_FAIL === "1" ? 1 : 0);
else if (args[0] === "merge-base") process.exit(process.env.FAKE_MERGE_BASE_FAIL === "1" ? 1 : 0);
else if (args[0] === "show" && args[1] === source + ":package.json") console.log(JSON.stringify({ version: process.env.FAKE_CURRENT_VERSION }));
else if (args[0] === "show" && args[1] === before + ":package.json") console.log(JSON.stringify({ version: process.env.FAKE_PREVIOUS_VERSION }));
else { console.error("unexpected fake git command: " + JSON.stringify(args)); process.exit(70); }
`;

const FAKE_GH = `#!/usr/bin/env bun
import fs from "node:fs";
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.commands ??= [];
state.commands.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const missing = () => { save(); console.error("gh: Not Found (HTTP 404)"); process.exit(1); };
if (args[0] === "api" && args.includes("GET")) {
  const endpoint = args.find((value) => value.startsWith("repos/"));
  const ref = endpoint.match(/\\/git\\/ref\\/tags\\/(.+)$/);
  const object = endpoint.match(/\\/git\\/tags\\/([0-9a-f]{40})$/);
  const release = endpoint.match(/\\/releases\\/tags\\/(.+)$/);
  if (ref) {
    const value = state.tags?.[ref[1]];
    if (!value) missing();
    save(); console.log(JSON.stringify(value));
  } else if (object) {
    const value = state.tagObjects?.[object[1]];
    if (!value) missing();
    save(); console.log(JSON.stringify(value));
  } else if (release) {
    const value = state.releases?.[release[1]];
    if (!value) missing();
    save(); console.log(JSON.stringify({ tagName: release[1], isDraft: value === "draft" }));
  } else if (endpoint.includes("/releases?per_page=100")) {
    const sequences = state.publishedSequences;
    let published = state.published ?? [];
    if (Array.isArray(sequences)) {
      const index = Math.min(state.publishedQueries ?? 0, sequences.length - 1);
      published = sequences[index];
      state.publishedQueries = (state.publishedQueries ?? 0) + 1;
    }
    save();
    if (published.length) console.log(published.join("\\n"));
  } else { save(); console.error("unexpected fake gh GET: " + endpoint); process.exit(71); }
} else if (args[0] === "api" && args.includes("POST")) {
  const refArg = args.find((value) => value.startsWith("ref=refs/tags/"));
  const shaArg = args.find((value) => value.startsWith("sha="));
  const tag = refArg.slice("ref=refs/tags/".length);
  const sha = shaArg.slice("sha=".length);
  const mode = state.createTagMode ?? "success";
  if (mode === "success" || mode === "race-same") state.tags[tag] = { type: "commit", sha };
  else if (mode === "race-conflict") state.tags[tag] = { type: "commit", sha: state.conflictingSha };
  save();
  if (mode === "success") console.log("{}");
  else { console.error("gh: reference update conflict (HTTP 422)"); process.exit(1); }
} else if (args[0] === "release" && args[1] === "create") {
  const tag = args[2];
  if (state.createReleaseMode === "failure") { save(); console.error("release create failed"); process.exit(1); }
  state.releases[tag] = "draft";
  save();
  console.log("created");
} else { save(); console.error("unexpected fake gh command: " + JSON.stringify(args)); process.exit(72); }
`;

function fixture(initial = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-release-intent-command-"));
  const bin = path.join(directory, "bin");
  const stateFile = path.join(directory, "gh-state.json");
  const outputFile = path.join(directory, "github-output.txt");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), FAKE_GIT, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(stateFile, JSON.stringify({
    tags: {},
    tagObjects: {},
    releases: {},
    published: ["v0.2.34"],
    ...initial,
  }));
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_TOKEN: "fake-token",
    GITHUB_REPOSITORY: "owner/repository",
    GITHUB_OUTPUT: outputFile,
    RELEASE_EVENT_NAME: "push",
    RELEASE_REF: "refs/heads/main",
    RELEASE_SOURCE_SHA: SOURCE_SHA,
    RELEASE_BEFORE_SHA: BEFORE_SHA,
    RELEASE_TAG: "v0.2.35",
    RELEASE_PREDECESSOR_ATTEMPTS: "2",
    RELEASE_PREDECESSOR_DELAY_MS: "0",
    FAKE_SOURCE_SHA: SOURCE_SHA,
    FAKE_BEFORE_SHA: BEFORE_SHA,
    FAKE_CURRENT_VERSION: "0.2.35",
    FAKE_PREVIOUS_VERSION: "0.2.34",
    FAKE_GH_STATE: stateFile,
  };
  const execute = (command, overrides = {}) => {
    fs.writeFileSync(outputFile, "");
    const result = spawnSync(process.execPath, [HELPER, command], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...environment, ...overrides },
    });
    const outputs = Object.fromEntries(fs.readFileSync(outputFile, "utf8").trim().split("\n").filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    return { result, outputs, state: JSON.parse(fs.readFileSync(stateFile, "utf8")) };
  };
  return { directory, execute };
}

function commandCount(state, prefix) {
  return state.commands.filter((args) => args.slice(0, prefix.length).join(" ") === prefix.join(" ")).length;
}

describe("release intent executable command boundary", () => {
  test("resolve peels lightweight and annotated tags to one immutable commit", () => {
    for (const annotated of [false, true]) {
      const tag = annotated
        ? { type: "tag", sha: TAG_OBJECT_SHA }
        : { type: "commit", sha: SOURCE_SHA };
      const f = fixture({
        tags: { "v0.2.35": tag },
        tagObjects: annotated ? { [TAG_OBJECT_SHA]: { type: "commit", sha: SOURCE_SHA } } : {},
      });
      try {
        const run = f.execute("resolve", { RELEASE_REF: "refs/tags/v0.2.35" });
        assert.equal(run.result.status, 0, run.result.stderr);
        assert.deepEqual(run.outputs, {
          mode: "tag",
          release_tag: "v0.2.35",
          source_sha: SOURCE_SHA,
          should_create_tag: "false",
          should_publish: "true",
        });
        assert.equal(commandCount(run.state, ["api", "--method", "GET"]), annotated ? 4 : 3);
      } finally {
        fs.rmSync(f.directory, { recursive: true, force: true });
      }
    }
  });

  test("main resolve waits for its published predecessor and fails when the bound is exhausted", () => {
    const eventual = fixture({ publishedSequences: [[], ["v0.2.34"]] });
    try {
      const run = eventual.execute("resolve");
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.equal(run.outputs.should_publish, "true");
      assert.equal(run.state.publishedQueries, 2);
    } finally {
      fs.rmSync(eventual.directory, { recursive: true, force: true });
    }

    const missing = fixture({ publishedSequences: [[], []] });
    try {
      const run = missing.execute("resolve");
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stderr, /predecessor release v0\.2\.34 was not published after 2 attempts/);
      assert.equal(run.state.publishedQueries, 2);
    } finally {
      fs.rmSync(missing.directory, { recursive: true, force: true });
    }
  });

  test("a main package diff without a version increment fails closed", () => {
    const f = fixture({ published: ["v0.2.35"] });
    try {
      const run = f.execute("resolve", { FAKE_PREVIOUS_VERSION: "0.2.35" });
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stderr, /main package version must increase: 0\.2\.35 -> 0\.2\.35/);
      assert.deepEqual(run.outputs, {});
    } finally {
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  });

  test("prepare creates an exact tag and draft and reports publishable output", () => {
    const f = fixture();
    try {
      const run = f.execute("prepare");
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.equal(run.outputs.should_publish, "true");
      assert.deepEqual(run.state.tags["v0.2.35"], { type: "commit", sha: SOURCE_SHA });
      assert.equal(run.state.releases["v0.2.35"], "draft");
      assert.equal(commandCount(run.state, ["api", "--method", "POST"]), 1);
      assert.equal(commandCount(run.state, ["release", "create"]), 1);
    } finally {
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  });

  test("prepare accepts a same-SHA create race but rejects a conflicting race and a failed create", () => {
    const same = fixture({ createTagMode: "race-same" });
    try {
      const run = same.execute("prepare");
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.equal(run.outputs.should_publish, "true");
      assert.equal(run.state.tags["v0.2.35"].sha, SOURCE_SHA);
    } finally {
      fs.rmSync(same.directory, { recursive: true, force: true });
    }

    for (const [mode, pattern] of [["race-conflict", /failed to create immutable tag/], ["failure", /failed to create immutable tag/]]) {
      const f = fixture({ createTagMode: mode, conflictingSha: OTHER_SHA });
      try {
        const run = f.execute("prepare");
        assert.notEqual(run.result.status, 0);
        assert.match(run.result.stderr, pattern);
        assert.equal(run.state.releases["v0.2.35"], undefined);
      } finally {
        fs.rmSync(f.directory, { recursive: true, force: true });
      }
    }
  });

  test("prepare resumes a draft and treats a published exact release as a no-op", () => {
    for (const [release, expected] of [["draft", "true"], ["published", "false"]]) {
      const f = fixture({
        tags: { "v0.2.35": { type: "commit", sha: SOURCE_SHA } },
        releases: { "v0.2.35": release },
      });
      try {
        const run = f.execute("prepare");
        assert.equal(run.result.status, 0, run.result.stderr);
        assert.equal(run.outputs.should_publish, expected);
        assert.equal(commandCount(run.state, ["api", "--method", "POST"]), 0);
        assert.equal(commandCount(run.state, ["release", "create"]), 0);
      } finally {
        fs.rmSync(f.directory, { recursive: true, force: true });
      }
    }
  });

  test("assert-draft rejects published releases and conflicting immutable tags", () => {
    const published = fixture({
      tags: { "v0.2.35": { type: "commit", sha: SOURCE_SHA } },
      releases: { "v0.2.35": "published" },
    });
    try {
      const run = published.execute("assert-draft");
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stderr, /refusing to modify non-draft release/);
    } finally {
      fs.rmSync(published.directory, { recursive: true, force: true });
    }

    const conflict = fixture({
      tags: { "v0.2.35": { type: "commit", sha: OTHER_SHA } },
      releases: { "v0.2.35": "draft" },
    });
    try {
      const run = conflict.execute("assert-draft");
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stderr, /no longer points at the immutable release source/);
    } finally {
      fs.rmSync(conflict.directory, { recursive: true, force: true });
    }
  });
});
