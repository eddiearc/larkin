import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const BUNDLES = [
  "pi-bash-timeout.bundle.js",
  "pi-subagents.bundle.js",
  "pi-supervised-command.bundle.js",
  "pi-subagent-record-watchdog.bundle.js",
];

test("Pi extension sources statically import the host package and do not load it with createRequire", () => {
  const extension = fs.readFileSync(path.join(ROOT, "src/runtime/pi-bash-timeout-extension.ts"), "utf8");
  const api = fs.readFileSync(path.join(ROOT, "src/runtime/pi-extension-api.ts"), "utf8");
  assert.match(extension, /import \{ createBashToolDefinition, type ExtensionAPI, type BashToolInput \} from "@earendil-works\/pi-coding-agent"/);
  assert.doesNotMatch(extension, /createRequire|loadHostCreateBashToolDefinition/);
  assert.doesNotMatch(api, /createRequire|loadHostCreateBashToolDefinition|from "@earendil-works\/pi-coding-agent"/);
});

test("built Pi extension bundles keep the host package external and contain no createRequire", () => {
  for (const name of BUNDLES) {
    const file = path.join(ROOT, "dist/runtime", name);
    assert.equal(fs.existsSync(file), true, `${name} must exist after bun run build`);
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /createRequire\s*\(/, `${name} must not call createRequire`);
    assert.doesNotMatch(source, /loadHostCreateBashToolDefinition/);
  }
  const bashTimeout = fs.readFileSync(path.join(ROOT, "dist/runtime/pi-bash-timeout.bundle.js"), "utf8");
  assert.match(bashTimeout, /@earendil-works\/pi-coding-agent/,
    "bash-timeout bundle must keep @earendil-works/pi-coding-agent as an external import specifier");
});
