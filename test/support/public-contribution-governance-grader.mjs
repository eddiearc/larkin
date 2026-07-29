import fs from "node:fs";
import path from "node:path";

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function loadPublicContributionGovernanceEval(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.dataset !== "public-contribution-governance" || value.version !== 1) throw new Error("eval dataset/version mismatch");
  if (value.subject?.kind !== "repository-policy" || value.subject?.policy_version !== "larkin-public-contribution-v1") {
    throw new Error("eval subject metadata mismatch");
  }
  if (value.grader?.name !== "public-contribution-governance-artifact-grader" || value.grader.version !== 1 || value.grader.threshold !== 1) {
    throw new Error("eval grader metadata mismatch");
  }
  if (!Array.isArray(value.grader.rubric) || value.grader.rubric.length < 6) throw new Error("eval rubric is incomplete");
  if (!Array.isArray(value.scenarios) || value.scenarios.length < 6) throw new Error("eval requires six scenarios");
  const ids = new Set();
  for (const [index, scenario] of value.scenarios.entries()) {
    const label = `scenarios[${index}]`;
    const id = nonempty(scenario.id, `${label}.id`);
    if (ids.has(id)) throw new Error(`duplicate scenario id: ${id}`);
    ids.add(id);
    nonempty(scenario.prompt, `${label}.prompt`);
    nonempty(scenario.expected_route, `${label}.expected_route`);
    if (!Array.isArray(scenario.assertions) || scenario.assertions.length === 0) throw new Error(`${label}.assertions is required`);
    for (const assertion of scenario.assertions) {
      nonempty(assertion.file, `${label}.assertions[].file`);
      nonempty(assertion.pattern, `${label}.assertions[].pattern`);
      if (path.isAbsolute(assertion.file) || assertion.file.split("/").includes("..")) throw new Error(`${label} has an unsafe artifact path`);
      new RegExp(assertion.pattern, "i");
    }
  }
  return value;
}

export function gradePublicContributionScenario(root, scenario) {
  const failures = [];
  for (const assertion of scenario.assertions) {
    const file = path.join(root, assertion.file);
    let content = "";
    try { content = fs.readFileSync(file, "utf8"); }
    catch { failures.push({ rule: "artifact_available", file: assertion.file }); continue; }
    if (!new RegExp(assertion.pattern, "i").test(content)) failures.push({ rule: "required_policy_evidence", file: assertion.file });
  }
  return { id: scenario.id, route: scenario.expected_route, passed: failures.length === 0, failures };
}

export function summarizePublicContributionGovernanceEval(root, dataset) {
  const results = dataset.scenarios.map((scenario) => gradePublicContributionScenario(root, scenario));
  const passRate = results.filter((result) => result.passed).length / results.length;
  return { passed: passRate >= dataset.grader.threshold, pass_rate: passRate, threshold: dataset.grader.threshold, results };
}
