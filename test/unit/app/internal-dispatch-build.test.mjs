import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const ENTRY = path.join(ROOT, "dist/app/binary-entry.mjs");

test("built internal dispatch resolves every generated ESM entry", () => {
  const built = fs.readFileSync(ENTRY, "utf8");
  assert.doesNotMatch(built, /import\(["']\.\.?\/[^"']+\.js["']\)/);
  for (const module of [
    "run", "setup", "runtime-process", "agent-cli", "runtime-model-directory",
    "agent-config", "lark", "dashboard",
  ]) {
    assert.match(built, new RegExp(`import\\(["']\\./${module}\\.mjs["']\\)`));
  }
  for (const module of ["bot-register", "setup-bind", "grant-scopes"]) {
    assert.match(built, new RegExp(`import\\(["']\\.\\./setup/${module}\\.mjs["']\\)\\)\\.main\\(\\)`));
  }

  const probe = spawnSync(process.execPath, [ENTRY, "__internal", "runtime-model-directory", "unknown", ROOT], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(probe.status, 1);
  assert.match(probe.stderr, /未知 runtime：unknown/);
  assert.doesNotMatch(probe.stderr, /ResolveMessage|Cannot find module/);
});
