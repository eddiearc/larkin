import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");

function withoutRuntimeAuthority() {
  const env = { ...process.env };
  delete env.LARKIN_AGENT_ID;
  delete env.LARKIN_RUNTIME_OBSERVATION_GENERATION;
  return env;
}

test("agent-scoped commands fail loudly without Runtime authority and never enter lark passthrough", () => {
  for (const entry of ["cli.mjs", "lark.mjs"]) {
    const result = spawnSync(process.execPath, [path.join(ROOT, "dist", "app", entry), "inbox", "check"], {
      cwd: ROOT,
      encoding: "utf8",
      env: withoutRuntimeAuthority(),
    });
    assert.equal(result.status, 2, `${entry}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Runtime Agent authority is missing/);
    assert.match(result.stderr, /LARKIN_AGENT_ID/);
    assert.doesNotMatch(result.stderr, /unknown command/i);
  }
});
