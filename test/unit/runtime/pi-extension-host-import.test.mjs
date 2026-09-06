import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const REMOVED = [
  "src/runtime/pi-bash-timeout-extension.ts",
  "src/runtime/pi-bash-timeout-injection.ts",
  "src/runtime/pi-subagent-injection.ts",
  "src/runtime/pi-supervised-command.ts",
  "src/runtime/pi-supervised-command-extension.ts",
  "src/runtime/pi-subagent-record-watchdog.ts",
  "src/runtime/pi-subagent-record-watchdog-injection.ts",
  "src/runtime/pi-extension-api.ts",
  "src/runtime/pi-tmux-bash-discovery.ts",
  "src/runtime/pi-autonomous-followup.ts",
  "src/runtime/pi-subagent-ledger.ts",
  "src/runtime/pi-subagents-notification.ts",
];
const REMOVED_BUNDLES = [
  "pi-bash-timeout.bundle.js",
  "pi-subagents.bundle.js",
  "pi-supervised-command.bundle.js",
  "pi-subagent-record-watchdog.bundle.js",
];

test("Larkin ships only the owned tmux extension bundle", () => {
  for (const relative of REMOVED) {
    assert.equal(fs.existsSync(path.join(ROOT, relative)), false, relative);
  }
  for (const name of REMOVED_BUNDLES) {
    assert.equal(fs.existsSync(path.join(ROOT, "dist/runtime", name)), false, name);
  }
  assert.equal(fs.existsSync(path.join(ROOT, "src/runtime/pi-tmux-extension.ts")), true);
  assert.equal(fs.existsSync(path.join(ROOT, "src/runtime/pi-tmux-injection.ts")), true);
  assert.equal(fs.existsSync(path.join(ROOT, "dist/runtime/pi-tmux.bundle.js")), true);
  const adapter = fs.readFileSync(path.join(ROOT, "src/runtime/runtime-adapters.ts"), "utf8");
  const build = fs.readFileSync(path.join(ROOT, "scripts/build.mjs"), "utf8");
  const standalone = fs.readFileSync(path.join(ROOT, "scripts/release/standalone-entry.ts"), "utf8");
  assert.match(adapter, /resolvePiTmuxExtensionArg/);
  assert.match(build, /bundlePiTmuxExtension/);
  assert.match(build, /--external", "typebox/);
  assert.match(standalone, /pi-tmux\.bundle\.js/);
  const bundle = fs.readFileSync(path.join(ROOT, "dist/runtime/pi-tmux.bundle.js"), "utf8");
  assert.match(bundle, /from ["']typebox["']/);
  assert.doesNotMatch(bundle, /node_modules\/typebox/);
  const loader = fs.readFileSync(path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"), "utf8");
  assert.match(loader, /typebox: _bundledTypebox/);
  assert.doesNotMatch(adapter, /resolvePiSubagentExtensionArg|resolvePiBashTimeoutExtensionArg|resolvePiSubagentRecordWatchdogExtensionArg/);
  assert.doesNotMatch(build, /bundlePiSubagentExtension|bundlePiBashTimeoutExtension|pi-subagents\.bundle/);
  assert.doesNotMatch(standalone, /pi-subagents\.bundle|pi-bash-timeout\.bundle|@tintinweb\/pi-subagents/);
});
