import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { discoverPiModelCatalog } from "../../dist/runtime/pi-model-catalog.mjs";
import { createNativeRuntimeAdapter } from "../../dist/runtime/runtime-adapters.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const enabled = process.env.LARKIN_RUN_PI_CATALOG_LIVE_TEST === "1";

test.skipIf(!enabled)("official Pi catalog, management CLI and no-prompt session construction", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-catalog-live-"));
  const agentId = "cli_piCatalogLiveA1";
  const workspaceDir = path.join(root, "agents", agentId);
  const stateDir = path.join(root, "state", "agents", agentId);
  fs.mkdirSync(workspaceDir, { recursive: true });
  try {
    const catalog = await discoverPiModelCatalog({ cwd: workspaceDir, timeoutMs: 20_000 });
    assert.ok(catalog.models.length > 0, "authenticated official registry must expose at least one model");
    assert.ok(catalog.effectiveModel, "official settings/fallback must resolve an effective model");
    fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
      version: 3,
      serverId: "server-pi-catalog-live",
      activeAgent: agentId,
      agents: { [agentId]: { runtime: "pi", model: "default" } },
    }, null, 2)}\n`, { mode: 0o600 });
    const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, "dist/app/agent-config.mjs"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, LARKIN_CONFIG_DIR: root },
    });
    const listed = run("model");
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.match(listed.stdout, new RegExp(catalog.effectiveModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const selected = catalog.models.find((model) => model.supportedReasoningEfforts.includes("high")) || catalog.models[0];
    const setModel = run("model", selected.id);
    assert.equal(setModel.status, 0, setModel.stderr || setModel.stdout);
    const effort = selected.supportedReasoningEfforts.at(-1);
    const setEffort = run("effort", effort);
    assert.equal(setEffort.status, 0, setEffort.stderr || setEffort.stdout);
    const stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.equal(stored.agents[agentId].model, selected.id);
    assert.equal(stored.agents[agentId].effort, effort);

    const session = await createNativeRuntimeAdapter("pi").createSession({
      agentId, workspaceDir, stateDir,
      standingPrompt: { version: "live", content: "Pi catalog live construction only; do not prompt.", hash: "live" },
      model: selected.id,
      reasoningEffort: effort,
    });
    assert.ok(session.sessionId);
    await session.close("catalog live complete");
    console.log(JSON.stringify({ modelCount: catalog.models.length, effectiveModel: catalog.effectiveModel, selectedModel: selected.id, effort }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
