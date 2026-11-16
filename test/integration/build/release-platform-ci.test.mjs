import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const GITLEAKS_BASELINE = [
  "26a9006be595b4bc86b851d797bbc58bb815a772:test/unit/app/runtime-agent-interface-v2-live-safety.test.mjs:generic-api-key:202",
  "1e12236e5462a361cf45e1b1b218aae035ed7451:test/unit/app/runtime-agent-interface-v2-live-safety.test.mjs:generic-api-key:138",
];

test("PR and main CI retain Linux source checks and add a blocking native Windows x64 gate", () => {
  const workflow = read(".github/workflows/release-platform-smoke.yml");
  const windowsJob = workflow.slice(workflow.indexOf("  windows-native:"));
  const releaseSmoke = read("scripts/release/smoke.ts");
  assert.equal(read(".gitleaksignore"), `${GITLEAKS_BASELINE.join("\n")}\n`, "only the two verified synthetic history fingerprints may be ignored");
  assert.equal(fs.existsSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md")), false, "complete lock-graph notices must not be tracked at the repository root");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\n\s+branches:\n\s+- main/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+pull-requests: read/);
  assert.equal(workflow.match(/runs-on: ubuntu-24\.04/g)?.length, 2);
  assert.equal(workflow.match(/runs-on: windows-latest/g)?.length, 1);
  assert.deepEqual(JSON.parse(read("package.json")).trustedDependencies ?? [], []);
  assert.equal(workflow.match(/bun-version: 1\.4\.4/g)?.length, 3);
  assert.doesNotMatch(workflow, /actions\/setup-go|go-version:/);
  assert.equal(workflow.match(/bun install --frozen-lockfile/g)?.length, 3);
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
  assert.match(workflow, /LARKIN_RUN_OFFICIAL_LARK_CHANNEL_BIND: "1"/);
  assert.match(workflow, /bun test --max-concurrency 1 test\/integration\/app\/official-lark-channel-bind-live\.test\.mjs/);
  assert.match(workflow, /windows-release-artifact:[\s\S]*bun scripts\/release\/build\.ts --target windows-x64 --out-dir artifacts\/release[\s\S]*actions\/upload-artifact@v4/);
  assert.match(workflow, /windows-native:\n\s+name: Windows 11 x64 core and standalone gate\n\s+needs: windows-release-artifact\n\s+runs-on: windows-latest/);
  assert.match(windowsJob, /bun run build/);
  const expectedWindowsTestInputs = [
    "test/unit/agent/host-reminder-orchestrator.test.mjs",
    "test/unit/feishu/host-business-state.test.mjs",
    "test/unit/feishu/host-runtime-delivery-health.test.mjs",
    "test/unit/platform/release-artifacts.test.mjs",
    "test/unit/runtime/pi-tmux-bash-discovery.test.mjs",
    "test/unit/runtime/runtime-adapters.test.mjs",
    "test/unit/runtime/runtime-inbox-target.test.mjs",
    "test/integration/build/runtime-clean-cutover.test.mjs",
    "test/integration/build/runtime-upgrade-in-place.test.mjs",
    "test/integration/build/release-smoke-candidate-root.test.mjs",
    "test/e2e/issue124-thread-runtime-envelope-e2e.test.mjs",
    "test/integration/build/release-platform-ci.test.mjs",
  ];
  const focusedWindowsCommand = windowsJob.split("\n").map((line) => line.trim())
    .find((line) => line.startsWith("run: bun test --isolate --max-concurrency 1 "));
  assert.equal(focusedWindowsCommand,
    `run: bun test --isolate --max-concurrency 1 ${expectedWindowsTestInputs.join(" ")}`,
    "the native Windows gate keeps the exact focused coverage contract");
  for (const issue122Test of [
    "test/unit/agent/host-reminder-orchestrator.test.mjs",
    "test/unit/feishu/host-business-state.test.mjs",
    "test/unit/runtime/runtime-inbox-target.test.mjs",
  ]) assert.ok(expectedWindowsTestInputs.includes(issue122Test), `${issue122Test} covers issue 122 natively`);
  for (const issue124Test of [
    "test/unit/feishu/host-runtime-delivery-health.test.mjs",
    "test/integration/build/runtime-upgrade-in-place.test.mjs",
    "test/integration/build/release-smoke-candidate-root.test.mjs",
    "test/e2e/issue124-thread-runtime-envelope-e2e.test.mjs",
  ]) assert.ok(expectedWindowsTestInputs.includes(issue124Test), `${issue124Test} covers issue 124 natively`);
  assert.match(releaseSmoke, /v0\.3\.3-active-thread\.json/);
  assert.match(releaseSmoke, /LARKIN_RELEASE_CANDIDATE_ROOT/);
  assert.match(releaseSmoke, /pathToFileURL/);
  assert.match(releaseSmoke, /loadCandidateRuntimeUpgradeModules/);
  assert.doesNotMatch(releaseSmoke, /from "\.\.\/\.\.\/dist\//);
  assert.match(releaseSmoke, /createRuntimeHost/);
  assert.match(releaseSmoke, /candidate Runtime did not migrate the active targetless v0\.3\.3 ledger/);
  assert.match(releaseSmoke, /artifact v0\.3\.3 same-home upgrade state/);
  assert.match(releaseSmoke, /read-only artifact upgrade check mutated candidate Runtime state/);
  for (const broadProblematicTest of [
    "test/unit/agent/inbox-projection.test.mjs",
    "test/unit/runtime/runtime-host.test.mjs",
  ]) assert.equal(expectedWindowsTestInputs.includes(broadProblematicTest), false,
    `${broadProblematicTest} is not a standalone native Windows input`);
  assert.match(windowsJob, /actions\/download-artifact@v4[\s\S]*bun run release:smoke -- --release-dir artifacts\/release/);
  assert.doesNotMatch(windowsJob, /secrets\.|LARKIN_RUN_OFFICIAL_LARK_CHANNEL_BIND|test\/live|continue-on-error/);
  assert.match(workflow, /fetch-depth: 0\n\s+persist-credentials: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /matrix\.|continue-on-error|\b(?:node|npm|pnpm)\b/);
});

test("package version and explicit tag publication share one immutable combined-release run", () => {
  const workflow = read(".github/workflows/release.yml");
  const verifyWindowsJob = workflow.slice(workflow.indexOf("  verify-windows-release:"), workflow.indexOf("  publish:"));
  const intent = read("scripts/release/intent.mjs");
  assert.equal(fs.existsSync(path.join(ROOT, ".github/workflows/bump-patch-version.yml")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "scripts/bump-patch-version.mjs")), false);
  assert.match(workflow, /branches:\n\s+- main/);
  assert.match(workflow, /tags:\n\s+- "v\*\.\*\.\*"/);
  assert.match(workflow, /paths:\n\s+- package\.json/);
  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+release_tag:[\s\S]*required: true[\s\S]*source_sha:[\s\S]*required: true/);
  assert.match(workflow, /group: publish-release-\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.source_sha \|\| github\.sha \}\}/);
  assert.doesNotMatch(workflow, /group: publish-release\n/);
  assert.match(workflow, /resolve-release:/);
  assert.match(workflow, /timeout-minutes: 40/);
  assert.match(workflow, /RELEASE_PREDECESSOR_ATTEMPTS: "120"/);
  assert.match(workflow, /RELEASE_PREDECESSOR_DELAY_MS: "15000"/);
  assert.match(workflow, /RELEASE_TAG_VISIBILITY_ATTEMPTS: "15"/);
  assert.match(workflow, /RELEASE_TAG_VISIBILITY_DELAY_MS: "2000"/);
  assert.match(workflow, /RELEASE_VISIBILITY_ATTEMPTS: "15"/);
  assert.match(workflow, /RELEASE_VISIBILITY_DELAY_MS: "2000"/);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}[\s\S]*path: release-tooling/);
  assert.match(workflow, /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.source_sha \|\| github\.sha \}\}[\s\S]*path: release-source/);
  assert.match(workflow, /RELEASE_SOURCE_ROOT: \$\{\{ github\.workspace \}\}\/release-source/);
  assert.match(workflow, /RELEASE_REF: \$\{\{ github\.event_name == 'workflow_dispatch' && format\('refs\/tags\/\{0\}', inputs\.release_tag\) \|\| github\.ref \}\}/);
  assert.match(workflow, /bun "\$GITHUB_WORKSPACE\/release-tooling\/scripts\/release\/intent\.mjs" resolve/);
  assert.match(workflow, /bun "\$GITHUB_WORKSPACE\/release-tooling\/scripts\/release\/intent\.mjs" prepare/);
  assert.equal(workflow.match(/bun "\$GITHUB_WORKSPACE\/release-tooling\/scripts\/release\/intent\.mjs" assert-draft/g)?.length, 2);
  assert.match(workflow, /source_sha: \$\{\{ steps\.intent\.outputs\.source_sha \}\}/);
  // Recovering an older candidate must not install today's Bun into source that pins another one.
  assert.ok(
    workflow.includes(`jq -er '.packageManager | select(type == "string" and test("^bun@[0-9]+\\\\.[0-9]+\\\\.[0-9]+\\\\z")) | sub("^bun@"; "")' release-source/package.json`),
    "candidate Bun must be taken from the original packageManager string",
  );
  assert.equal(workflow.match(/bun-version: 1\.4\.4/g)?.length, 2, "only resolve-release and prepare-release run tooling-only Bun");
  assert.equal(workflow.match(/bun-version: \$\{\{ needs\.resolve-release\.outputs\.candidate_bun_version \}\}/g)?.length, 5);
  assert.ok((workflow.match(/ref: \$\{\{ needs\.resolve-release\.outputs\.source_sha \}\}/g) ?? []).length >= 4);
  assert.match(workflow, /RELEASE_TAG: \$\{\{ needs\.resolve-release\.outputs\.release_tag \}\}/);
  assert.match(workflow, /should_publish: \$\{\{ steps\.prepare\.outputs\.should_publish \}\}/);
  assert.match(workflow, /needs\.prepare-release\.outputs\.should_publish == 'true'/);
  assert.match(intent, /refs\/heads\/main/);
  assert.match(intent, /refs\/tags\//);
  assert.match(intent, /git\(\["merge-base", "--is-ancestor"/);
  assert.match(intent, /repos\/\$\{repo\}\/git\/refs/);
  assert.match(intent, /"release", "create", tag/);
  assert.match(intent, /refusing to modify non-draft release/);
  assert.match(intent, /waitForPublishedPredecessor/);
  assert.match(intent, /waitForExactTagVisibility/);
  assert.match(intent, /waitForReleaseVisibility/);
  assert.match(intent, /repos\/\$\{repo\}\/releases\?per_page=100/);
  assert.doesNotMatch(intent, /releases\/tags/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /git show-ref --verify --quiet refs\/remotes\/origin\/main/);
  assert.match(workflow, /bun run release:check-version "\$RELEASE_TAG"/);
  assert.match(workflow, /bun run test/);
  assert.match(workflow, /bun run licenses:check/);
  assert.doesNotMatch(workflow, /actions\/setup-go|go-version:/);
  assert.match(workflow, /secrets\.LARKIN_PUBLICATION_DENYLIST/);
  assert.match(workflow, /--trusted --denylist "\$RUNNER_TEMP\/larkin-publication-denylist\.txt"/);
  assert.match(workflow, /gitleaks\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3/);
  assert.match(workflow, /name: Check out recovery secret baseline\n\s+if: github\.event_name == 'workflow_dispatch'[\s\S]*ref: \$\{\{ github\.workflow_sha \}\}[\s\S]*path: release-tooling[\s\S]*sparse-checkout: \.gitleaksignore[\s\S]*sparse-checkout-cone-mode: false/);
  assert.match(workflow, /name: Apply exact recovery secret baseline\n\s+id: recovery-secret-baseline\n\s+if: github\.event_name == 'workflow_dispatch'[\s\S]*git ls-files --error-unmatch \.gitleaksignore[\s\S]*cp -- \.gitleaksignore "\$RUNNER_TEMP\/larkin-source-gitleaksignore"[\s\S]*source_baseline=present[\s\S]*source_baseline=absent[\s\S]*cp -- "\$GITHUB_WORKSPACE\/release-tooling\/\.gitleaksignore" "\$GITHUB_WORKSPACE\/\.gitleaksignore"/);
  assert.match(workflow, /name: Restore immutable source secret baseline\n\s+if: always\(\) && github\.event_name == 'workflow_dispatch'[\s\S]*SOURCE_BASELINE: \$\{\{ steps\.recovery-secret-baseline\.outputs\.source_baseline \}\}[\s\S]*present\)[\s\S]*cp -- "\$RUNNER_TEMP\/larkin-source-gitleaksignore" \.gitleaksignore[\s\S]*absent\)[\s\S]*rm -f -- \.gitleaksignore/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}\n\s+GITLEAKS_ENABLE_UPLOAD_ARTIFACT: false/);
  assert.match(workflow, /GITLEAKS_ENABLE_UPLOAD_ARTIFACT: false[\s\S]*- name: Remove Gitleaks SARIF output\n\s+run: rm -f -- results\.sarif/);
  assert.equal(workflow.match(/rm -f -- results\.sarif/g)?.length, 1, "only the generated Gitleaks SARIF path may be removed");
  assert.ok(workflow.indexOf("gitleaks/gitleaks-action@") < workflow.indexOf("run: rm -f -- results.sarif"));
  assert.ok(workflow.indexOf("- name: Verify public source, refs, and history") < workflow.indexOf("- name: Check out recovery secret baseline"));
  assert.ok(workflow.indexOf("- name: Apply exact recovery secret baseline") < workflow.indexOf("gitleaks/gitleaks-action@"));
  assert.ok(workflow.indexOf("gitleaks/gitleaks-action@") < workflow.indexOf("- name: Restore immutable source secret baseline"));
  assert.ok(workflow.indexOf("- name: Restore immutable source secret baseline") < workflow.indexOf("- name: Run full test suite"));
  assert.ok(workflow.indexOf("run: rm -f -- results.sarif") < workflow.indexOf("- name: Build current platform release"));
  assert.match(workflow, /bun run scripts\/check-publication\.mjs --trusted --denylist "\$RUNNER_TEMP\/larkin-publication-denylist\.txt" artifacts\/release\/larkin-v\*/);
  assert.match(workflow, /artifacts\/release\/larkin-v\* artifacts\/release\/THIRD_PARTY_NOTICES\.txt/);
  for (const target of ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "windows-x64"]) {
    assert.match(workflow, new RegExp(`target: ${target}`));
  }
  assert.match(workflow, /gh release upload/);
  assert.doesNotMatch(workflow, /gh release download|--clobber/);
  assert.match(workflow, /build:[\s\S]*github\.event_name != 'workflow_dispatch'/);
  assert.match(workflow, /assemble-release:[\s\S]*always\(\)[\s\S]*needs\.build\.result == 'skipped'/);
  assert.match(workflow, /assemble-release:[\s\S]*permissions:\n\s+# GitHub hides draft releases and their assets from read-only workflow tokens\.\n\s+contents: write/);
  assert.match(workflow, /repos\/\$\{GITHUB_REPOSITORY\}\/releases\?per_page=100/);
  assert.match(workflow, /repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{release_id\}\/assets\?per_page=100/);
  assert.match(workflow, /repos\/\$\{GITHUB_REPOSITORY\}\/releases\/assets\/\$\{asset_ids\[0\]\}/);
  assert.match(workflow, /Expected exactly one uploaded draft asset named \$asset_name/);
  assert.match(workflow, /assemble-release:[\s\S]*bun scripts\/release\/assemble\.ts[\s\S]*actions\/upload-artifact@v4/);
  assert.match(workflow, /verify-windows-release:[\s\S]*always\(\)[\s\S]*needs\.assemble-release\.result == 'success'[\s\S]*runs-on: windows-latest/);
  assert.match(workflow, /verify-windows-release:[\s\S]*ref: \$\{\{ github\.workflow_sha \}\}[\s\S]*path: release-tooling[\s\S]*actions\/download-artifact@v4[\s\S]*Get-FileHash[\s\S]*release-tooling\/scripts\/release\/smoke\.ts" --release-dir artifacts\/release/);
  assert.match(verifyWindowsJob, /name: Verify immutable source, Windows manifest, and SHA256SUMS[\s\S]*Get-FileHash[\s\S]*name: Build exact immutable candidate source for Runtime upgrade smoke\n\s+run: bun run build[\s\S]*name: Smoke exact assembled Windows executable natively\n\s+env:\n\s+LARKIN_RELEASE_CANDIDATE_ROOT: \$\{\{ github\.workspace \}\}\/release-source\n\s+run: bun "\$\{\{ github\.workspace \}\}\/release-tooling\/scripts\/release\/smoke\.ts" --release-dir artifacts\/release/);
  assert.equal(verifyWindowsJob.match(/bun run build/g)?.length, 1, "the recovery Windows gate builds the exact candidate once before smoke");
  assert.ok(verifyWindowsJob.indexOf("Verify immutable source, Windows manifest, and SHA256SUMS")
    < verifyWindowsJob.indexOf("Build exact immutable candidate source for Runtime upgrade smoke"));
  assert.ok(verifyWindowsJob.indexOf("Build exact immutable candidate source for Runtime upgrade smoke")
    < verifyWindowsJob.indexOf("Smoke exact assembled Windows executable natively"));
  assert.match(workflow, /publish:[\s\S]*- verify-windows-release[\s\S]*always\(\)[\s\S]*needs\.verify-windows-release\.result == 'success'[\s\S]*Download Windows-verified assembled release[\s\S]*Finalize GitHub release/);
  assert.ok(workflow.indexOf("  verify-windows-release:") < workflow.indexOf("  publish:"));
  assert.match(workflow, /gh release edit[\s\S]*--draft=false/);
  assert.match(workflow, /bun scripts\/release\/assemble\.ts/);
  assert.match(workflow, /artifacts\/release\/LICENSE artifacts\/release\/THIRD_PARTY_NOTICES\.txt/);
  assert.match(workflow, /publish:\n[\s\S]*permissions:\n\s+contents: write/);
  assert.doesNotMatch(workflow, /git (?:commit|push)|continue-on-error|\bnode\b|\bpnpm\b|\bnpm (?:i|install|ci|run|publish|config|version|exec|link|uninstall)\b/);
  assert.doesNotMatch(intent, /git push|--force/);
});

