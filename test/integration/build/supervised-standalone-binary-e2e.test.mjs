import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { PiRpcClient } from "../../../dist/runtime/pi-rpc-client.mjs";

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
    const rpcHome = fs.mkdtempSync(path.join(ROOT, ".tmp-sa-rpc-"));
    const child = spawn(artifact, ["__internal", "pi-rpc", "--mode", "rpc", "--no-session"], {
      cwd: rpcHome,
      env: {
        ...process.env,
        LARKIN_CONFIG_DIR: rpcHome,
        LARKIN_HOME: rpcHome,
        HOME: rpcHome,
        PI_TELEMETRY: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new PiRpcClient(child, { requestTimeoutMs: 20_000 });
    try {
      const state = await client.request("get_state");
      assert.match(JSON.stringify(state), /"Agent"/);
    } finally {
      await client.close();
      fs.rmSync(rpcHome, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
