import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SELF = path.relative(ROOT, import.meta.filename);
// Bun workers do not expose the individual test filename in their process command.
// Only these process-ownership tests may opt into the production seam that substitutes
// the Bun executable token; keeping the list exact prevents a hidden global test mode.
const BUN_RUNNER_SEAM_ALLOWLIST = [
  "src/platform/process-inspect.cts",
  "test/integration/app/runtime-profile-rollback.test.mjs",
  "test/integration/platform/process-idempotency.test.mjs",
  "test/integration/platform/process-ownership.test.mjs",
  "test/unit/agent/agent-state-store.test.mjs",
  "test/unit/app/runtime-agent-interface-v2-live-safety.test.mjs",
].sort();

function currentFiles() {
  const files = ["package.json", "README.md"];
  const visit = (relative) => {
    const absolute = path.join(ROOT, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  for (const directory of [".github", "src", "scripts", "test"]) visit(directory);
  return files.filter((file) => file !== SELF);
}

test("current repository surfaces are Bun-only and native-binary-only", () => {
  const forbiddenPaths = [
    "scripts/package.mjs",
    "test/integration/package/installed-tarball-cli.integration.test.mjs",
    "test/support/bun-test.mjs",
    "test/support/bun-test-ci-fixture.mjs",
    "test/support/bun-test-only-ci-fixture.mjs",
  ];
  const forbiddenContent = [
    ["test import alias", /#bun-test/],
    ["Node test runner", /node:test/],
    ["Node process flags", /NODE_OPTIONS/],
    ["Node shebang", /#!\/usr\/bin\/env node/],
    ["Node fixture path", /\/opt\/node/],
    ["Node-only executable naming", /nodeExecutable/],
    ["npm-compatible distribution", /npm-compatible|\bpack:dist\b|installed-tarball/i],
    ["npm or pnpm command", /(^|\s)(?:npm|pnpm)(?:\s|$)/m],
  ];
  const violations = [];
  const runnerSeamFiles = [];
  for (const relative of forbiddenPaths) {
    if (fs.existsSync(path.join(ROOT, relative))) violations.push(`${relative}: forbidden compatibility file`);
  }
  for (const relative of currentFiles()) {
    const text = fs.readFileSync(path.join(ROOT, relative), "utf8");
    if (text.includes("LARKIN_BUN_TEST_RUNNER")) runnerSeamFiles.push(relative);
    for (const [label, pattern] of forbiddenContent) {
      if (pattern.test(text)) violations.push(`${relative}: ${label}`);
    }
  }
  assert.deepEqual(runnerSeamFiles.sort(), BUN_RUNNER_SEAM_ALLOWLIST, "Bun test-runner process seam escaped its narrow allowlist");
  assert.deepEqual(violations, [], `Bun-only inventory violations:\n${violations.join("\n")}`);
});
