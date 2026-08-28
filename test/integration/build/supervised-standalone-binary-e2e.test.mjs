import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const ENABLED = process.env.LARKIN_RUN_SUPERVISED_STANDALONE_BINARY === "1";

function checked(result, label) {
  assert.equal(result.status, 0, `${label}\n${result.stdout || ""}\n${result.stderr || ""}`);
  return result;
}

test.skipIf(!ENABLED)("compiled standalone binary embeds supervised tools and starts", {
  timeout: 240_000,
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-supervised-sa-bin-"));
  const release = path.join(temp, "release");
  try {
    checked(spawnSync(process.execPath, ["run", "build"], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000, env: process.env,
    }), "build dist");
    checked(spawnSync(process.execPath, [
      "scripts/release/build.ts",
      "--target", `${os.platform()}-${os.arch()}`,
      "--out-dir", release,
      "--allow-dirty",
    ], { cwd: ROOT, encoding: "utf8", timeout: 150_000, env: process.env }), "compile standalone-entry");
    const manifest = JSON.parse(fs.readFileSync(path.join(release, "release-manifest.json"), "utf8"));
    const artifact = path.join(release, manifest.artifacts[0].file);
    assert.equal(fs.existsSync(artifact), true, "standalone artifact missing");
    const bytes = fs.readFileSync(artifact);
    assert.ok(bytes.includes(Buffer.from("supervised_start")), "compiled binary must embed supervised_start");
    assert.ok(bytes.includes(Buffer.from("supervised_wait")), "compiled binary must embed supervised_wait");
    assert.ok(bytes.includes(Buffer.from("supervised_cancel")), "compiled binary must embed supervised_cancel");
    const help = spawnSync(artifact, ["--help"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(help.error, undefined, String(help.error));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
