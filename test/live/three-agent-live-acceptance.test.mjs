import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readProcessState } from "../../dist/platform/process-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENABLED = process.env.LARKIN_RUN_FEISHU_LIVE_TEST === "1";
const SKIP_REASON = "set LARKIN_RUN_FEISHU_LIVE_TEST=1 to validate current state and prepared manual Feishu evidence";
const START = "<!-- larkin:platform-rules:start -->";
const END = "<!-- larkin:platform-rules:end -->";
const AGENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const RAW_ID = /\b(?:oc|cli|ou|om|omt)_[a-zA-Z0-9]{8,}\b/;
const SOURCES = new Set(["public-cli", "status-json", "conversation", "transient-inbox", "feishu-history", "manual-ui"]);
const SKIP_REASONS = new Set(["not-run", "not-applicable", "requires-user-ui", "supplemental-not-run"]);

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`${label} is not readable JSON: ${error.message}`); }
}

function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has missing or unknown fields`);
}

function regularDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  assert.equal(stat.isDirectory(), true, `${label} must be a directory`);
  assert.equal(stat.isSymbolicLink(), false, `${label} must not be a symlink`);
}

function occurrenceCount(value, marker) {
  return value.split(marker).length - 1;
}

function validatePrompt(file) {
  const content = fs.readFileSync(file, "utf8");
  assert.equal(occurrenceCount(content, START), 1, `${path.basename(file)} must contain one managed block start`);
  assert.equal(occurrenceCount(content, END), 1, `${path.basename(file)} must contain one managed block end`);
  const managed = content.slice(content.indexOf(START), content.indexOf(END) + END.length);
  assert.match(managed, /群聊里，人只有\s*@你\s*才会唤醒你（免@白名单群例外）/, "managed block must retain the human group wake rule");
  assert.match(managed, /未\s*@你的消息一律入箱可见/, "managed block must retain non-@ listening");
  assert.match(managed, /机器人发的消息：只有点名\s*@你\s*才会唤醒你（@所有人不算）/, "managed block must retain directed bot wake and @all exclusion");
  assert.match(managed, /不设任何冷却或频率闸门/, "managed block must reject cooldown/frequency gates");
}

function rejectRawIds(value, at = "evidence") {
  if (typeof value === "string") assert.doesNotMatch(value, RAW_ID, `${at} must use aliases or hashes, not raw IDs`);
  else if (Array.isArray(value)) value.forEach((item, index) => rejectRawIds(item, `${at}[${index}]`));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assert.doesNotMatch(key, RAW_ID, `${at} key must not contain a raw ID`);
      rejectRawIds(item, `${at}.${key}`);
    }
  }
}

function isoTime(value, label) {
  assert.equal(typeof value, "string", `${label} must be an ISO timestamp`);
  const time = Date.parse(value);
  assert.equal(Number.isFinite(time), true, `${label} must be an ISO timestamp`);
  return time;
}

function chatHash(chatId) {
  return crypto.createHash("sha256").update(chatId).digest("hex").slice(0, 16);
}

function loadEvidence() {
  const file = process.env.LARKIN_LIVE_ACCEPTANCE_EVIDENCE;
  assert.ok(file, "set LARKIN_LIVE_ACCEPTANCE_EVIDENCE to a sanitized manual result JSON");
  const evidence = readJson(path.resolve(file), "manual Feishu acceptance evidence");
  rejectRawIds(evidence);
  exactKeys(evidence, ["schemaVersion", "evidenceKind", "environment", "runId", "marker", "startedAt", "endedAt", "commit", "chatAlias", "chatHash", "roster", "cases"], "evidence");
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.evidenceKind, "manual-observation");
  assert.equal(evidence.environment, "local-feishu-live");
  assert.match(evidence.runId, /^[a-z0-9-]{8,64}$/i);
  assert.equal(evidence.marker, `[LARKIN-LIVE-TEST:${evidence.runId}]`, "marker must be derived from runId");
  const startedAt = isoTime(evidence.startedAt, "evidence.startedAt");
  const endedAt = isoTime(evidence.endedAt, "evidence.endedAt");
  assert.ok(endedAt >= startedAt, "evidence endedAt must not precede startedAt");
  assert.ok(endedAt - startedAt <= 24 * 60 * 60 * 1000, "one acceptance run must fit within 24 hours");
  const now = Date.now();
  assert.ok(endedAt <= now + 5 * 60 * 1000, "evidence endedAt must not be in the future beyond five minutes of clock skew");
  assert.ok(startedAt >= now - 7 * 24 * 60 * 60 * 1000, "evidence run must be no older than seven days");
  assert.match(evidence.commit, /^[0-9a-f]{7,40}$/i);
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr || "cannot resolve current Git HEAD");
  assert.equal(git.stdout.trim().startsWith(evidence.commit.toLowerCase()), true, "evidence commit must match the current Git HEAD");
  assert.match(evidence.chatAlias, /^[a-z0-9][a-z0-9._-]{2,63}$/i);
  assert.match(evidence.chatHash, /^[0-9a-f]{16}$/);
  exactKeys(evidence.roster, ["humanUsers", "botAgents", "targetAgents", "source"], "evidence.roster");
  assert.deepEqual(evidence.roster, { humanUsers: 1, botAgents: 3, targetAgents: 3, source: "lark-cli-chat-members" });
  exactKeys(evidence.cases, [
    "setup-reuses-agent", "start-is-idempotent", "workspace-and-prompt-ready",
    "free-human-no-at", "strict-human-no-at", "strict-human-target-at", "restore-free-mode",
    "strict-bot-no-at", "strict-bot-target-at", "strict-at-all", "no-cooldown-two-directed",
  ], "evidence.cases");
  return { evidence, startedAt };
}

function caseObservation(evidence, id, observedKeys, { allowSkipped = false, requiredSources = [] } = {}) {
  const record = evidence.cases[id];
  if (record?.status === "skipped") {
    assert.equal(allowSkipped, true, `${id} must pass for the core manual acceptance`);
    exactKeys(record, ["status", "reasonCode"], `evidence.cases.${id}`);
    assert.equal(SKIP_REASONS.has(record.reasonCode), true, `${id} has an unknown skipped reasonCode`);
    return null;
  }
  exactKeys(record, ["status", "observed", "evidenceSource"], `evidence.cases.${id}`);
  assert.equal(record.status, "pass", `${id} evidence status must be pass${allowSkipped ? " or skipped" : ""}`);
  exactKeys(record.observed, observedKeys, `evidence.cases.${id}.observed`);
  assert.ok(Array.isArray(record.evidenceSource) && record.evidenceSource.length > 0, `${id} needs at least one evidence source`);
  assert.equal(new Set(record.evidenceSource).size, record.evidenceSource.length, `${id} evidence sources must be unique`);
  for (const source of record.evidenceSource) assert.equal(SOURCES.has(source), true, `${id} has unknown evidence source: ${source}`);
  for (const source of requiredSources) assert.equal(record.evidenceSource.includes(source), true, `${id} requires evidence source: ${source}`);
  return record.observed;
}

test.skipIf(!ENABLED)(`prepared three-Agent shell baseline is currently healthy (${SKIP_REASON})`, () => {
  const { evidence, startedAt } = loadEvidence();
  const configDir = path.resolve(process.env.LARKIN_CONFIG_DIR || path.join(os.homedir(), ".larkin"));
  regularDirectory(configDir, "Larkin config root");
  const config = readJson(path.join(configDir, "config.json"), "config.json");
  assert.equal(config.version, 3, "manual live acceptance requires strict config schema v3");
  assert.ok(config.agents && typeof config.agents === "object" && !Array.isArray(config.agents));
  const agents = Object.entries(config.agents);
  assert.equal(agents.length, 3, "manual live acceptance targets exactly three configured Agents");
  const processState = readProcessState(configDir);
  assert.equal(processState.daemon.state, "owned", `daemon ownership must be current: ${processState.daemon.reason || "unknown"}`);
  assert.deepEqual(new Set(processState.daemon.agents), new Set(agents.map(([id]) => id)), "the owned daemon must contain the exact three configured Agents");
  const daemonStartedAt = isoTime(processState.daemon.startedAt, "daemon startedAt");

  const freeChats = agents.map(([agentId, agent]) => {
    assert.match(agentId, AGENT_ID, "Agent ID must be safe for canonical path derivation");
    const workspace = path.join(configDir, "agents", agentId);
    const state = path.join(configDir, "state", "agents", agentId);
    regularDirectory(workspace, "canonical Agent workspace");
    regularDirectory(state, "canonical Agent state");
    validatePrompt(path.join(workspace, "AGENTS.md"));
    validatePrompt(path.join(workspace, "CLAUDE.md"));
    const status = readJson(path.join(state, "status.json"), "Agent status.json");
    assert.equal(status.connectedVia, "channel", "each Agent must have a channel connection");
    const connectedAt = isoTime(status.connectedAt, "Agent connectedAt");
    assert.ok(connectedAt >= daemonStartedAt, "Agent connectedAt must belong to the current daemon lifecycle");
    const inboundVerifiedAt = isoTime(status.inboundVerifiedAt, "Agent inboundVerifiedAt");
    assert.ok(inboundVerifiedAt >= daemonStartedAt, "each Agent must receive a real inbound event during the current daemon lifecycle");
    const newErrors = (Array.isArray(status.recentErrors) ? status.recentErrors : []).filter((error) => isoTime(error.at, "recentErrors[].at") >= startedAt);
    assert.deepEqual(newErrors, [], "Agent must have no new recentErrors during this acceptance run");
    return new Set(Array.isArray(agent.noMentionChats) ? agent.noMentionChats : []);
  });
  const sharedFreeChats = [...freeChats[0]].filter((chat) => freeChats.slice(1).every((set) => set.has(chat)));
  assert.equal(sharedFreeChats.some((chat) => chatHash(chat) === evidence.chatHash), true, "evidence chat hash must identify a currently restored shared free-mode chat");
});

test.skipIf(!ENABLED)(`manual Feishu evidence has a safe shape and the required core effects (${SKIP_REASON})`, () => {
  const { evidence } = loadEvidence();
  const setup = caseObservation(evidence, "setup-reuses-agent", ["agentCountBefore", "agentCountAfter", "workspaceReused"], { allowSkipped: true, requiredSources: ["manual-ui", "status-json"] });
  if (setup) assert.deepEqual(setup, { agentCountBefore: 3, agentCountAfter: 3, workspaceReused: true });
  assert.deepEqual(caseObservation(evidence, "start-is-idempotent", ["daemonReused", "hostProcessCount"], { requiredSources: ["public-cli", "status-json"] }), { daemonReused: true, hostProcessCount: 1 });
  assert.deepEqual(caseObservation(evidence, "workspace-and-prompt-ready", ["readyAgents", "duplicateManagedBlocks"], { requiredSources: ["status-json"] }), { readyAgents: 3, duplicateManagedBlocks: 0 });

  const free = caseObservation(evidence, "free-human-no-at", ["observingAgents", "wokenAgents", "replyingAgents"], { requiredSources: ["status-json", "feishu-history"] });
  assert.equal(free.observingAgents, 3);
  assert.equal(free.wokenAgents, 3);
  assert.ok(free.replyingAgents >= 1 && free.replyingAgents <= 3, "free/no-@ reply count is intentionally soft");
  assert.deepEqual(caseObservation(evidence, "strict-human-no-at", ["observingAgents", "wokenAgents", "replyingAgents"], { requiredSources: ["transient-inbox", "feishu-history"] }), { observingAgents: 3, wokenAgents: 0, replyingAgents: 0 });

  const targeted = caseObservation(evidence, "strict-human-target-at", ["observingAgents", "wokenAgents", "replyingAgents", "nonTargetReplyingAgents", "targetOnly", "realAt"], { requiredSources: ["status-json", "feishu-history"] });
  assert.equal(targeted.observingAgents, 3);
  assert.equal(targeted.wokenAgents, 1);
  assert.equal(targeted.targetOnly, true);
  assert.equal(targeted.realAt, true, "targeted wake must use a real Feishu <at>, not text @name");
  assert.equal(targeted.nonTargetReplyingAgents, 0);
  assert.ok(targeted.replyingAgents === 0 || targeted.replyingAgents === 1, "the target reply is a soft observation");
  assert.deepEqual(caseObservation(evidence, "restore-free-mode", ["freeAgents", "connectedAgents", "newErrorAgents"], { requiredSources: ["public-cli", "status-json"] }), { freeAgents: 3, connectedAgents: 3, newErrorAgents: 0 });

  const botSilent = caseObservation(evidence, "strict-bot-no-at", ["observingAgents", "wokenAgents", "replyingAgents"], { allowSkipped: true, requiredSources: ["transient-inbox", "feishu-history"] });
  if (botSilent) assert.deepEqual(botSilent, { observingAgents: 3, wokenAgents: 0, replyingAgents: 0 });
  const botTarget = caseObservation(evidence, "strict-bot-target-at", ["observingAgents", "wokenAgents", "nonTargetReplyingAgents", "targetOnly", "realAt"], { allowSkipped: true, requiredSources: ["status-json", "feishu-history"] });
  if (botTarget) assert.deepEqual(botTarget, { observingAgents: 3, wokenAgents: 1, nonTargetReplyingAgents: 0, targetOnly: true, realAt: true });
  const atAll = caseObservation(evidence, "strict-at-all", ["observingAgents", "wokenAgents", "replyingAgents"], { allowSkipped: true, requiredSources: ["transient-inbox", "feishu-history"] });
  if (atAll) assert.deepEqual(atAll, { observingAgents: 3, wokenAgents: 0, replyingAgents: 0 });
  const noCooldown = caseObservation(evidence, "no-cooldown-two-directed", ["directedMessages", "targetWakeEvents", "cooldownDrops"], { allowSkipped: true, requiredSources: ["status-json", "feishu-history"] });
  if (noCooldown) assert.deepEqual(noCooldown, { directedMessages: 2, targetWakeEvents: 2, cooldownDrops: 0 });
});
