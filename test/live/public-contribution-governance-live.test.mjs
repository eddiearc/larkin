import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";

const ENABLED = process.env.LARKIN_RUN_PUBLIC_CONTRIBUTION_GOVERNANCE_LIVE === "1";
const REPOSITORY = process.env.LARKIN_GITHUB_REPOSITORY || "eddiearc/larkin";
const SKIP_REASON = "set LARKIN_RUN_PUBLIC_CONTRIBUTION_GOVERNANCE_LIVE=1 with authenticated gh after merge";

function api(path) {
  const result = spawnSync("gh", ["api", path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function defaultBranchContent(relative) {
  const value = api(`repos/${REPOSITORY}/contents/${relative}?ref=main`);
  assert.equal(value.encoding, "base64", `${relative} must be a regular default-branch file`);
  return Buffer.from(value.content, "base64").toString("utf8");
}

test.skipIf(!ENABLED)(`public GitHub contribution workflow is installed and protected (${SKIP_REASON})`, () => {
  const repository = api(`repos/${REPOSITORY}`);
  assert.equal(repository.private, false);
  assert.equal(repository.default_branch, "main");
  assert.equal(repository.has_issues, true);

  const expected = new Map([
    [".github/ISSUE_TEMPLATE/bug_report.yml", /This is not a vulnerability/],
    [".github/ISSUE_TEMPLATE/feature_request.yml", /wait for maintainer alignment/],
    [".github/ISSUE_TEMPLATE/config.yml", /security\/advisories\/new/],
    [".github/pull_request_template.md", /Small-change exemption/],
    ["CONTRIBUTING.md", /Open an issue and wait for maintainer alignment/],
  ]);
  for (const [file, pattern] of expected) assert.match(defaultBranchContent(file), pattern, file);

  const privateReporting = api(`repos/${REPOSITORY}/private-vulnerability-reporting`);
  assert.equal(privateReporting.enabled, true);

  const protection = api(`repos/${REPOSITORY}/branches/main/protection`);
  assert.equal(protection.required_status_checks.strict, true);
  assert.equal(protection.required_status_checks.contexts.includes("source-checks"), true);
  assert.equal(protection.enforce_admins.enabled, true);
  assert.equal(protection.required_pull_request_reviews.required_approving_review_count, 0);
  assert.equal(protection.required_conversation_resolution.enabled, true);
  assert.equal(protection.allow_force_pushes.enabled, false);
  assert.equal(protection.allow_deletions.enabled, false);
});
