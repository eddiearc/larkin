import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VIEW_MODEL = pathToFileURL(path.join(ROOT, "dist/dashboard/dashboard-view-model.mjs")).href;
const PROMPT = pathToFileURL(path.join(ROOT, "dist/agent/context-prompt.mjs")).href;

test("dashboard standing prompt matches what the Runtime host gives a new session", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-standing-prompt-"));
  try {
    const { standingPromptView } = await import(VIEW_MODEL);
    const { ContextPromptBuilder, LARKIN_CARD_STANDING_PROMPT_VERSION, LARKIN_STANDING_PROMPT_VERSION } = await import(PROMPT);
    const agentId = "cli_prompt1";
    const stateDir = path.join(temp, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "bot-identity.json"), JSON.stringify({ name: "小助手" }));
    const agent = { agentId, name: "fallback", runtime: "codex", stateDir };

    const card = standingPromptView({ agents: { [agentId]: { ...agent, replyMode: "card" } } }, agentId, {});
    assert.equal(card.version, LARKIN_CARD_STANDING_PROMPT_VERSION);
    assert.equal(card.replyMode, "card");
    assert.equal(card.runtime, "codex");
    assert.equal(card.content, new ContextPromptBuilder({ replyMode: "card" }).build({ agentId, name: "小助手", runtime: "codex" }).content);

    // Without a configured mode the Runtime defaults to CLI replies; LARKIN_REPLY_MODE=card opts in.
    const cli = standingPromptView({ agents: { [agentId]: agent } }, agentId, {});
    assert.equal(cli.version, LARKIN_STANDING_PROMPT_VERSION);
    assert.equal(cli.replyMode, "cli");
    assert.equal(standingPromptView({ agents: { [agentId]: agent } }, agentId, { LARKIN_REPLY_MODE: "card" }).version, LARKIN_CARD_STANDING_PROMPT_VERSION);

    fs.rmSync(path.join(stateDir, "bot-identity.json"));
    assert.match(standingPromptView({ agents: { [agentId]: agent } }, agentId, {}).content, /\*\*fallback\*\*/);
    assert.throws(() => standingPromptView({ agents: { [agentId]: agent } }, "cli_missing", {}), (error) => error.statusCode === 404);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
