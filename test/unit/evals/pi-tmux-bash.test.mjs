import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  ContextPromptBuilder,
  LARKIN_STANDING_PROMPT_VERSION,
  PI_TMUX_BASH_GUIDANCE,
} from "../../../dist/agent/context-prompt.mjs";
import {
  LARKIN_TMUX_COMPLETION_TYPE,
  OWN_EXTENSION_NAME,
  OWN_TMUX_BASH_BUNDLE,
  commandMatchesTaskBash,
  extractTimedOutBackground,
  extractTmuxBashCompletion,
  findAutonomousCompletionTurn,
  gradePiTmuxBashTrace,
  loadPiTmuxBashEval,
  summarizePiTmuxBashEval,
} from "../../support/pi-tmux-bash-grader.mjs";
import {
  HEADLESS_PI_RPC_PREFIX,
  INTENDED_EVAL_COMMAND,
  INTENDED_EVAL_SCRIPT,
  LOCAL_PI_MODELS,
  UNAVAILABLE_PI_MODELS,
  assertHeadlessExtensionFixtureArgs,
  assertRequestedModelUsed,
  assertUserPiSettingsUnchanged,
  buildPiRpcArgs,
  buildTimedCommand,
  createIsolatedTmuxWorkspace,
  descendantProcesses,
  killIsolatedTmuxSession,
  listIsolatedTmuxWindows,
  parseCommandRuntime,
  parsePsAxRows,
  readOwnBuildRevision,
  requireExplicitEvalModel,
  requireOwnTmuxBashBundle,
  resolveOwnTmuxBashBundle,
  snapshotUserPiSettings,
  taskIdFromBashResult,
  windowsOwnedBy,
} from "../../support/pi-tmux-bash-live-harness.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DATASET = loadPiTmuxBashEval(path.join(ROOT, "evals/pi-tmux-bash/scenarios.json"));
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function buildPrompt(runtime = "pi") {
  return new ContextPromptBuilder().build({ agentId: "cli_eval", runtime });
}

function bashResult(taskId, status = "running", extra = {}) {
  return {
    details: { taskId, status, exitCode: status === "running" ? null : 0, output: extra.output || `taskId=${taskId} status=${status}`, ...extra.details },
    content: [{ type: "text", text: `taskId=${taskId} status=${status}` }],
  };
}

function completionEvent(marker, taskId = "task-done") {
  return {
    type: "agent_end",
    messages: [{
      role: "assistant",
      content: [{
        type: "custom",
        customType: LARKIN_TMUX_COMPLETION_TYPE,
        taskId,
        exitCode: 0,
        content: `Command finished\n${marker}`,
      }],
    }],
  };
}

