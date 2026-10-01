import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");

function withoutRuntimeAuthority() {
  const env = { ...process.env };
  delete env.LARKIN_AGENT_ID;
  delete env.LARKIN_RUNTIME;
  delete env.LARKIN_RUNTIME_OBSERVATION_GENERATION;
  delete env.LARKIN_STATE_DIR;
  return env;
}

function run(entry, argv, env) {
  return spawnSync(process.execPath, [path.join(ROOT, "dist", "app", entry), ...argv], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
}

test("agent-scoped commands fail loudly without Runtime authority and never enter lark passthrough", () => {
  for (const entry of ["cli.mjs", "lark.mjs"]) {
    const result = run(entry, ["inbox", "check"], withoutRuntimeAuthority());
    assert.equal(result.status, 2, `${entry}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Runtime Agent authority is missing/);
    assert.match(result.stderr, /LARKIN_AGENT_ID/);
    assert.doesNotMatch(result.stderr, /unknown command/i);
  }
});

test("a Runtime marker without Agent authority cannot fall back to activeAgent for IM or config", () => {
  for (const [marker, value] of [
    ["LARKIN_RUNTIME", "1"],
    ["LARKIN_RUNTIME_OBSERVATION_GENERATION", "launch-1"],
    ["LARKIN_STATE_DIR", path.join(ROOT, "state", "agents", "cli_missingIdentityA1")],
  ]) {
    const env = withoutRuntimeAuthority();
    env[marker] = value;
    for (const [entry, argv] of [
      ["cli.mjs", ["im", "+chat-list"]],
      ["cli.mjs", ["config", "show"]],
      ["lark.mjs", ["im", "+chat-list"]],
    ]) {
      const result = run(entry, argv, env);
      assert.equal(result.status, 2, `${marker} ${entry}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /Runtime Agent authority is missing/);
      assert.match(result.stderr, /will not fall back|cannot fall back/i);
      assert.doesNotMatch(result.stderr, /lark-cli 启动失败/i);
    }
  }
});
