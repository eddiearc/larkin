import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = path.join(ROOT, "dist", "app", "cli.mjs");

function run(...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LARKIN_CONFIG_DIR: "/tmp/larkin-cli-help-unused" },
  });
}

test("public command table has no pi-auth or pi-distribution", () => {
  const help = run("help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /larkin <command>/);
  assert.match(help.stdout, /^\s+setup\s/m);
  assert.match(help.stdout, /^\s+runtime\s/m);
  assert.doesNotMatch(help.stdout, /pi-auth|pi-distribution|api-key-stdin|builtin-pi|--provider|--api-key/);
});

test("setup help lists only external runtimes and drops provider flags", () => {
  const help = run("help", "setup");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--runtime <pi\|codex\|claude>/);
  assert.match(help.stdout, /installed \/ not installed/);
  assert.doesNotMatch(help.stdout, /builtin-pi|--provider|--api-key|--base-url|pi-auth|pi-distribution|api-key-stdin|Provider Credentials/);
});

test("runtime help lists only pi, codex, and claude", () => {
  const help = run("help", "runtime");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /pi \| codex \| claude/);
  assert.doesNotMatch(help.stdout, /builtin-pi|pi-distribution|pi-auth/);
});

test("retired pi-auth and pi-distribution commands are unknown", () => {
  for (const command of ["pi-auth", "pi-distribution"]) {
    const result = run(command);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /larkin <command>/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Usage: larkin pi-auth|Usage: larkin pi-distribution|api-key-stdin/);
  }
});
