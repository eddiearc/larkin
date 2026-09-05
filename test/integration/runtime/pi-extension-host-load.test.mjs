import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { PiRpcClient } from "../../../dist/runtime/pi-rpc-client.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const BUNDLES = [
  "pi-bash-timeout.bundle.js",
  "pi-subagents.bundle.js",
  "pi-supervised-command.bundle.js",
  "pi-subagent-record-watchdog.bundle.js",
];

function isRepoPi(candidate) {
  try {
    const real = fs.realpathSync(candidate);
    const repoModules = fs.realpathSync(path.join(ROOT, "node_modules"));
    return real === repoModules || real.startsWith(`${repoModules}${path.sep}`);
  } catch {
    return false;
  }
}

function resolveHostPi() {
  const explicit = typeof process.env.LARKIN_PI_COMMAND === "string" ? process.env.LARKIN_PI_COMMAND.trim() : "";
  if (explicit) {
    try {
      fs.accessSync(explicit, fs.constants.X_OK);
      if (!isRepoPi(explicit)) return explicit;
    } catch { /* fall through to PATH */ }
  }
  for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "pi");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (isRepoPi(candidate)) continue;
      return candidate;
    } catch { /* next */ }
  }
  return null;
}

const hostPi = resolveHostPi();
const forced = process.env.LARKIN_RUN_PI_EXTENSION_HOST_SMOKE === "1";
const enabled = forced || Boolean(hostPi);

test.skipIf(!enabled)("host Pi loads each extension bundle and answers get_state", async () => {
  const command = hostPi;
  if (!command) {
    throw new Error("LARKIN_RUN_PI_EXTENSION_HOST_SMOKE=1 requires a host `pi` outside node_modules/.bin");
  }
  for (const name of BUNDLES) {
    const bundle = path.join(ROOT, "dist/runtime", name);
    assert.equal(fs.existsSync(bundle), true, `${name} must exist after bun run build`);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-ext-home-"));
    const child = spawn(command, ["--mode", "rpc", "-e", bundle, "--no-session"], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: path.join(home, ".pi"),
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new PiRpcClient(child, { requestTimeoutMs: 15_000, shutdownGraceMs: 2_000 });
    try {
      const state = await client.request("get_state");
      assert.equal(typeof state, "object", `${name} get_state`);
      assert.notEqual(state, null, `${name} get_state`);
    } catch (error) {
      throw new Error(`${name} failed to load under host Pi: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.close().catch(() => {});
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}, 60_000);
