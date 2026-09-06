import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");

test("Larkin does not ship a Pi plugin discovery or source-scanning module", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "src/runtime/pi-tmux-bash-discovery.ts")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "src/runtime/pi-autonomous-followup.ts")), false);
  const adapter = fs.readFileSync(path.join(ROOT, "src/runtime/runtime-adapters.ts"), "utf8");
  assert.doesNotMatch(adapter, /discoverUserPiTmuxBash|inspectTmuxBashGitRootRequirement|extractAutonomousPiFollowUp/);
  assert.doesNotMatch(adapter, /git init/);
});

test("package.json wires the opt-in tmux-bash eval and drops the retired scripts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(
    pkg.scripts["test:eval:pi-tmux-bash"],
    "bun run build && LARKIN_RUN_PI_TMUX_BASH_EVAL=1 bun test --max-concurrency 1 test/live/pi-tmux-bash-live.test.mjs",
  );
  assert.equal(pkg.scripts["test:eval:pi-bash-timeout"], undefined);
  assert.equal(pkg.scripts["test:eval:pi-subagents-background"], undefined);
  assert.equal(pkg.dependencies["@richardgill/pi-tmux-bash"], undefined);
});
