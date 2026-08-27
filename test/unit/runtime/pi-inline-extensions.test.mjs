import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  BUILTIN_PI_EXTENSION_FACTORIES,
  invokeBuiltinPiRpc,
} from "../../../dist/runtime/pi-inline-extensions.mjs";
import { parseMaxCommandWaitSeconds } from "../../../dist/runtime/pi-subagent-bash-wait.mjs";
import { installGuardedBashTool } from "../../../dist/runtime/pi-bash-timeout-extension.mjs";

test("builtin Pi RPC receives exactly the three static inline extension factories", async () => {
  let invocation;
  await invokeBuiltinPiRpc(async (args, options) => { invocation = { args, options }; }, ["--no-session"]);

  assert.deepEqual(invocation.args, ["--mode", "rpc", "--no-session"]);
  assert.equal(Object.isFrozen(BUILTIN_PI_EXTENSION_FACTORIES), true);
  assert.equal(BUILTIN_PI_EXTENSION_FACTORIES.length, 3);
  assert.deepEqual(invocation.options.extensionFactories, [...BUILTIN_PI_EXTENSION_FACTORIES]);
  assert.notEqual(invocation.options.extensionFactories, BUILTIN_PI_EXTENSION_FACTORIES,
    "Pi receives a mutable copy while the exported factory list remains immutable");
  assert.ok(BUILTIN_PI_EXTENSION_FACTORIES.every((factory) => typeof factory === "function"));
});

test("record watchdog registers session_shutdown before bundled subagents", async () => {
  const priorStateDir = process.env.LARKIN_STATE_DIR;
  const priorOwner = process.env.LARKIN_PI_SESSION_OWNER;
  process.env.LARKIN_STATE_DIR = "/tmp/larkin-watchdog-order";
  process.env.LARKIN_PI_SESSION_OWNER = "session-order";
  try {
    const events = [];
    const first = BUILTIN_PI_EXTENSION_FACTORIES[0];
    const factory = typeof first === "function" ? first : first.factory;
    await factory({ on(event) { events.push(event); } });
    assert.deepEqual(events, ["session_shutdown"],
      "shutdown sweep must register before AgentManager teardown");
  } finally {
    if (priorStateDir === undefined) delete process.env.LARKIN_STATE_DIR;
    else process.env.LARKIN_STATE_DIR = priorStateDir;
    if (priorOwner === undefined) delete process.env.LARKIN_PI_SESSION_OWNER;
    else process.env.LARKIN_PI_SESSION_OWNER = priorOwner;
  }
});

