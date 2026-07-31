#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  assertReleaseTag,
  compareStableVersions,
  parseStableVersion,
} from "../versioning.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RELEASE_STATES = new Set(["absent", "draft", "published"]);

function checkedSha(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!SHA.test(normalized)) throw new Error(`${label} must be a full commit SHA`);
  return normalized;
}

function highestVersion(versions) {
  let highest = null;
  for (const value of versions ?? []) {
    parseStableVersion(value);
    if (highest === null || compareStableVersions(value, highest) > 0) highest = value;
  }
  return highest;
}

export function resolveReleaseIntent({
  ref,
  sourceSha,
  currentVersion,
  previousVersion,
  tagTargetSha,
  releaseState,
  publishedVersions = [],
}) {
  const source = checkedSha(sourceSha, "source SHA");
  parseStableVersion(currentVersion);
  if (!RELEASE_STATES.has(releaseState)) throw new Error(`unsupported release state: ${releaseState}`);

  const releaseTag = `v${currentVersion}`;
  let mode;
  if (ref === "refs/heads/main") {
    mode = "main";
    parseStableVersion(previousVersion);
    if (compareStableVersions(currentVersion, previousVersion) <= 0) {
      throw new Error(`main package version must increase: ${previousVersion} -> ${currentVersion}`);
    }
  } else if (String(ref || "").startsWith("refs/tags/")) {
    mode = "tag";
    const pushedTag = String(ref).slice("refs/tags/".length);
    try {
      assertReleaseTag(currentVersion, pushedTag);
    } catch {
      throw new Error(`pushed tag ${pushedTag} does not match package.json v${currentVersion}`);
    }
  } else {
    throw new Error(`unsupported release ref: ${ref || "missing"}`);
  }

  const tagTarget = tagTargetSha === null || tagTargetSha === undefined || tagTargetSha === ""
    ? null
    : checkedSha(tagTargetSha, "tag target SHA");
  if (tagTarget !== null && tagTarget !== source) {
    throw new Error(`${releaseTag} already points at another source commit`);
  }
  if (mode === "tag" && tagTarget === null) {
    throw new Error(`pushed tag is unavailable: ${releaseTag}`);
  }
  if (releaseState !== "absent" && tagTarget === null) {
    throw new Error(`${releaseTag} has a ${releaseState} release without its immutable tag`);
  }

  const publishedSet = new Set(publishedVersions);
  if (mode === "main" && !publishedSet.has(previousVersion)) {
    throw new Error(`predecessor release v${previousVersion} is not published`);
  }

  if (releaseState === "published") {
    return {
      mode,
      releaseTag,
      sourceSha: source,
      shouldCreateTag: false,
      shouldPublish: false,
    };
  }

  const published = highestVersion(publishedVersions);
  if (published !== null && compareStableVersions(currentVersion, published) <= 0) {
    throw new Error(`release version ${currentVersion} is older than published version ${published}`);
  }

  return {
    mode,
    releaseTag,
    sourceSha: source,
    shouldCreateTag: mode === "main" && tagTarget === null,
    shouldPublish: true,
  };
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "no diagnostic").trim().slice(0, 800);
    throw new Error(`${command} failed (${result.status}): ${detail}`);
  }
  return result;
}

function git(args, options) {
  return run("git", args, options);
}

function gh(args, options) {
  return run("gh", args, options);
}

function repository() {
  const value = String(process.env.GITHUB_REPOSITORY || "");
  if (!REPOSITORY.test(value)) throw new Error("GITHUB_REPOSITORY is invalid");
  return value;
}

