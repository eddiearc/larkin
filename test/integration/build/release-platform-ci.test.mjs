import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("release platform CI strictly builds and smokes every supported runner architecture", () => {
  const workflow = read(".github/workflows/release-platform-smoke.yml");
  const smoke = read("scripts/release/smoke.ts");
  for (const [runner, target] of [
    ["ubuntu-24.04", "linux-x64"],
    ["ubuntu-24.04-arm", "linux-arm64"],
    ["macos-15", "darwin-arm64"],
    ["macos-15-intel", "darwin-x64"],
  ]) {
    assert.match(workflow, new RegExp(`runner: ${runner.replaceAll(".", "\\.")}\\n\\s+target: ${target}`));
  }
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\n\s+branches:\n\s+- main/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+pull-requests: read/);
  assert.deepEqual(JSON.parse(read("package.json")).trustedDependencies, ["@larksuite/cli"]);
  assert.match(workflow, /bun-version: 1\.3\.14/);
  assert.match(workflow, /bun install --frozen-lockfile/);
  assert.match(workflow, /bun run licenses:check/);
  assert.match(workflow, /bun run publication:check:tree/);
  assert.match(workflow, /if: matrix\.full_test && github\.event_name == 'pull_request'/);
  assert.match(workflow, /if: github\.event_name != 'pull_request'[\s\S]{0,160}secrets\.LARKIN_PUBLICATION_DENYLIST/);
  assert.match(workflow, /--trusted --denylist "\$RUNNER_TEMP\/larkin-publication-denylist\.txt"/);
  assert.match(workflow, /gitleaks\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}\n\s+GITLEAKS_ENABLE_UPLOAD_ARTIFACT: false/);
  assert.match(workflow, /GITLEAKS_ENABLE_UPLOAD_ARTIFACT: false\n\n\s+- name: Remove Gitleaks SARIF output\n\s+if: matrix\.full_test\n\s+run: rm -f -- results\.sarif/);
  assert.equal(workflow.match(/rm -f -- results\.sarif/g)?.length, 1, "only the generated Gitleaks SARIF path may be removed");
  assert.ok(workflow.indexOf("gitleaks/gitleaks-action@") < workflow.indexOf("run: rm -f -- results.sarif"));
  assert.ok(workflow.indexOf("run: rm -f -- results.sarif") < workflow.indexOf("- name: Build current platform release"));
  assert.match(workflow, /if: matrix\.full_test\n\s+run: bun run test/);
  assert.match(workflow, /bun scripts\/release\/build\.ts --target "\$\{\{ matrix\.target \}\}" --out-dir artifacts\/release/);
  assert.match(workflow, /fetch-depth: 0\n\s+persist-credentials: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /bun run release:smoke -- --release-dir artifacts\/release/);
  assert.match(workflow, /bun run scripts\/check-publication\.mjs --tree-only artifacts\/release\/larkin-v\*/);
  assert.doesNotMatch(workflow, /continue-on-error|actions\/(?:upload|download)-artifact|\b(?:node|npm|pnpm)\b/);

  assert.match(smoke, /selectReleaseArtifact\(manifest, platform, arch\)/);
  assert.match(smoke, /verifyReleaseArtifact\(releaseDir, record\)/);
  assert.match(smoke, /PATH: restrictedBin/);
  assert.match(smoke, /\["--version"\]/);
  assert.match(smoke, /\["--help"\]/);
  assert.match(smoke, /\["__internal", "dashboard"/);
  assert.match(smoke, /response\.status === 200/);
  assert.match(smoke, /fs\.rmSync\(temporaryRoot, \{ recursive: true, force: true \}\)/);
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
  assert.match(workflow, /secrets\.LARKIN_PUBLICATION_DENYLIST/);
  assert.match(workflow, /--trusted --denylist "\$RUNNER_TEMP\/larkin-publication-denylist\.txt"/);
  assert.match(workflow, /gitleaks\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}\n\s+GITLEAKS_ENABLE_UPLOAD_ARTIFACT: false/);
  assert.match(workflow, /GITLEAKS_ENABLE_UPLOAD_ARTIFACT: false\n\n\s+- name: Remove Gitleaks SARIF output\n\s+run: rm -f -- results\.sarif/);
  assert.equal(workflow.match(/rm -f -- results\.sarif/g)?.length, 1, "only the generated Gitleaks SARIF path may be removed");
  assert.ok(workflow.indexOf("gitleaks/gitleaks-action@") < workflow.indexOf("run: rm -f -- results.sarif"));
  assert.ok(workflow.indexOf("run: rm -f -- results.sarif") < workflow.indexOf("- name: Build current platform release"));
  assert.match(workflow, /bun run scripts\/check-publication\.mjs --trusted --denylist "\$RUNNER_TEMP\/larkin-publication-denylist\.txt" artifacts\/release\/larkin-v\*/);
  for (const target of ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"]) {
    assert.match(workflow, new RegExp(`target: ${target}`));
  }
  assert.match(workflow, /gh release create[\s\S]*--draft/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /gh release download/);
  assert.match(workflow, /gh release edit[\s\S]*--draft=false/);
  assert.match(workflow, /bun scripts\/release\/assemble\.ts/);
  assert.match(workflow, /artifacts\/release\/LICENSE artifacts\/release\/THIRD_PARTY_NOTICES\.md/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /publish:\n[\s\S]*permissions:\n\s+contents: write/);
  assert.doesNotMatch(workflow, /git (?:commit|push)|continue-on-error|\b(?:node|npm|pnpm)\b/);
});
