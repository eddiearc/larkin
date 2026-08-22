import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  BUILTIN_PI_EXTENSION_FACTORIES,
  invokeBuiltinPiRpc,
} from "../../../dist/runtime/pi-inline-extensions.mjs";

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

test("inline bash extension preserves the 60s foreground hard guard", async () => {
  const prior = process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
  delete process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
  try {
    let bashTool;
    const extension = BUILTIN_PI_EXTENSION_FACTORIES[1];
    const factory = typeof extension === "function" ? extension : extension.factory;
    await factory({ registerTool(tool) { bashTool = tool; } });
    assert.equal(bashTool.name, "bash");
    await assert.rejects(
      bashTool.execute("call-1", { command: "printf should-not-run", timeout: 61 },
        new AbortController().signal, () => {}, {}),
      /timeout:61 exceeds the 60s foreground hard limit/,
    );
  } finally {
    if (prior === undefined) delete process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
    else process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS = prior;
  }
});
