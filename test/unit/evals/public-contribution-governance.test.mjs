import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  gradePublicContributionScenario,
  loadPublicContributionGovernanceEval,
  summarizePublicContributionGovernanceEval,
} from "../../support/public-contribution-governance-grader.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DATASET = loadPublicContributionGovernanceEval(path.join(ROOT, "evals/public-contribution-governance/scenarios.json"));

test("public contribution governance eval is versioned with a complete fixed rubric", () => {
  assert.equal(DATASET.subject.policy_version, "larkin-public-contribution-v1");
  assert.equal(DATASET.grader.version, 1);
  assert.equal(DATASET.grader.threshold, 1);
  assert.deepEqual(DATASET.scenarios.map((scenario) => scenario.id), [
    "small-doc-fix-direct-pr", "feature-issue-first", "boundary-change-issue-first",
    "vulnerability-private", "reviewable-pr-evidence", "publication-and-release-safety",
  ]);
});

test("repository contribution artifacts pass every registered governance scenario", () => {
  const result = summarizePublicContributionGovernanceEval(ROOT, DATASET);
  assert.equal(result.passed, true, JSON.stringify(result.results));
  assert.equal(result.pass_rate, 1);
  assert.equal(result.results.every((item) => item.passed), true);
});

test("grader rejects a missing issue-first rule and public vulnerability routing", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-governance-eval-"));
  try {
    for (const scenario of DATASET.scenarios) {
      for (const assertion of scenario.assertions) {
        const source = path.join(ROOT, assertion.file);
        const destination = path.join(temp, assertion.file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
      }
    }
    fs.writeFileSync(path.join(temp, "CONTRIBUTING.md"), "Open a pull request directly for every change.\n");
    fs.writeFileSync(path.join(temp, ".github/ISSUE_TEMPLATE/config.yml"), "blank_issues_enabled: true\n");
    const feature = DATASET.scenarios.find((scenario) => scenario.id === "feature-issue-first");
    const security = DATASET.scenarios.find((scenario) => scenario.id === "vulnerability-private");
    assert.equal(gradePublicContributionScenario(temp, feature).passed, false);
    assert.equal(gradePublicContributionScenario(temp, security).passed, false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
