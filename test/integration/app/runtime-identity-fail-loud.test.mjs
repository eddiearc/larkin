import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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

test("a Runtime marker without Agent authority cannot fall back to activeAgent for IM", () => {
  for (const [marker, value] of [
    ["LARKIN_RUNTIME", "1"],
    ["LARKIN_RUNTIME_OBSERVATION_GENERATION", "launch-1"],
    ["LARKIN_STATE_DIR", path.join(ROOT, "state", "agents", "cli_missingIdentityA1")],
  ]) {
    const env = withoutRuntimeAuthority();
    env[marker] = value;
    for (const [entry, argv] of [
      ["cli.mjs", ["im", "+chat-list"]],
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

test("missing Runtime identity keeps public config at operator scope without selecting activeAgent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-config-"));
  const agents = ["cli_operatorA1", "cli_operatorB2"];
  try {
    fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
      version: 4,
      serverId: "runtime-config-boundary",
      mentionPolicy: "require",
      activeAgent: agents[0],
      agents: Object.fromEntries(agents.map((agentId) => [agentId, { runtime: "codex", model: "default" }])),
    })}\n`, { mode: 0o600 });
    const env = withoutRuntimeAuthority();
    env.LARKIN_RUNTIME = "1";
    env.LARKIN_CONFIG_DIR = root;

    const im = run("cli.mjs", ["im", "config"], env);
    assert.equal(im.status, 2, im.stderr);
    assert.match(im.stderr, /Runtime Agent authority is missing/);

    const config = run("cli.mjs", ["config", "show", "--json"], env);
    assert.equal(config.status, 0, config.stderr);
    const view = JSON.parse(config.stdout);
    assert.deepEqual(view.agents.map((agent) => agent.agentId).sort(), [...agents].sort());
    assert.doesNotMatch(config.stderr, /Runtime Agent authority is missing|active Agent/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