function queryJson(endpoint, jq, { allowNotFound = false } = {}) {
  const result = gh(["api", "--method", "GET", endpoint, "--jq", jq], { allowFailure: true });
  if (result.status !== 0) {
    const diagnostic = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (allowNotFound && /HTTP 404\b/.test(diagnostic)) return null;
    throw new Error(`GitHub API query failed (${result.status}): ${diagnostic.trim().slice(0, 800)}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`GitHub API returned invalid JSON for ${endpoint}`);
  }
}

function tagTarget(repo, tag) {
  let object = queryJson(
    `repos/${repo}/git/ref/tags/${tag}`,
    "{type: .object.type, sha: .object.sha}",
    { allowNotFound: true },
  );
  if (object === null) return null;
  for (let depth = 0; depth < 8; depth += 1) {
    object.sha = checkedSha(object.sha, "tag object SHA");
    if (object.type === "commit") return object.sha;
    if (object.type !== "tag") throw new Error(`${tag} resolves to unsupported Git object ${object.type}`);
    object = queryJson(
      `repos/${repo}/git/tags/${object.sha}`,
      "{type: .object.type, sha: .object.sha}",
    );
  }
  throw new Error(`${tag} exceeds the supported annotated-tag depth`);
}

function releaseState(repo, tag) {
  const release = queryJson(
    `repos/${repo}/releases/tags/${tag}`,
    "{tagName: .tag_name, isDraft: .draft}",
    { allowNotFound: true },
  );
  if (release === null) return "absent";
  if (release.tagName !== tag) throw new Error(`GitHub Release tag mismatch: ${release.tagName}`);
  return release.isDraft ? "draft" : "published";
}

function publishedVersions(repo) {
  const result = gh([
    "api",
    "--method", "GET",
    "--paginate",
    `repos/${repo}/releases?per_page=100`,
    "--jq", ".[] | select(.draft == false) | .tag_name",
  ]);
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter((tag) => /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag))
    .map((tag) => tag.slice(1));
}

function boundedEnvironmentInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

async function waitForPublishedPredecessor(repo, version) {
  const attempts = boundedEnvironmentInteger("RELEASE_PREDECESSOR_ATTEMPTS", 120, 1, 240);
  const delayMs = boundedEnvironmentInteger("RELEASE_PREDECESSOR_DELAY_MS", 15_000, 0, 60_000);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const published = publishedVersions(repo);
    if (published.includes(version)) return published;
    if (attempt === attempts) break;
    process.stderr.write(`waiting for predecessor release v${version} (${attempt}/${attempts})\n`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`predecessor release v${version} was not published after ${attempts} attempts`);
}

function manifestVersionAt(ref) {
  const manifest = JSON.parse(git(["show", `${ref}:package.json`]).stdout);
  return String(manifest.version || "");
}

function assertImmutableMainSource(sourceSha) {
  const head = checkedSha(git(["rev-parse", "HEAD"]).stdout.trim(), "checked-out HEAD");
  if (head !== sourceSha) throw new Error(`checked-out HEAD ${head} does not match source ${sourceSha}`);
  if (git(["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], { allowFailure: true }).status !== 0) {
    throw new Error("origin/main is unavailable in the checkout");
  }
  if (git(["merge-base", "--is-ancestor", sourceSha, "origin/main"], { allowFailure: true }).status !== 0) {
    throw new Error(`git merge-base rejected source ${sourceSha}: it is not contained in origin/main`);
  }
}

function appendOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join("\n") + "\n";
  const output = String(process.env.GITHUB_OUTPUT || "");
  if (output) fs.appendFileSync(output, lines);
  else process.stdout.write(lines);
}

async function resolveCommand() {
  if (process.env.RELEASE_EVENT_NAME !== "push") throw new Error("release intent requires a push event");
  const repo = repository();
  const ref = String(process.env.RELEASE_REF || "");
  const eventSha = checkedSha(process.env.RELEASE_SOURCE_SHA, "release event SHA");
  const checkedOutSha = checkedSha(git(["rev-parse", "HEAD"]).stdout.trim(), "checked-out HEAD");
  const sourceSha = ref.startsWith("refs/tags/") ? checkedOutSha : eventSha;
  assertImmutableMainSource(sourceSha);

  const currentVersion = manifestVersionAt(sourceSha);
  const checkoutVersion = String(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "");
  if (checkoutVersion !== currentVersion) {
    throw new Error(`checked-out package version ${checkoutVersion} does not match immutable source ${currentVersion}`);
  }
  let previousVersion;
  let published;
  if (ref === "refs/heads/main") {
    const beforeSha = checkedSha(process.env.RELEASE_BEFORE_SHA, "push before SHA");
    if (/^0+$/.test(beforeSha)) throw new Error("main release push has no previous source commit");
    if (git(["merge-base", "--is-ancestor", beforeSha, sourceSha], { allowFailure: true }).status !== 0) {
      throw new Error(`push before SHA ${beforeSha} is not an ancestor of source ${sourceSha}`);
    }
    previousVersion = manifestVersionAt(beforeSha);
    published = await waitForPublishedPredecessor(repo, previousVersion);
  } else {
    published = publishedVersions(repo);
  }

  const releaseTag = `v${currentVersion}`;
  const intent = resolveReleaseIntent({
    ref,
    sourceSha,
    currentVersion,
    previousVersion,
    tagTargetSha: tagTarget(repo, releaseTag),
    releaseState: releaseState(repo, releaseTag),
    publishedVersions: published,
  });
  appendOutputs({
    mode: intent.mode,
    release_tag: intent.releaseTag,
    source_sha: intent.sourceSha,
    should_create_tag: intent.shouldCreateTag,
    should_publish: intent.shouldPublish,
  });
}

function createExactTag(repo, tag, sourceSha) {
  const existing = tagTarget(repo, tag);
  if (existing !== null) {
    if (existing !== sourceSha) throw new Error(`${tag} already points at another source commit`);
    return false;
  }
  if (releaseState(repo, tag) !== "absent") {
    throw new Error(`${tag} has a release without its immutable tag`);
  }
  const created = gh([
    "api",
    "--method", "POST",
    `repos/${repo}/git/refs`,
    "-f", `ref=refs/tags/${tag}`,
    "-f", `sha=${sourceSha}`,
  ], { allowFailure: true });
  const target = tagTarget(repo, tag);
  if (target !== sourceSha) {
    const diagnostic = String(created.stderr || created.stdout || "no diagnostic").trim().slice(0, 800);
    throw new Error(`failed to create immutable tag ${tag}: ${diagnostic}`);
  }
  return created.status === 0;
}

function prepareCommand() {
  const repo = repository();
  const tag = String(process.env.RELEASE_TAG || "");
  const sourceSha = checkedSha(process.env.RELEASE_SOURCE_SHA, "release source SHA");
  if (!tag.startsWith("v")) throw new Error(`invalid release tag: ${tag || "missing"}`);
  assertReleaseTag(manifestVersionAt(sourceSha), tag);
  assertImmutableMainSource(sourceSha);
  createExactTag(repo, tag, sourceSha);

  let state = releaseState(repo, tag);
  if (state === "published") {
    appendOutputs({ should_publish: false });
    return;
  }
  if (state === "absent") {
    const created = gh([
      "release", "create", tag,
      "--repo", repo,
      "--draft",
      "--verify-tag",
      "--generate-notes",
      "--title", `Larkin ${tag}`,
    ], { allowFailure: true });
    state = releaseState(repo, tag);
    if (state === "absent") {
      const diagnostic = String(created.stderr || created.stdout || "no diagnostic").trim().slice(0, 800);
      throw new Error(`failed to create draft release ${tag}: ${diagnostic}`);
    }
  }
  appendOutputs({ should_publish: state === "draft" });
}

function assertDraftCommand() {
  const repo = repository();
  const tag = String(process.env.RELEASE_TAG || "");
  const sourceSha = checkedSha(process.env.RELEASE_SOURCE_SHA, "release source SHA");
  assertReleaseTag(manifestVersionAt(sourceSha), tag);
  assertImmutableMainSource(sourceSha);
  if (tagTarget(repo, tag) !== sourceSha) throw new Error(`${tag} no longer points at the immutable release source`);
  if (releaseState(repo, tag) !== "draft") throw new Error(`refusing to modify non-draft release ${tag}`);
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "resolve") await resolveCommand();
  else if (command === "prepare") prepareCommand();
  else if (command === "assert-draft") assertDraftCommand();
  else throw new Error("usage: bun scripts/release/intent.mjs <resolve|prepare|assert-draft>");
}
