import assert from "node:assert/strict";
import { test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE = pathToFileURL(path.join(ROOT, "dist/runtime/codex-model-catalog.mjs")).href;

test("Codex catalog consumes app-server model/list and exposes only visible safe models", async () => {
  const { discoverCodexModelCatalog } = await import(MODULE);
  const calls = [];
  const models = await discoverCodexModelCatalog({
    env: { CODEX_HOME: "/tmp/codex-authority" },
    async runCodexAppServer(call) {
      calls.push(call);
      return { data: [
        {
          id: "gpt-5.4-mini", model: "gpt-5.4-mini", displayName: "  GPT-5.4\u0000-Mini  ", hidden: false, isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }],
        },
        { id: "codex-auto-review", model: "codex-auto-review", displayName: "Auto Review", hidden: true, isDefault: false, supportedReasoningEfforts: [] },
        { id: "unsafe/model", model: "unsafe/model", displayName: "Unsafe", hidden: false, isDefault: false, supportedReasoningEfforts: [] },
      ] };
    },
  });

  assert.equal(models.effectiveModel, "gpt-5.4-mini");
  assert.deepEqual(models.models, [{
    id: "gpt-5.4-mini",
    label: "GPT-5.4-Mini",
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    verified: "codex-cli-visible",
  }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["app-server", "--stdio"]);
  assert.equal(calls[0].request.method, "model/list");
  assert.deepEqual(calls[0].request.params, { limit: 100, includeHidden: false });
  assert.equal(calls[0].env.CODEX_HOME, "/tmp/codex-authority");
  assert.equal(calls[0].env.NO_COLOR, "1");
  assert.equal(calls[0].timeout, 15_000);
  assert.ok(calls[0].maxBuffer >= 256 * 1024 && calls[0].maxBuffer <= 4 * 1024 * 1024);
});

test("Codex catalog fails closed on malformed, empty, or unbounded catalog shapes", async () => {
  const { discoverCodexModelCatalog } = await import(MODULE);
  for (const response of [null, {}, { data: [] }, { data: new Array(513).fill({ id: "gpt", hidden: false }) }]) {
    await assert.rejects(
      discoverCodexModelCatalog({ async runCodexAppServer() { return response; } }),
      /Codex model catalog|Codex 模型目录/i,
    );
  }
});
