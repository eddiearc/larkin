import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { PiRpcClient } from "../../dist/runtime/pi-rpc-client.mjs";
import {
  LARKIN_TMUX_COMPLETION_TYPE,
  commandMatchesTaskBash,
  extractTimedOutBackground,
  findAutonomousCompletionTurn,
  gradePiTmuxBashTrace,
  loadPiTmuxBashEval,
  matchingBashEnds,
  summarizePiTmuxBashEval,
} from "../support/pi-tmux-bash-grader.mjs";
import {
  assertHeadlessExtensionFixtureArgs,
  assertRequestedModelUsed,
  assertUserPiSettingsUnchanged,
  buildPiRpcArgs,
  buildTimedCommand,
  childEnvForIsolatedPi,
  createIsolatedTmuxWorkspace,
  inspectRunningTmuxChild,
  INTENDED_EVAL_COMMAND,
  INTENDED_EVAL_SCRIPT,
  LOCAL_PI_MODELS,
  killIsolatedTmuxSession,
  parseCommandRuntime,
  piSessionIdFromState,
  requireExplicitEvalModel,
  requireOwnTmuxBashBundle,
  readOwnBuildRevision,
  selectedPiModel,
  snapshotUserPiSettings,
  spawnPiRpc,
  standingPromptFile,
  taskIdFromBashResult,
  waitFor,
} from "../support/pi-tmux-bash-live-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATASET = loadPiTmuxBashEval(path.join(ROOT, "evals/pi-tmux-bash/scenarios.json"));
const evalEnabled = process.env.LARKIN_RUN_PI_TMUX_BASH_EVAL === "1";
const liveEnabled = process.env.LARKIN_RUN_PI_TMUX_BASH_LIVE === "1";
const repetitions = Number.parseInt(process.env.LARKIN_PI_TMUX_BASH_EVAL_REPETITIONS || "1", 10);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) {
  throw new Error("LARKIN_PI_TMUX_BASH_EVAL_REPETITIONS must be an integer from 1 to 3");
}
const scenarioFilter = new Set((process.env.LARKIN_PI_TMUX_BASH_EVAL_SCENARIOS || "")
  .split(",").map((item) => item.trim()).filter(Boolean));
const threshold = Number.parseFloat(process.env.LARKIN_PI_TMUX_BASH_EVAL_THRESHOLD || String(DATASET.threshold));
const requestedModel = (evalEnabled || liveEnabled) ? requireExplicitEvalModel() : null;