function workflowStepRun(file, stepId) {
  const text = read(file);
  const marker = `id: ${stepId}\n`;
  const at = text.indexOf(marker);
  assert.notEqual(at, -1, stepId);
  const after = text.slice(at + marker.length);
  const header = after.match(/^        run: \|\n/);
  assert.ok(header, `${file} ${stepId} run block`);
  const lines = [];
  for (const line of after.slice(header[0].length).split("\n")) {
    if (line.startsWith("          ")) lines.push(line.slice(10));
    else if (line === "") lines.push("");
    else break;
  }
  while (lines.at(-1) === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

// release.yml and npm-publish.yml run these selectors on ubuntu-24.04.
// Windows has no /bin/bash. Git Bash is not that shell and does not provide the workflow jq.
function workflowShellDetail(result) {
  const error = result.error ? `${result.error.code ?? "ERR"}: ${result.error.message}` : "none";
  return `status=${result.status} signal=${result.signal ?? "none"} error=${error}\nstderr:\n${result.stderr ?? ""}\nstdout:\n${result.stdout ?? ""}`;
}

test("release and npm workflows encode the original packageManager pin in jq", () => {
  const originalPin = 'select(type == "string" and test("^bun@[0-9]+\\\\.[0-9]+\\\\.[0-9]+\\\\z")) | sub("^bun@"; "")';
  const steps = [
    [".github/workflows/release.yml", "candidate-bun"],
    [".github/workflows/npm-publish.yml", "release-bun"],
  ];
  for (const [file, stepId] of steps) {
    const script = workflowStepRun(file, stepId);
    assert.ok(script.includes("jq -er "), `${file} validates the original JSON string before shell normalization`);
    assert.ok(script.includes(originalPin), file);
    assert.equal(script.includes("=~"), false, `${file} must not validate the pin after command substitution`);
    assert.equal(script.includes(".packageManager // empty"), false, `${file} must not read an unvalidated raw string`);
  }
});

test.skipIf(!["linux", "darwin"].includes(process.platform))("release and npm workflows accept only an exact bun@X.Y.Z pin before stripping it (Linux and macOS only; Windows has no Ubuntu bash or workflow jq)", () => {
  const steps = [
    [".github/workflows/release.yml", "candidate-bun", "release-source/package.json"],
    [".github/workflows/npm-publish.yml", "release-bun", "package.json"],
  ];
  const cases = [
    ["bun1314", { packageManager: "bun@1.3.14" }, "1.3.14"],
    ["bun144", { packageManager: "bun@1.4.4" }, "1.4.4"],
    ["missing", {}, null],
    ["null", { packageManager: null }, null],
    ["bool", { packageManager: false }, null],
    ["empty", { packageManager: "" }, null],
    ["partial", { packageManager: "bun@1.4" }, null],
    ["other", { packageManager: "npm@1.3.14" }, null],
    ["bare", { packageManager: "1.3.14" }, null],
    ["injection", { packageManager: "bun@1.3.14; touch injected" }, null],
    ["substitution", { packageManager: "bun@$(touch injected)" }, null],
    ["trailing-lf", { packageManager: "bun@1.3.14\n" }, null],
    ["multi-lf", { packageManager: "bun@1.3.14\n\n" }, null],
    ["crlf", { packageManager: "bun@1.3.14\r\n" }, null],
    ["newline", { packageManager: "bun@1.3.14\nversion=1.4.4" }, null],
    ["number", { packageManager: 134 }, null],
    ["array", { packageManager: ["bun@1.3.14"] }, null],
    ["object", { packageManager: { name: "bun", version: "1.3.14" } }, null],
    ["malformed", "{", null],
    ["no-file", undefined, null],
  ];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-bun-pin-"));
  try {
    for (const [file, stepId, packagePath] of steps) {
      const script = workflowStepRun(file, stepId);
      for (const [label, data, expected] of cases) {
        const dir = path.join(root, stepId, label);
        fs.mkdirSync(path.dirname(path.join(dir, packagePath)), { recursive: true });
        if (data !== undefined) {
          fs.writeFileSync(path.join(dir, packagePath), typeof data === "string" ? data : `${JSON.stringify(data)}\n`);
        }
        const output = path.join(dir, "github-output");
        fs.writeFileSync(output, "");
        const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
          cwd: dir,
          env: { ...process.env, GITHUB_OUTPUT: output },
          encoding: "utf8",
        });
        const detail = `${stepId} ${label}\n${workflowShellDetail(result)}`;
        if (result.error || result.status === null) {
          assert.fail(`${detail}\n/bin/bash did not start. A missing shell is not a packageManager result.`);
        }
        if (/command not found/.test(`${result.stderr ?? ""}\n${result.stdout ?? ""}`)) {
          assert.fail(`${detail}\njq or another required tool is missing. A tool failure is not a rejected pin.`);
        }
        assert.equal(fs.existsSync(path.join(dir, "injected")), false, `${stepId} ${label} executed shell from the pin`);
        if (expected === null) {
          assert.notEqual(result.status, 0, `${stepId} ${label} should reject\n${detail}`);
          continue;
        }
        assert.equal(result.status, 0, `${stepId} ${label} should accept\n${detail}`);
        assert.equal(fs.readFileSync(output, "utf8"), `version=${expected}\n`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
