import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("PR and main CI validate source without building release artifacts", () => {
  const workflow = read(".github/workflows/release-platform-smoke.yml");
  assert.equal(fs.existsSync(path.join(ROOT, ".gitleaksignore")), false, "synthetic secrets must be constructed at runtime without fingerprint exceptions");
  assert.equal(fs.existsSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md")), false, "complete lock-graph notices must not be tracked at the repository root");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\n\s+branches:\n\s+- main/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+pull-requests: read/);
  assert.equal(workflow.match(/runs-on: ubuntu-24\.04/g)?.length, 1);
  assert.deepEqual(JSON.parse(read("package.json")).trustedDependencies, []);
  assert.match(workflow, /bun-version: 1\.3\.14/);
  assert.doesNotMatch(workflow, /actions\/setup-go|go-version:/);
  assert.match(workflow, /bun install --frozen-lockfile/);
  assert.match(workflow, /bun run licenses:check/);
  assert.match(workflow, /bun run publication:check:tree/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name != github\.repository/);
  assert.match(workflow, /if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository[\s\S]{0,160}secrets\.LARKIN_PUBLICATION_DENYLIST/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /--trusted --denylist "\$RUNNER_TEMP\/larkin-publication-denylist\.txt"/);
  assert.match(workflow, /gitleaks\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}\n\s+GITLEAKS_ENABLE_UPLOAD_ARTIFACT: false/);
  assert.match(workflow, /GITLEAKS_ENABLE_UPLOAD_ARTIFACT: false\n\n\s+- name: Remove Gitleaks SARIF output\n\s+run: rm -f -- results\.sarif/);
  assert.equal(workflow.match(/rm -f -- results\.sarif/g)?.length, 1, "only the generated Gitleaks SARIF path may be removed");
  assert.ok(workflow.indexOf("gitleaks/gitleaks-action@") < workflow.indexOf("run: rm -f -- results.sarif"));
  assert.ok(workflow.indexOf("run: rm -f -- results.sarif") < workflow.indexOf("- name: Run full test suite"));
  assert.match(workflow, /run: bun run test/);
  assert.match(workflow, /fetch-depth: 0\n\s+persist-credentials: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /scripts\/release\/build\.ts|release:smoke|artifacts\/release|matrix\./);
  assert.doesNotMatch(workflow, /continue-on-error|actions\/(?:upload|download)-artifact|\b(?:node|npm|pnpm)\b/);
});

test("tag publication validates an explicit version and publishes one combined release", () => {
  const workflow = read(".github/workflows/release.yml");
  assert.equal(fs.existsSync(path.join(ROOT, ".github/workflows/bump-patch-version.yml")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "scripts/bump-patch-version.mjs")), false);
  assert.match(workflow, /tags:\n\s+- "v\*\.\*\.\*"/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /git show-ref --verify --quiet refs\/remotes\/origin\/main/);
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  assert.match(workflow, /bun run release:check-version "\$\{GITHUB_REF_NAME\}"/);
  assert.match(workflow, /bun run test/);
  assert.match(workflow, /bun run licenses:check/);
  assert.doesNotMatch(workflow, /actions\/setup-go|go-version:/);
  assert.match(workflow, /secrets\.LARKIN_PUBLICATION_DENYLIST/);
  assert.match(workflow, /--trusted --denylist "\$RUNNER_TEMP\/larkin-publication-denylist\.txt"/);
  assert.match(workflow, /gitleaks\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}\n\s+GITLEAKS_ENABLE_UPLOAD_ARTIFACT: false/);
  assert.match(workflow, /GITLEAKS_ENABLE_UPLOAD_ARTIFACT: false\n\n\s+- name: Remove Gitleaks SARIF output\n\s+run: rm -f -- results\.sarif/);
  assert.equal(workflow.match(/rm -f -- results\.sarif/g)?.length, 1, "only the generated Gitleaks SARIF path may be removed");
  assert.ok(workflow.indexOf("gitleaks/gitleaks-action@") < workflow.indexOf("run: rm -f -- results.sarif"));
  assert.ok(workflow.indexOf("run: rm -f -- results.sarif") < workflow.indexOf("- name: Build current platform release"));
  assert.match(workflow, /bun run scripts\/check-publication\.mjs --trusted --denylist "\$RUNNER_TEMP\/larkin-publication-denylist\.txt" artifacts\/release\/larkin-v\*/);
  assert.match(workflow, /artifacts\/release\/larkin-v\* artifacts\/release\/THIRD_PARTY_NOTICES\.txt/);
  for (const target of ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"]) {
    assert.match(workflow, new RegExp(`target: ${target}`));
  }
  assert.match(workflow, /gh release create[\s\S]*--draft/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /gh release download/);
  assert.match(workflow, /gh release edit[\s\S]*--draft=false/);
  assert.match(workflow, /bun scripts\/release\/assemble\.ts/);
  assert.match(workflow, /artifacts\/release\/LICENSE artifacts\/release\/THIRD_PARTY_NOTICES\.txt/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /publish:\n[\s\S]*permissions:\n\s+contents: write/);
  assert.doesNotMatch(workflow, /git (?:commit|push)|continue-on-error|\b(?:node|npm|pnpm)\b/);
});
