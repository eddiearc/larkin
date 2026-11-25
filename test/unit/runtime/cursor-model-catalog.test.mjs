import assert from "node:assert/strict";
import { test } from "bun:test";
import { discoverCursorModelCatalog, parseCursorModelList } from "../../../dist/runtime/cursor-model-catalog.mjs";

const OUTPUT = `Available models

auto - Auto (default)
gpt-5.5 - GPT-5.5 272K Medium
claude-opus-4-8[context=1m,effort=high] - Claude Opus 4.8 1M High

Tip: use --model <id> (or /model <id> in interactive mode) to switch.`;

test("cursor-agent models output becomes the model directory with its default", () => {
  assert.deepEqual(parseCursorModelList(OUTPUT), {
    effectiveModel: "auto",
    models: [
      { id: "auto", label: "Auto" },
      { id: "gpt-5.5", label: "GPT-5.5 272K Medium" },
      { id: "claude-opus-4-8[context=1m,effort=high]", label: "Claude Opus 4.8 1M High" },
    ],
  });
});

test("an empty model list is an authentication failure, not an empty directory", () => {
  assert.throws(() => parseCursorModelList("Not logged in. Run agent login."), /no authenticated available models/);
});

test("the catalog runs `models` on the configured cursor-agent command", async () => {
  const calls = [];
  const catalog = await discoverCursorModelCatalog({
    cwd: "/tmp/ws", env: { LARKIN_CURSOR_COMMAND: "/opt/cursor-agent" },
    runModels: async (call) => { calls.push(call); return OUTPUT; },
  });
  assert.equal(catalog.models.length, 3);
  assert.deepEqual(calls.map(({ command, cwd }) => ({ command, cwd })), [{ command: "/opt/cursor-agent", cwd: "/tmp/ws" }]);
});
