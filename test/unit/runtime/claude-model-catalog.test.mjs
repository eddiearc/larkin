import assert from "node:assert/strict";
import { test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE = pathToFileURL(path.join(ROOT, "dist/runtime/claude-model-catalog.mjs")).href;

test("Claude catalog consumes the supported list_models control response and resolves default locally", async () => {
  const { discoverClaudeModelCatalog } = await import(MODULE);
  const calls = [];
  const catalog = await discoverClaudeModelCatalog({
    env: { CLAUDE_CONFIG_DIR: "/tmp/claude-authority" },
    async runClaudeControl(call) {
      calls.push(call);
      return { models: [
        { value: "default", displayName: "Default", resolvedModel: "claude-opus-4-8[1m]", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
        { value: "opus[1m]", displayName: "Opus", resolvedModel: "claude-opus-4-8[1m]", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
        { value: "unsafe/model", displayName: "Unsafe", resolvedModel: "unsafe", supportedEffortLevels: [] },
      ] };
    },
  });

  assert.equal(catalog.effectiveModel, "claude-opus-4-8[1m]");
  assert.deepEqual(catalog.defaultSupportedReasoningEfforts, ["low", "medium", "high"]);
  assert.deepEqual(catalog.models, [{
    id: "opus[1m]", label: "Opus", supportedReasoningEfforts: ["low", "medium", "high"], verified: "claude-control-visible",
  }]);
  assert.deepEqual(calls[0].args, ["--safe-mode", "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
  assert.equal(calls[0].request.request.subtype, "list_models");
  assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, "/tmp/claude-authority");
  assert.equal(calls[0].timeout, 15_000);
  assert.ok(calls[0].maxBuffer >= 256 * 1024 && calls[0].maxBuffer <= 4 * 1024 * 1024);
});

test("Claude catalog fails closed without a valid default and visible model list", async () => {
  const { discoverClaudeModelCatalog } = await import(MODULE);
  for (const response of [null, {}, { models: [] }, { models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5" }] }]) {
    await assert.rejects(discoverClaudeModelCatalog({ async runClaudeControl() { return response; } }), /Claude model catalog|Claude 模型目录/i);
  }
});

test("Claude catalog surfaces the underlying spawn failure instead of a generic message", async () => {
  const { discoverClaudeModelCatalog } = await import(MODULE);
  await assert.rejects(
    discoverClaudeModelCatalog({ command: "/definitely/missing/larkin-claude-spawn-probe" }),
    (error) => {
      assert.match(error.message, /Claude model catalog command failed/);
      assert.match(error.message, /ENOENT/);
      return true;
    },
  );
});