test("record watchdog contains non-ENOENT filesystem errors on sweep", async () => {
  const priorStateDir = process.env.LARKIN_STATE_DIR;
  const priorOwner = process.env.LARKIN_PI_SESSION_OWNER;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-watchdog-fs-"));
  const managerKey = Symbol.for("pi-subagents:manager");
  const priorManager = globalThis[managerKey];
  process.env.LARKIN_STATE_DIR = root;
  process.env.LARKIN_PI_SESSION_OWNER = "session-fs-error";
  fs.writeFileSync(path.join(root, "pi-subagent-records"), "not-a-directory\n");
  globalThis[managerKey] = { getRecord: () => undefined };
  try {
    let shutdown;
    const first = BUILTIN_PI_EXTENSION_FACTORIES[0];
    const factory = typeof first === "function" ? first : first.factory;
    await factory({ on(event, handler) { if (event === "session_shutdown") shutdown = handler; } });
    assert.equal(typeof shutdown, "function");
    shutdown();
  } finally {
    if (priorManager === undefined) delete globalThis[managerKey];
    else globalThis[managerKey] = priorManager;
    if (priorStateDir === undefined) delete process.env.LARKIN_STATE_DIR;
    else process.env.LARKIN_STATE_DIR = priorStateDir;
    if (priorOwner === undefined) delete process.env.LARKIN_PI_SESSION_OWNER;
    else process.env.LARKIN_PI_SESSION_OWNER = priorOwner;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inline bash extension preserves the 60s foreground hard guard", async () => {
  const prior = process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
  process.env.LARKIN_PI_ROOT_SESSION_ID = "spoof-root";
  delete process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
  try {
    let bashTool;
    const extension = BUILTIN_PI_EXTENSION_FACTORIES[2];
    const factory = typeof extension === "function" ? extension : extension.factory;
    await factory({ registerTool(tool) { bashTool = tool; }, on() {} });
    assert.equal(bashTool.name, "bash");
    await assert.rejects(
      bashTool.execute("call-1", { command: "printf should-not-run", timeout: 61 },
        new AbortController().signal, () => {}, { sessionManager: {} }),
      /timeout:61 exceeds the 60s foreground hard limit/,
    );
  } finally {
    if (prior === undefined) delete process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
    else process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS = prior;
    delete process.env.LARKIN_PI_ROOT_SESSION_ID;
  }
});

test("closed-over nested bash cap does not leak to the parent tool", async () => {
  const prior = process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
  delete process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
  try {
    let parentBash;
    let childBash;
    const extension = BUILTIN_PI_EXTENSION_FACTORIES[2];
    const factory = typeof extension === "function" ? extension : extension.factory;
    await factory({ registerTool(tool) { parentBash = tool; }, on() {} });
    installGuardedBashTool({ registerTool(tool) { childBash = tool; }, on() {} }, 120);
    const result = await childBash.execute("call-nested", { command: "printf nested-ok", timeout: 90 },
      new AbortController().signal, () => {}, { sessionManager: { getSessionId: () => "child", getSessionFile: () => undefined } });
    assert.match(JSON.stringify(result), /nested-ok/);
    await assert.rejects(
      childBash.execute("call-too-long", { command: "printf should-not-run", timeout: 121 },
        new AbortController().signal, () => {}, {}),
      /timeout:121 exceeds the 120s background-subagent bash limit/,
    );
    await assert.rejects(
      parentBash.execute("call-parent", { command: "printf should-not-run", timeout: 61 },
        new AbortController().signal, () => {}, {}),
      /timeout:61 exceeds the 60s foreground hard limit/,
    );
  } finally {
    if (prior === undefined) delete process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
    else process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS = prior;
  }
});

test("authorized nested bash abort does not leave a running sleep", async () => {
  const prior = process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
  delete process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
  const childManager = { getSessionId: () => "child", getSessionFile: () => undefined };
  try {
    let bashTool;
    const extension = BUILTIN_PI_EXTENSION_FACTORIES[2];
    const factory = typeof extension === "function" ? extension : extension.factory;
    await factory({ registerTool(tool) { bashTool = tool; }, on() {} });
    installGuardedBashTool({ registerTool(tool) { bashTool = tool; }, on() {} }, 90);
    const ac = new AbortController();
    const pending = bashTool.execute("call-abort", { command: "sleep 30", timeout: 90 },
      ac.signal, () => {}, { sessionManager: childManager });
    ac.abort();
    await assert.rejects(pending, /abort/i);
  } finally {
    if (prior === undefined) delete process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
    else process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS = prior;
  }
});

test("supervised bash reaps nested background children", async () => {
  let bashTool;
  const extension = BUILTIN_PI_EXTENSION_FACTORIES[2];
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory({ registerTool(tool) { bashTool = tool; }, on() {} });
  const marker = `larkin-issue161-detach-${process.pid}-${Date.now()}`;
  await bashTool.execute("detached", { command: `perl -e 'sleep 30' # ${marker} &`, timeout: 1 },
    new AbortController().signal, () => {}, { sessionManager: { getSessionId: () => "p", getSessionFile: () => undefined } }).catch(() => {});
  const leftover = spawnSync("pgrep", ["-fl", marker], { encoding: "utf8" });
  assert.equal((leftover.stdout || "").trim(), "", leftover.stdout);
});

test("max_command_wait_seconds parse is fail-closed", () => {
  assert.equal(parseMaxCommandWaitSeconds(undefined, true), undefined);
  assert.equal(parseMaxCommandWaitSeconds(90, true), 90);
  assert.throws(() => parseMaxCommandWaitSeconds(90, false), /run_in_background/);
  assert.throws(() => parseMaxCommandWaitSeconds(60, true), /61..600/);
  assert.throws(() => parseMaxCommandWaitSeconds(601, true), /61..600/);
  assert.throws(() => parseMaxCommandWaitSeconds(90.5, true), /61..600/);
});

test("production subagents bundle keeps max_command_wait_seconds on the Agent schema", () => {
  const bundle = fs.readFileSync(new URL("../../../dist/runtime/pi-subagents.bundle.js", import.meta.url), "utf8");
  assert.match(bundle, /max_command_wait_seconds/);
  assert.match(bundle, /requires run_in_background: true/);
  assert.match(bundle, /cannot be combined with schedule/);
  assert.match(bundle, /cannot be combined with resume/);
  assert.match(bundle, /maxCommandWaitSeconds/);
  assert.match(bundle, /larkin-pi-subagents-command-wait-v1/);
  assert.match(bundle, /not a public spawn option/);
});
