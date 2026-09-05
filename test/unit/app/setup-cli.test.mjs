import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETUP = path.join(ROOT, "dist", "app", "setup.mjs");

function run(args, env = {}) {
  return spawnSync(process.execPath, [SETUP, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      ...env,
    },
  });
}

test("setup help drops provider flags and builtin-pi", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--runtime <runtime>/);
  assert.match(help.stdout, /--model <id>/);
  assert.match(help.stdout, /pi \| codex \| claude/);
  assert.doesNotMatch(help.stdout, /builtin-pi|--provider|--api-key|--base-url|pi-auth|Provider Credentials/);
});

test("non-TTY setup requires --runtime before contacting lark-cli", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-nontty-"));
  try {
    const result = run([], { LARKIN_CONFIG_DIR: temp });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /非交互 setup 必须指定 --runtime pi\|codex\|claude/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /lark-cli|官方/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("non-TTY setup rejects builtin-pi as an unknown runtime", () => {
  const result = run(["--runtime", "builtin-pi"]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /未知 runtime/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Provider Credentials|pi-auth/);
});

test("non-TTY setup refuses a missing runtime executable without writing config", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-missing-"));
  try {
    const emptyPath = path.join(temp, "empty-bin");
    fs.mkdirSync(emptyPath, { mode: 0o700 });
    const result = run(["--runtime", "claude"], {
      LARKIN_CONFIG_DIR: temp,
      PATH: emptyPath,
      LARKIN_CLAUDE_COMMAND: "claude-missing-for-setup",
    });
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /claude is not installed/);
    assert.match(output, /LARKIN_CLAUDE_COMMAND|Install Claude Code/);
    assert.doesNotMatch(output, /Provider Credentials|pi-auth|builtin-pi/);
    assert.equal(fs.existsSync(path.join(temp, "config.json")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("setup rejects leftover provider flags", () => {
  const result = run(["--runtime", "pi", "--provider", "deepseek", "--api-key", "secret"]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /不再接受 --provider\/--api-key\/--base-url/);
});
