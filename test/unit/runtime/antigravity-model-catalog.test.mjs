import assert from "node:assert/strict";
import { test } from "bun:test";
import { discoverAntigravityModelCatalog, parseAntigravityModelList } from "../../../dist/runtime/antigravity-model-catalog.mjs";

const OUTPUT = `gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)
gemini-4-neon-high             Gemini 4 Neon (High)
gemini-4-neon-medium           Gemini 4 Neon (Medium) (default)
gemini-4-neon-low              Gemini 4 Neon (Low)
gemini-4-carbon-high           Gemini 4 Carbon (High)
gemini-4-carbon-medium         Gemini 4 Carbon (Medium)
gemini-4-carbon-low            Gemini 4 Carbon (Low)
gemini-pro-orchestrator-neon   Orchestrator (Neon)
gemini-pro-orchestrator        Orchestrator (Carbon)
gemini-3.8-flash-high          Gemini 3.8 Flash (High)
gemini-3.8-flash-medium        Gemini 3.8 Flash (Medium)
claude-sonnet-5-5-thinking     Claude Sonnet 5.5 (Thinking)`;

test("agy models groups adjustable effort families and keeps fixed-budget models without efforts", () => {
  assert.deepEqual(parseAntigravityModelList(OUTPUT), {
    effectiveModel: "gemini-4-neon-medium",
    models: [
      {
        id: "gemini-4-neon-medium",
        label: "Gemini 4 Neon",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gemini-4-carbon-medium",
        label: "Gemini 4 Carbon",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gemini-pro-orchestrator-neon",
        label: "Orchestrator (Neon)",
        supportedReasoningEfforts: [],
      },
      {
        id: "gemini-pro-orchestrator",
        label: "Orchestrator (Carbon)",
        supportedReasoningEfforts: [],
      },
      {
        id: "gemini-3.8-flash-medium",
        label: "Gemini 3.8 Flash",
        supportedReasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "claude-sonnet-5-5-thinking",
        label: "Claude Sonnet 5.5 (Thinking)",
        supportedReasoningEfforts: [],
      },
    ],
  });
});

test("agy models ignores carriage-return spinner frames and falls back to first model when no explicit default mark is present", () => {
  const catalog = parseAntigravityModelList(
    "\r⠋ Fetching available models...\r⠙ Fetching available models...\rgemini-4-neon-xhigh  Gemini 4 Neon (XHigh)\ngemini-4-neon-medium  Gemini 4 Neon (Medium)\n",
  );
  assert.equal(catalog.effectiveModel, "gemini-4-neon-medium");
  assert.deepEqual(catalog.models[0].supportedReasoningEfforts, ["medium", "xhigh"]);
});

test("an empty agy models output is treated as an authentication failure", () => {
  assert.throws(
    () => parseAntigravityModelList("Authentication required. Run agy to sign in."),
    /no authenticated available models/,
  );
});

test("discoverAntigravityModelCatalog runs `models` on the configured agy command", async () => {
  const calls = [];
  const catalog = await discoverAntigravityModelCatalog({
    cwd: "/tmp/ws",
    env: { LARKIN_ANTIGRAVITY_COMMAND: "/opt/agy" },
    runModels: async (call) => { calls.push(call); return OUTPUT; },
  });
  assert.equal(catalog.models.length, 6);
  assert.deepEqual(calls.map(({ command, cwd }) => ({ command, cwd })), [{ command: "/opt/agy", cwd: "/tmp/ws" }]);
});