test("pi-tmux-bash dataset pins own bundle revision, non-git cwd, and standing v31", () => {
  assert.equal(DATASET.dataset, "pi-tmux-bash");
  assert.equal(DATASET.version, 1);
  assert.equal(DATASET.standing_prompt_version, "larkin-standing-v31");
  assert.equal(DATASET.model.standing_prompt_version, "larkin-standing-v31");
  assert.equal(DATASET.workspace.success_path, "non-git-cwd");
  assert.equal(DATASET.workspace.cwd_preservation, "exact");
  assert.equal(DATASET.workspace.spaces_in_path, true);
  assert.equal(DATASET.workspace.production_claim, "non-git-cwd-required");
  assert.match(DATASET.workspace.larkin_note, /non-git/i);
  assert.match(DATASET.workspace.larkin_note, /spaces/i);
  assert.match(DATASET.workspace.larkin_note, /does not fall back to native bash/);
  assert.match(DATASET.workspace.larkin_note, /automatic completion after restart is not promised/);
  assert.equal(DATASET.grader.synthetic_fixtures, "unit-only");
  assert.equal(DATASET.harness.headless, true);
  assert.equal(DATASET.harness.tui_independent, true);
  assert.equal(DATASET.harness.intended_script, INTENDED_EVAL_SCRIPT);
  assert.deepEqual(DATASET.harness.pi_args, ["--mode", "rpc", "--no-session", "--no-extensions", "-e"]);
  assert.equal(DATASET.model.selection, "openai-codex/gpt-5.6-luna");
  assert.equal(DATASET.model.requires_explicit_env, true);
  assert.deepEqual(DATASET.model.local_available, LOCAL_PI_MODELS);
  assert.deepEqual(DATASET.model.not_available_locally, UNAVAILABLE_PI_MODELS);
  assert.equal(LOCAL_PI_MODELS.includes(DATASET.model.selection), true);
  assert.match(INTENDED_EVAL_COMMAND, /LARKIN_PI_TMUX_BASH_EVAL_MODEL=openai-codex\/gpt-5\.6-luna/);
  assert.equal(DATASET.threshold, 0.6);
  assert.equal(DATASET.core_acceptance_rate, 1);
  assert.match(DATASET.threshold_rationale, /natural user request/);
  assert.match(DATASET.threshold_rationale, /must all pass/);
  assert.match(DATASET.threshold_rationale, /not real Pi model-eval evidence/);
  assert.equal(DATASET.grader.version, 1);
  assert.equal(DATASET.grader.threshold, 0.6);
  assert.equal(DATASET.extension.name, OWN_EXTENSION_NAME);
  assert.equal(DATASET.extension.distribution, "larkin-owned-bundle");
  assert.equal(DATASET.extension.bundle, OWN_TMUX_BASH_BUNDLE);
  assert.equal(DATASET.extension.entry, "src/runtime/pi-tmux-extension.ts");
  assert.equal(DATASET.extension.core, "src/runtime/pi-tmux.ts");
  assert.deepEqual(DATASET.result_schema.internal_snapshots, ["startedAt", "endedAt"]);
  assert.equal(DATASET.extension.upstream, "not-used");
  assert.equal(DATASET.completion.customType, LARKIN_TMUX_COMPLETION_TYPE);
  assert.equal(DATASET.completion.triggerTurn, true);
  assert.equal(DATASET.result_schema.tmux_id, "taskId");
  assert.equal(DATASET.plugin, undefined);
  assert.deepEqual(DATASET.scenarios.map((scenario) => scenario.id), [
    "long-command-backgrounds-without-subagent",
    "wait-timeout-is-not-failure",
    "inspect-by-returned-id",
    "stop-by-returned-id",
    "completion-stays-in-originating-target",
    "no-forced-subagent-for-known-long",
    "natural-long-local-command",
  ]);
  const natural = DATASET.scenarios.find((scenario) => scenario.kind === "natural");
  assert.equal(natural.id, "natural-long-local-command");
  const prose = natural.prompt.replace(/`[^`]+`/g, "");
  assert.doesNotMatch(prose, /subagent|Agent tool|timeout|tmux|Feishu|bash tool|run_in_background|identifier/i);
});

test("standing prompt v31 replaces forced subagent rules with conditional tmux-backed bash guidance", () => {
  assert.equal(LARKIN_STANDING_PROMPT_VERSION, "larkin-standing-v31");
  const pi = buildPrompt("pi");
  assert.equal(pi.version, "larkin-standing-v31");
  assert.match(pi.content, /## Long-running commands \(pi\)/);
  for (const line of PI_TMUX_BASH_GUIDANCE) {
    assert.equal(pi.content.includes(line), true, line);
  }
  assert.match(pi.content, /If the current tools include a tmux-backed bash/);
  assert.match(pi.content, /timeout is not process failure/);
  assert.match(pi.content, /identifiers those tools return/);
  assert.match(pi.content, /originating conversation/);
  assert.match(pi.content, /Do not assume tmux or extra inspect\/stop tools exist unless they appear in the current tool list/);
  assert.match(pi.content, /If an available tool refuses the current workspace/);
  assert.match(pi.content, /Other authorized tools in the current list remain available/);
  assert.doesNotMatch(pi.content, /Do not invent a second background mechanism/);
  assert.doesNotMatch(pi.content, /## Background subagents \(pi\)/);
  assert.doesNotMatch(pi.content, /hard-capped at 60/);
  assert.doesNotMatch(pi.content, /Total lifetime is 600s/);
  assert.doesNotMatch(pi.content, /MUST use the Agent tool/);
  assert.doesNotMatch(pi.content, /run_in_background:\s*true/);
  assert.doesNotMatch(pi.content, /nohup/);
  assert.doesNotMatch(pi.content, /supervised_start/);
  assert.doesNotMatch(pi.content, /ONLY supported background mechanism/);
  assert.doesNotMatch(pi.content, /getGitRoot|git init|git repository|production workspace|Larkin Agent workspace/i);
  const remainder = PI_TMUX_BASH_GUIDANCE.reduce((text, line) => text.replaceAll(line, ""), pi.content);
  assert.doesNotMatch(remainder, /tmux-backed bash/);
  const other = buildPrompt("codex");
  assert.doesNotMatch(other.content, /## Long-running commands \(pi\)/);
  assert.doesNotMatch(other.content, /tmux-backed bash/);
});

test("synthetic grader fixtures are unit checks, not model-eval evidence", () => {
  const traces = {
    "long-command-backgrounds-without-subagent": [
      { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 8 && echo larkin-tmux-eval-long", timeout: 5 } },
      { type: "tool_execution_end", toolName: "bash", result: bashResult("task-42") },
      { type: "agent_end" },
    ],
    "wait-timeout-is-not-failure": [
      { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 12 && echo larkin-tmux-eval-timeout", timeout: 3 } },
      { type: "tool_execution_end", toolName: "bash", result: bashResult("task-99") },
      { type: "agent_end" },
    ],
    "inspect-by-returned-id": [
      { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 20 && echo larkin-tmux-eval-peek" } },
      { type: "tool_execution_end", toolName: "bash", result: bashResult("task-77") },
      { type: "tool_execution_start", toolName: "tmux", args: { action: "peek", taskId: "task-77" } },
      { type: "tool_execution_end", toolName: "tmux", result: { details: { taskId: "task-77", status: "running", exitCode: null, output: "peek" } } },
      { type: "agent_end" },
    ],
    "stop-by-returned-id": [
      { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 120 && echo larkin-tmux-eval-kill" } },
      { type: "tool_execution_end", toolName: "bash", result: bashResult("task-88") },
      { type: "tool_execution_start", toolName: "tmux", args: { action: "kill", taskId: "task-88" } },
      { type: "tool_execution_end", toolName: "tmux", result: { details: { taskId: "task-88", status: "cancelled", exitCode: null, output: "killed" } } },
      { type: "agent_end" },
    ],
    "completion-stays-in-originating-target": [
      { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 40 && echo larkin-tmux-eval-done", background: true } },
      { type: "tool_execution_end", toolName: "bash", result: bashResult("task-12") },
      { type: "agent_end" },
      { type: "turn_start" },
      { customType: LARKIN_TMUX_COMPLETION_TYPE, taskId: "task-12", exitCode: 0, content: "Command finished\nlarkin-tmux-eval-done" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "larkin-tmux-eval-done finished here" } },
      { type: "agent_end" },
      { type: "agent_settled" },
    ],
    "no-forced-subagent-for-known-long": [
      { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 8 && echo larkin-tmux-eval-deploy", background: true } },
      { type: "tool_execution_end", toolName: "bash", result: bashResult("task-15") },
      { type: "agent_end" },
    ],
    "natural-long-local-command": [
      { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 8 && echo larkin-tmux-eval-natural" } },
      { type: "tool_execution_end", toolName: "bash", result: bashResult("task-21") },
      { type: "agent_end" },
    ],
  };
  const graded = DATASET.scenarios.map((scenario) => ({
    id: scenario.id,
    ...gradePiTmuxBashTrace(scenario, traces[scenario.id]),
  }));
  for (const result of graded) {
    assert.equal(result.passed, true, `${result.id}: ${JSON.stringify(result.results)}`);
  }
  const summary = summarizePiTmuxBashEval(graded);
  assert.equal(summary.passed, DATASET.scenarios.length);
  assert.equal(DATASET.grader.synthetic_fixtures, "unit-only");
});

test("grader rejects Agent/subagent delegation and missing inspect/stop IDs", () => {
  const long = DATASET.scenarios.find((scenario) => scenario.id === "long-command-backgrounds-without-subagent");
  const forced = gradePiTmuxBashTrace(long, [
    { type: "tool_execution_start", toolName: "Agent", args: { prompt: "run it", run_in_background: true } },
    { type: "agent_end" },
  ]);
  assert.equal(forced.passed, false);
  assert.equal(forced.results.no_forced_subagent, false);

  const inspect = DATASET.scenarios.find((scenario) => scenario.id === "inspect-by-returned-id");
  const noPeek = gradePiTmuxBashTrace(inspect, [
    { type: "tool_execution_start", toolName: "bash", args: { command: inspect.task_bash } },
    { type: "tool_execution_end", toolName: "bash", result: bashResult("task-1") },
    { type: "agent_end" },
  ]);
  assert.equal(noPeek.passed, false);
  assert.equal(noPeek.results.inspects_by_returned_id, false);

  const wrongCommand = gradePiTmuxBashTrace(long, [
    { type: "tool_execution_start", toolName: "bash", args: { command: "echo not-the-task" } },
    { type: "tool_execution_end", toolName: "bash", result: bashResult("task-99") },
    { type: "agent_end" },
  ]);
  assert.equal(wrongCommand.results.uses_bash, false);
  assert.equal(wrongCommand.results.returned_id, false);

  const peekInvented = gradePiTmuxBashTrace(inspect, [
    { type: "tool_execution_start", toolName: "bash", args: { command: inspect.task_bash } },
    { type: "tool_execution_end", toolName: "bash", result: bashResult("task-77") },
    { type: "tool_execution_start", toolName: "tmux", args: { action: "peek", taskId: "task-99" } },
    { type: "agent_end" },
  ]);
  assert.equal(peekInvented.results.inspects_by_returned_id, false);

  const peekWindowIsNotTaskId = gradePiTmuxBashTrace(inspect, [
    { type: "tool_execution_start", toolName: "bash", args: { command: inspect.task_bash } },
    { type: "tool_execution_end", toolName: "bash", result: bashResult("task-77") },
    { type: "tool_execution_start", toolName: "tmux", args: { action: "peek", window: "task-77" } },
    { type: "agent_end" },
  ]);
  assert.equal(peekWindowIsNotTaskId.results.inspects_by_returned_id, false);

  const listIsNotInspect = gradePiTmuxBashTrace(inspect, [
    { type: "tool_execution_start", toolName: "bash", args: { command: inspect.task_bash } },
    { type: "tool_execution_end", toolName: "bash", result: bashResult("task-77") },
    { type: "tool_execution_start", toolName: "tmux", args: { action: "list" } },
    { type: "agent_end" },
  ]);
  assert.equal(listIsNotInspect.results.inspects_by_returned_id, false);

  const atWindowIsNotId = gradePiTmuxBashTrace(inspect, [
    { type: "tool_execution_start", toolName: "bash", args: { command: inspect.task_bash } },
    { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "Still running @77" }] } },
    { type: "tool_execution_start", toolName: "tmux", args: { action: "peek", window: "@77" } },
    { type: "agent_end" },
  ]);
  assert.equal(atWindowIsNotId.results.returned_id, false);
  assert.equal(atWindowIsNotId.results.inspects_by_returned_id, false);

  const completion = DATASET.scenarios.find((scenario) => scenario.id === "completion-stays-in-originating-target");
  const receiptOnly = gradePiTmuxBashTrace(completion, [
    { type: "tool_execution_start", toolName: "bash", args: { command: completion.task_bash } },
    { type: "tool_execution_end", toolName: "bash", result: bashResult("task-12") },
    { type: "agent_end" },
    completionEvent("larkin-tmux-eval-done"),
  ]);
  assert.equal(receiptOnly.results.completion_followup, false);
  assert.equal(receiptOnly.results.final_summary, false);
});

test("completion extractor only accepts larkin-tmux-completion followUp", () => {
  assert.equal(extractTmuxBashCompletion({ customType: "subagent-notification" }), null);
  assert.equal(extractTmuxBashCompletion({ customType: "tmux-bash-completion" }), null);
  assert.equal(extractTmuxBashCompletion(completionEvent("done"))?.customType, LARKIN_TMUX_COMPLETION_TYPE);
});

test("headless RPC fixture args and unprompted completion turn are independent of TUI", () => {
  const bundlePath = path.resolve(OWN_TMUX_BASH_BUNDLE);
  const args = buildPiRpcArgs({
    bundlePath,
    loadMode: "extension",
    model: "openai-codex/gpt-5.6-luna",
  });
  assert.deepEqual(args.slice(0, 4), HEADLESS_PI_RPC_PREFIX);
  assert.equal(assertHeadlessExtensionFixtureArgs(args, bundlePath), true);
  const timeoutEnd = {
    type: "tool_execution_end",
    toolName: "bash",
    result: bashResult("task-5"),
  };
  assert.equal(extractTimedOutBackground(timeoutEnd)?.status, "running");
  assert.equal(extractTimedOutBackground(timeoutEnd)?.taskId, "task-5");
  const firstEnd = { type: "agent_end" };
  const secondStart = { type: "turn_start" };
  const completion = { customType: LARKIN_TMUX_COMPLETION_TYPE, taskId: "task-5", exitCode: 0, content: "Command finished\nlarkin-tmux-eval-done" };
  const assistant = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "larkin-tmux-eval-done finished here" } };
  const settled = { type: "agent_settled" };
  const found = findAutonomousCompletionTurn([timeoutEnd, firstEnd, secondStart, completion, assistant, settled], firstEnd);
  assert.equal(found?.completion?.customType, LARKIN_TMUX_COMPLETION_TYPE);
  assert.equal(found.turnStart, secondStart);
  assert.match(found.assistantText, /larkin-tmux-eval-done/);
  assert.equal(found.settled, settled);
  assert.equal(findAutonomousCompletionTurn([timeoutEnd, firstEnd, completion], firstEnd), null);
  assert.equal(commandMatchesTaskBash("sleep 8 && echo larkin-tmux-eval-long", "sleep 8 && echo larkin-tmux-eval-long"), true);
  assert.equal(commandMatchesTaskBash("echo other", "sleep 8 && echo larkin-tmux-eval-long"), false);
});

test("isolated harness uses the own bundle path and does not write user Pi settings", () => {
  const snapshot = snapshotUserPiSettings();
  const workspace = createIsolatedTmuxWorkspace("larkin-tmux-unit-");
  try {
    assert.equal(workspace.gitFixture, false);
    assert.equal(workspace.spacesInPath, true);
    assert.equal(fs.existsSync(path.join(workspace.workDir, ".git")), false);
    assert.match(workspace.workDir, /work dir$/);
    const revision = readOwnBuildRevision(ROOT);
    assert.equal(revision.name, OWN_EXTENSION_NAME);
    assert.equal(revision.bundle, OWN_TMUX_BASH_BUNDLE);
    assert.equal(revision.entry, "src/runtime/pi-tmux-extension.ts");
    assert.equal(revision.core, "src/runtime/pi-tmux.ts");
    assert.equal(revision.package_version, PACKAGE.version);
    assert.equal(revision.upstream, "not-used");
    assert.equal(resolveOwnTmuxBashBundle(ROOT, {}), path.join(ROOT, OWN_TMUX_BASH_BUNDLE));
    const liveEntry = path.join(workspace.root, "pi-tmux-extension.ts");
    fs.writeFileSync(liveEntry, "export {}\n");
    assert.equal(
      resolveOwnTmuxBashBundle(ROOT, { LARKIN_PI_TMUX_BASH_EXTENSION: liveEntry }),
      path.resolve(liveEntry),
    );
    assert.equal(
      requireOwnTmuxBashBundle(ROOT, { LARKIN_PI_TMUX_BASH_EXTENSION: liveEntry }),
      path.resolve(liveEntry),
    );
    const extensionArgs = buildPiRpcArgs({
      bundlePath: resolveOwnTmuxBashBundle(ROOT, {}),
      loadMode: "extension",
      model: DATASET.model.selection,
    });
    assert.deepEqual(extensionArgs.slice(0, 4), HEADLESS_PI_RPC_PREFIX);
    assert.equal(assertHeadlessExtensionFixtureArgs(extensionArgs, resolveOwnTmuxBashBundle(ROOT, {})), true);
    assert.equal(extensionArgs.includes("-e"), true);
    assert.doesNotMatch(extensionArgs.join(" "), /@richardgill|0\.0\.12/);
    assertUserPiSettingsUnchanged(snapshot);
  } finally {
    killIsolatedTmuxSession(workspace.sessionName);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("harness default workspace is non-git with spaces; git fixture is optional", () => {
  const nongit = createIsolatedTmuxWorkspace({ prefix: "larkin-tmux-nongit-" });
  const git = createIsolatedTmuxWorkspace({ prefix: "larkin-tmux-git-", git: true, spaces: false });
  try {
    assert.equal(nongit.gitFixture, false);
    assert.equal(nongit.spacesInPath, true);
    assert.equal(fs.existsSync(path.join(nongit.workDir, ".git")), false);
    assert.equal(git.gitFixture, true);
    assert.equal(fs.existsSync(path.join(git.workDir, ".git")), true);
    assert.equal(git.spacesInPath, false);
  } finally {
    killIsolatedTmuxSession(git.sessionName);
    killIsolatedTmuxSession(nongit.sessionName);
    fs.rmSync(git.root, { recursive: true, force: true });
    fs.rmSync(nongit.root, { recursive: true, force: true });
  }
});

test("prompt-eval files do not commit upstream package pins or machine-specific paths", () => {
  const files = [
    "evals/pi-tmux-bash/scenarios.json",
    "test/support/pi-tmux-bash-grader.mjs",
    "test/support/pi-tmux-bash-live-harness.mjs",
    "test/live/pi-tmux-bash-live.test.mjs",
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.doesNotMatch(text, /\/tmp\/larkin-tmux-package/);
    assert.doesNotMatch(text, /DEFAULT_EXTRACTED_PACKAGE|DEFAULT_ISOLATED_PACKAGE/);
    assert.doesNotMatch(text, /@richardgill\/pi-tmux-bash/);
    assert.doesNotMatch(text, /0\.0\.12/);
    assert.doesNotMatch(text, /pi-tmux-bash\.bundle\.js/);
    assert.doesNotMatch(text, /LARKIN_PI_TMUX_BASH_PACKAGE/);
    assert.doesNotMatch(text, /prepareIsolatedTmuxBashPackage/);
    assert.doesNotMatch(text, /npm install/);
    assert.doesNotMatch(text, /discoverIsolatedTmuxWindows/);
    assert.doesNotMatch(text, /windowIdFromBashResult/);
  }
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /Pi keeps native bash/);
  assert.doesNotMatch(readme, /those sessions stay on Pi's native bash/);
  assert.doesNotMatch(readme, /Published 0\.0\.12/);
});

test("real Pi runs require an explicit local model and the own bundle", () => {
  assert.throws(() => requireExplicitEvalModel({}), /LARKIN_PI_TMUX_BASH_EVAL_MODEL is required/);
  assert.throws(() => requireExplicitEvalModel({ LARKIN_PI_TMUX_BASH_EVAL_MODEL: "" }), /required/);
  assert.equal(requireExplicitEvalModel({ LARKIN_PI_TMUX_BASH_EVAL_MODEL: "other-provider/other-model" }), "other-provider/other-model");
  assert.throws(() => requireExplicitEvalModel({ LARKIN_PI_TMUX_BASH_EVAL_MODEL: "missing-provider" }), /provider\/model/);
  assert.equal(
    requireExplicitEvalModel({ LARKIN_PI_TMUX_BASH_EVAL_MODEL: "openai-codex/gpt-5.6-luna" }),
    "openai-codex/gpt-5.6-luna",
  );
  assert.deepEqual(
    assertRequestedModelUsed("openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"),
    { requested: "openai-codex/gpt-5.6-luna", actual: "openai-codex/gpt-5.6-luna", recorded: "openai-codex/gpt-5.6-luna", matched: true },
  );
  assert.throws(
    () => assertRequestedModelUsed("openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"),
    /recorded actual=openai-codex\/gpt-5\.6-sol/,
  );
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-missing-bundle-"));
  try {
    assert.throws(() => requireOwnTmuxBashBundle(missingRoot, {}), /refusing upstream plugin/);
  } finally {
    fs.rmSync(missingRoot, { recursive: true, force: true });
  }
});

test("command runtime is taken from in-command timestamps, not leftover tmux windows or .out names", () => {
  const command = buildTimedCommand({ sleepSeconds: 65, marker: "larkin-runtime-marker" });
  assert.match(command, /LARKIN_CMD_START=/);
  assert.match(command, /LARKIN_CMD_END=/);
  assert.match(command, /LARKIN_CMD_RUNTIME_MS=/);
  assert.match(command, /time\.sleep\(65\)/);
  const runtime = parseCommandRuntime("LARKIN_CMD_START=1000.000 LARKIN_CMD_END=1065.250 LARKIN_CMD_RUNTIME_MS=65250 larkin-runtime-marker");
  assert.deepEqual(runtime, { startSec: 1000, endSec: 1065.25, runtimeMs: 65250 });
  assert.ok(runtime.runtimeMs > 60_000);
  assert.equal(parseCommandRuntime("window @9 still exists"), null);

  const rows = parsePsAxRows([
    "  10   1 /bin/zsh",
    "  11  10 python3 -c sleep",
    "  12  11 /bin/sleep 65",
    "  99  1 leftover-shell",
  ].join("\n"));
  assert.deepEqual(descendantProcesses(rows, 10).map((row) => row.pid), ["11", "12"]);
  assert.equal(descendantProcesses(rows, 99).length, 0);

  const harness = fs.readFileSync(path.join(ROOT, "test/support/pi-tmux-bash-live-harness.mjs"), "utf8");
  assert.doesNotMatch(harness, /readdirSync\(outputDir\)|readdirSync\(workspace\.outputDir\)/);
  assert.doesNotMatch(harness, /\.out\b/);
  assert.doesNotMatch(harness, /command:\s*"output-dir"/);
  assert.match(harness, /list-windows/);
  assert.equal(taskIdFromBashResult(bashResult("task-42")), "task-42");
  assert.equal(taskIdFromBashResult({ details: { taskId: "abc-1", status: "running" } }), "abc-1");
  assert.equal(taskIdFromBashResult({
    details: { taskId: "task-42", status: "running", exitCode: null, output: "", startedAt: 1000, endedAt: null },
  }), "task-42");
  assert.equal(taskIdFromBashResult({ details: { startedAt: 1000, endedAt: 2000, status: "completed" } }), null);
  assert.equal(taskIdFromBashResult("Still running in background tmux window @42"), null);
  assert.equal(taskIdFromBashResult("no identifier"), null);

  const live = fs.readFileSync(path.join(ROOT, "test/live/pi-tmux-bash-live.test.mjs"), "utf8");
  assert.match(live, /test\.skipIf\(!evalEnabled\)/);
  assert.match(live, /test\.skipIf\(!liveEnabled\)/);
  assert.doesNotMatch(live, /if\s*\(!evalEnabled\)\s*return/);
  assert.doesNotMatch(live, /if\s*\(!liveEnabled\)\s*return/);
  assert.doesNotMatch(live, /discoverIsolatedTmuxWindows/);
  assert.doesNotMatch(live, /not in a git repository/);
});

test("shared tmux session lists windows by recorded owner", () => {
  const workspace = createIsolatedTmuxWorkspace({ prefix: "larkin-tmux-owners-" });
  try {
    const created = spawnSync("tmux", ["new-session", "-d", "-s", workspace.sessionName, "-n", "owner-a"], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    spawnSync("tmux", ["set-option", "-w", "-t", `${workspace.sessionName}:owner-a`, "@larkin-tmux-owner", "owner-a"], { encoding: "utf8" });
    spawnSync("tmux", ["new-window", "-t", workspace.sessionName, "-n", "owner-b"], { encoding: "utf8" });
    spawnSync("tmux", ["set-option", "-w", "-t", `${workspace.sessionName}:owner-b`, "@larkin-tmux-owner", "owner-b"], { encoding: "utf8" });
    const windows = listIsolatedTmuxWindows(workspace.sessionName);
    assert.ok(windows.length >= 2, `expected two windows, got ${JSON.stringify(windows)}`);
    assert.equal(windowsOwnedBy(windows, "owner-a").length, 1);
    assert.equal(windowsOwnedBy(windows, "owner-b").length, 1);
    assert.equal(windowsOwnedBy(windows, "owner-a")[0].id === windowsOwnedBy(windows, "owner-b")[0].id, false);
  } finally {
    killIsolatedTmuxSession(workspace.sessionName);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});