const workspaces = [];
afterAll(() => {
  for (const workspace of workspaces) {
    killIsolatedTmuxSession(workspace.sessionName);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

function subscribeTrace(client, trace) {
  client.subscribe((event) => trace.push({ ...event, observedAt: Date.now() }));
}

function agentEndCount(trace) {
  return trace.filter((event) => event?.type === "agent_end").length;
}

function bashResultText(event) {
  return event?.result ? JSON.stringify(event.result) : String(event?.resultText || "");
}

function matchingBashEnd(trace, taskBash) {
  return matchingBashEnds(trace, taskBash)[0] || null;
}

async function waitUntilIdle(session, timeoutMs = 180_000) {
  const before = agentEndCount(session.trace);
  const last = [...session.trace].reverse().find((event) => event?.type === "agent_end" || event?.type === "tool_execution_start");
  if (last?.type === "agent_end" && !session.trace.slice(session.trace.indexOf(last) + 1).some((event) => event?.type === "tool_execution_start")) {
    return last;
  }
  return waitFor(session.trace, (event) => event?.type === "agent_end" && agentEndCount(session.trace) > before, timeoutMs);
}

async function promptWhenIdle(session, message) {
  try {
    await waitUntilIdle(session, 30_000);
  } catch {
    // 仍在处理则走 followUp，避免写入用户设置或重启进程
  }
  const before = agentEndCount(session.trace);
  try {
    await hostPrompt(session, message);
  } catch (error) {
    if (!/already processing/i.test(String(error))) throw error;
    await hostPrompt(session, message, { streamingBehavior: "followUp" });
  }
  return waitFor(session.trace, (event) => event?.type === "agent_end" && agentEndCount(session.trace) > before, 180_000);
}

async function startIsolatedPi({ appendPrompt = true, git = false, workspace } = {}) {
  const snapshot = snapshotUserPiSettings();
  const bundlePath = requireOwnTmuxBashBundle(ROOT);
  const build = readOwnBuildRevision(ROOT);
  console.log(`[live-build] version=${build.package_version} bundle_sha256=${build.bundle_sha256}`);
  if (!workspace) {
    workspace = createIsolatedTmuxWorkspace({
      prefix: git ? "larkin-tmux-git-" : "larkin-tmux-eval-",
      git,
      spaces: true,
    });
    workspaces.push(workspace);
  }
  const extraArgs = [];
  if (appendPrompt) {
    const standing = new ContextPromptBuilder().build({ agentId: "cli_tmux_eval", runtime: "pi" });
    extraArgs.push("--append-system-prompt", standingPromptFile(workspace, standing.content));
  }
  const model = requireExplicitEvalModel();
  const args = buildPiRpcArgs({ bundlePath, loadMode: "extension", model, extraArgs });
  const child = spawnPiRpc({ args, cwd: workspace.workDir, env: childEnvForIsolatedPi(workspace) });
  const trace = [];
  const client = new PiRpcClient(child, { requestTimeoutMs: 30_000, inputTimeoutMs: 180_000, inputMaxTimeoutMs: 600_000 });
  subscribeTrace(client, trace);
  let state;
  try { state = await client.request("get_state"); }
  catch (error) { await client.close(); throw error; }
  const selected = selectedPiModel(state);
  const modelRecord = assertRequestedModelUsed(model, selected);
  assertHeadlessExtensionFixtureArgs(args, bundlePath);
  console.log(`[live] pi extension gitFixture=${workspace.gitFixture} spaces=${workspace.spacesInPath} bundle=${bundlePath} requested=${modelRecord.requested} actual=${modelRecord.actual} session=${workspace.sessionName} cwd=${workspace.workDir}`);
  return {
    snapshot, workspace, child, client, trace, bundlePath, state,
    requestedModel: model, selectedModel: selected, args, hostPromptCount: 0,
    piSessionId: piSessionIdFromState(state),
  };
}

async function hostPrompt(session, message, extra = {}) {
  session.hostPromptCount += 1;
  return session.client.request("prompt", { message, ...extra });
}

async function stopIsolatedPi(session, { keepSession = false } = {}) {
  try { await session.client.close(); } catch { /* already closed */ }
  if (!keepSession) killIsolatedTmuxSession(session.workspace.sessionName);
  assertUserPiSettingsUnchanged(session.snapshot);
}

test("pi-tmux-bash eval starts from the fixed scenario dataset", () => {
  assert.equal(DATASET.model.selection, "openai-codex/gpt-5.6-luna");
  assert.equal(DATASET.model.requires_explicit_env, true);
  assert.deepEqual(DATASET.model.local_available, [
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-luna",
    "zai-coding-cn/glm5.3",
  ]);
  assert.deepEqual(DATASET.model.not_available_locally, ["opencode-go/deepseek-v4-flash"]);
  assert.equal(LOCAL_PI_MODELS.includes(DATASET.model.selection), true);
  assert.match(INTENDED_EVAL_COMMAND, /LARKIN_PI_TMUX_BASH_EVAL_MODEL=openai-codex\/gpt-5\.6-luna/);
  assert.equal(DATASET.standing_prompt_version, "larkin-standing-v32");
  assert.equal(DATASET.workspace.success_path, "non-git-cwd");
  assert.equal(DATASET.workspace.cwd_preservation, "exact");
  assert.equal(DATASET.workspace.spaces_in_path, true);
  assert.equal(DATASET.workspace.production_claim, "non-git-cwd-required");
  assert.match(DATASET.workspace.larkin_note, /does not fall back to native bash/);
  assert.equal(DATASET.grader.synthetic_fixtures, "unit-only");
  assert.equal(DATASET.extension.bundle, "dist/runtime/pi-tmux.bundle.js");
  assert.equal(DATASET.extension.entry, "src/runtime/pi-tmux-extension.ts");
  assert.equal(DATASET.extension.core, "src/runtime/pi-tmux.ts");
  assert.equal(DATASET.completion.customType, LARKIN_TMUX_COMPLETION_TYPE);
  assert.equal(DATASET.harness.headless, true);
  assert.equal(DATASET.harness.tui_independent, true);
  assert.equal(DATASET.harness.intended_script, INTENDED_EVAL_SCRIPT);
  assert.deepEqual(DATASET.harness.pi_args, ["--mode", "rpc", "--no-session", "--no-extensions", "-e"]);
  assert.equal(DATASET.core_acceptance_rate, 1);
  assert.match(DATASET.threshold_rationale, /deterministic/);
  assert.deepEqual(DATASET.scenarios.map((scenario) => scenario.id), [
    "long-command-backgrounds-without-subagent",
    "wait-timeout-is-not-failure",
    "inspect-by-returned-id",
    "stop-by-returned-id",
    "completion-stays-in-originating-target",
    "no-forced-subagent-for-known-long",
    "natural-long-local-command",
  ]);
});

async function runScenario(scenario) {
  const session = await startIsolatedPi();
  try {
    await hostPrompt(session, scenario.prompt);
    await waitFor(session.trace, (event) => event?.type === "agent_end", 300_000);
    if (scenario.wait_for_completion) {
      try {
        const firstEnd = session.trace.find((event) => event?.type === "agent_end");
        await waitFor(session.trace, () => findAutonomousCompletionTurn(session.trace, firstEnd), 180_000);
      } catch {
        // 由 rubric 判定缺失有序 autonomous completion
      }
    }
    return gradePiTmuxBashTrace(scenario, session.trace);
  } finally {
    await stopIsolatedPi(session);
  }
}

for (const scenario of DATASET.scenarios) {
  if (scenarioFilter.size > 0 && !scenarioFilter.has(scenario.id)) continue;
  test.skipIf(!evalEnabled)(`pi-tmux-bash scenario ${scenario.id} (${repetitions}x, threshold ${threshold})`, async () => {
    const graded = [];
    for (let i = 0; i < repetitions; i++) graded.push(await runScenario(scenario));
    const summary = summarizePiTmuxBashEval(graded);
    console.log(`[eval] ${scenario.id}: ${summary.passed}/${summary.total} passed (rate ${summary.rate})`);
    for (const grade of graded) {
      if (!grade.passed) console.log(`[eval]   failed rubric: ${JSON.stringify(grade.results)}`);
    }
    assert.ok(summary.rate >= threshold,
      `scenario ${scenario.id} pass rate ${summary.rate} below threshold ${threshold}`);
  }, { timeout: 900_000 });
}

test.skipIf(!liveEnabled)("opt-in live RPC: non-git cwd with spaces preserves exact pwd", async () => {
  const session = await startIsolatedPi({ git: false });
  try {
    assert.equal(session.workspace.gitFixture, false);
    assert.equal(session.workspace.spacesInPath, true);
    assert.equal(fs.existsSync(path.join(session.workspace.workDir, ".git")), false);
    const marker = "larkin-tmux-nongit";
    await hostPrompt(session, [
      "Use only currently available tools and synthetic local commands. No Feishu.",
      `Run exactly: pwd && echo ${marker}`,
      "Then end the turn. Do not use an Agent or subagent.",
    ].join(" "));
    await waitFor(session.trace, (event) => event?.type === "tool_execution_end" && event.toolName === "bash", 180_000);
    const bashEnd = matchingBashEnd(session.trace, `pwd && echo ${marker}`);
    assert.ok(bashEnd, "must execute the requested cwd command");
    const bashText = bashResultText(bashEnd);
    assert.match(bashText, new RegExp(marker));
    const pwdLine = String(bashEnd.result.details.output).trim().split("\n")[0];
    assert.equal(fs.realpathSync(pwdLine), fs.realpathSync(session.workspace.workDir), "Pi's physical cwd must be the exact requested directory");
    console.log(`[live] non-git cwd with spaces preserved: ${session.workspace.workDir}`);
  } finally {
    await stopIsolatedPi(session);
  }
}, { timeout: 300_000 });

test.skipIf(!liveEnabled)("opt-in live RPC: >60s wait-timeout background and unprompted larkin-tmux-completion turn", async () => {
  const session = await startIsolatedPi({ git: false });
  const marker = `LARKIN_TMUX_LIVE_${Date.now()}`;
  const timedCommand = buildTimedCommand({ sleepSeconds: 65, marker });
  try {
    assertHeadlessExtensionFixtureArgs(session.args, session.bundlePath);
    assert.equal(session.selectedModel, session.requestedModel);
    await hostPrompt(session, [
      "Use only currently available tools and synthetic local commands. No Feishu.",
      `Start exactly: ${timedCommand}`,
      "Use a short wait timeout (2-5 seconds) so the wait returns first. That timeout is not failure.",
      "Report any taskId and end the turn. Do not kill the process. Do not send a second host prompt.",
      `When the completion notification arrives, include the final output marker ${marker} in your completion reply.`,
    ].join(" "));
    const bashStart = await waitFor(session.trace, (event) =>
      event?.type === "tool_execution_start" && event.toolName === "bash"
      && commandMatchesTaskBash(event.args?.command, timedCommand), 180_000);
    const toolStartedAt = bashStart.observedAt;
    assert.ok(bashStart, "lifetime is measured from the matching bash tool_execution_start, not the pre-model prompt");
    await waitFor(session.trace, (event) => event?.type === "tool_execution_end" && event.toolName === "bash", 180_000);
    const bashEnd = matchingBashEnd(session.trace, timedCommand);
    const bashText = bashResultText(bashEnd);
    assert.ok(extractTimedOutBackground(bashEnd) || extractTimedOutBackground(session.trace),
      `bash result must carry a running taskId after the wait window: ${bashText.slice(0, 400)}`);
    const taskId = taskIdFromBashResult(bashEnd?.result || bashText);
    assert.ok(taskId, `taskId must come from the matching bash result details, not a tmux list or .out name: ${bashText.slice(0, 400)}`);
    const childAfterTimeout = inspectRunningTmuxChild(session.workspace.sessionName, taskId, session.workspace.workDir);
    assert.equal(childAfterTimeout.running, true,
      `actual child for taskId ${taskId} must still be running after wait timeout: ${JSON.stringify(childAfterTimeout.processes)}`);

    const remaining = 60_000 - (Date.now() - toolStartedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining + 250));
    const childAfter60 = inspectRunningTmuxChild(session.workspace.sessionName, taskId, session.workspace.workDir);
    assert.equal(childAfter60.running, true,
      `child must still be running >60s after tool_execution_start: elapsed=${Date.now() - toolStartedAt}ms ${JSON.stringify(childAfter60.processes)}`);
    assert.ok(Date.now() - toolStartedAt > 60_000, "liveness clock is the matching tool start, not leftover autoClose=false windows");
    console.log(`[live] wait-timeout background ${taskId} childPid=${childAfter60.panePid} elapsedMs=${Date.now() - toolStartedAt} requested=${session.requestedModel} actual=${session.selectedModel}`);

    const firstEnd = await waitFor(session.trace, (event) => event?.type === "agent_end", 180_000);
    assert.equal(session.hostPromptCount, 1, "first turn must be the only host prompt so far");

    await waitFor(session.trace, () => findAutonomousCompletionTurn(session.trace, firstEnd), 90_000);
    assert.equal(session.hostPromptCount, 1, "completion handling must be an unprompted autonomous turn");
    const unprompted = findAutonomousCompletionTurn(session.trace, firstEnd);
    assert.ok(unprompted?.completion, "unprompted turn must carry larkin-tmux-completion");
    assert.equal(unprompted.completion.customType, LARKIN_TMUX_COMPLETION_TYPE);
    assert.ok(unprompted.turnStart, "post-completion handling requires turn_start");
    assert.ok(unprompted.assistantText.trim(), "post-completion handling requires assistant output");
    assert.ok(unprompted.settled, "post-completion handling requires agent_end or agent_settled");
    const completionText = JSON.stringify(unprompted.completion);
    assert.match(completionText, new RegExp(marker));
    assert.match(unprompted.assistantText, new RegExp(marker));
    const runtime = parseCommandRuntime(completionText);
    assert.ok(runtime, `completion must include in-command start/end timestamps: ${completionText.slice(0, 400)}`);
    assert.ok(runtime.runtimeMs > 60_000,
      `in-command runtime ${runtime.runtimeMs}ms must exceed 60s (start=${runtime.startSec} end=${runtime.endSec})`);
    console.log(`[live] autonomous completion settled; in-command runtime ${runtime.runtimeMs}ms`);
    await waitUntilIdle(session, 60_000).catch(() => {});

    if (!session.trace.some((event) =>
      event?.type === "tool_execution_start" && event.toolName === "tmux" && event.args?.action === "peek"
      && String(event.args?.taskId) === taskId)) {
      await promptWhenIdle(session,
        `Inspect/peek only taskId ${taskId} with the current tmux tool, then end the turn. Do not kill it. No Feishu.`);
    }
    const peek = session.trace.find((event) =>
      event?.type === "tool_execution_start" && event.toolName === "tmux" && event.args?.action === "peek"
      && String(event.args?.taskId) === taskId);
    assert.ok(peek, "peek must use the bash-returned taskId");

    await promptWhenIdle(session,
      `Start exactly: sleep 180 && echo ${marker}-cancel. After you have a taskId from that bash result, peek it, then stop/kill that same taskId. No Feishu, no Agent/subagent.`);
    await waitFor(session.trace, (event) =>
      event?.type === "tool_execution_start" && event.toolName === "tmux" && event.args?.action === "kill", 180_000);
    const kill = [...session.trace].reverse().find((event) =>
      event?.type === "tool_execution_start" && event.toolName === "tmux" && event.args?.action === "kill");
    assert.ok(kill?.args?.taskId, "cancel must use a returned taskId");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const afterKill = inspectRunningTmuxChild(session.workspace.sessionName, kill.args.taskId, session.workspace.workDir);
    assert.equal(afterKill.running, false, `killed taskId ${kill.args.taskId} must not still have a running child`);
    assert.equal(session.trace.some((event) =>
      event?.type === "tool_execution_start" && ["Agent", "supervised_start"].includes(event.toolName)), false);
    console.log(`[live] cancelled ${kill.args.taskId}`);
  } finally {
    await stopIsolatedPi(session);
  }
}, { timeout: 900_000 });

test.skipIf(!liveEnabled)("opt-in live RPC: shared session isolates two Pi owners by taskId", async () => {
  const workspace = createIsolatedTmuxWorkspace({ prefix: "larkin-tmux-shared-", git: false, spaces: true });
  workspaces.push(workspace);
  const ownerA = await startIsolatedPi({ workspace });
  const ownerB = await startIsolatedPi({ workspace });
  const marker = `LARKIN_TMUX_OWNER_${Date.now()}`;
  const command = `sleep 90 && echo ${marker}`;
  try {
    assert.equal(ownerA.workspace.sessionName, ownerB.workspace.sessionName);
    assert.equal(ownerA.selectedModel, ownerA.requestedModel);
    assert.equal(ownerB.selectedModel, ownerB.requestedModel);
    if (ownerA.piSessionId && ownerB.piSessionId) {
      assert.notEqual(ownerA.piSessionId, ownerB.piSessionId, "two Pi owners must have distinct session ids");
    }

    await hostPrompt(ownerA, [
      "Use only currently available tools and synthetic local commands. No Feishu.",
      `Start exactly: ${command}`,
      "Use a short wait timeout (2-5 seconds). Report the returned taskId and end the turn. Do not kill it.",
    ].join(" "));
    await waitFor(ownerA.trace, (event) =>
      event?.type === "tool_execution_start" && event.toolName === "bash"
      && commandMatchesTaskBash(event.args?.command, command), 180_000);
    await waitFor(ownerA.trace, (event) => event?.type === "tool_execution_end" && event.toolName === "bash", 180_000);
    const bashEnd = matchingBashEnd(ownerA.trace, command);
    const bashText = bashResultText(bashEnd);
    const taskId = taskIdFromBashResult(bashEnd?.result || bashText);
    assert.ok(taskId, `owner A taskId must come from its matching bash result: ${bashText.slice(0, 400)}`);
    const child = inspectRunningTmuxChild(workspace.sessionName, taskId, workspace.workDir);
    assert.equal(child.running, true, `owner A child must be running: ${JSON.stringify(child.processes)}`);

    await hostPrompt(ownerB, [
      "Use only currently available tools. No Feishu.",
      `List tmux jobs. Then peek ${taskId} and kill ${taskId}.`,
      "If the tools refuse that taskId, report the refusal and end the turn. Do not start a new command.",
    ].join(" "));
    await waitFor(ownerB.trace, (event) => event?.type === "agent_end", 180_000);
    const bTmux = ownerB.trace.filter((event) =>
      event?.type === "tool_execution_start" && event.toolName === "tmux");
    const bList = bTmux.find((event) => event.args?.action === "list");
    const bPeek = bTmux.find((event) => event.args?.action === "peek" && String(event.args?.taskId) === taskId);
    const bKill = bTmux.find((event) => event.args?.action === "kill" && String(event.args?.taskId) === taskId);
    assert.ok(bList || bPeek || bKill, "owner B must use the tmux tool against the shared session");
    const still = inspectRunningTmuxChild(workspace.sessionName, taskId, workspace.workDir);
    assert.equal(still.running, true, "owner B must not kill owner A's child");
    console.log(`[live] shared workspace isolated taskId=${taskId} ownerA=${ownerA.piSessionId || "unknown"} ownerB=${ownerB.piSessionId || "unknown"}`);
  } finally {
    await stopIsolatedPi(ownerB, { keepSession: true });
    await stopIsolatedPi(ownerA);
  }
}, { timeout: 600_000 });
