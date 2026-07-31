import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";
import {
  gradeAgentExperienceV6Trace,
  loadAgentExperienceV6Eval,
  summarizeAgentExperienceV6Eval,
} from "../../support/agent-experience-v6-grader.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DATASET = loadAgentExperienceV6Eval(path.join(ROOT, "evals/agent-experience-v6/scenarios.json"));

test("fixed Agent Experience v6 eval starts every selected scenario from an empty session", () => {
  assert.equal(DATASET.session.initial_turns, 0);
  assert.equal(DATASET.model.standing_prompt_version, "larkin-standing-v6");
  assert.deepEqual(DATASET.scenarios.map((scenario) => scenario.id), [
    "target-scoped-thread-read",
    "failed-thread-read-no-false-success",
    "exact-text-punctuation",
    "exact-reply-no-help",
    "precommit-exact-reply-safe-retry",
    "tool-sourced-verbatim-thread-reply",
    "exclusive-other-agent-silence",
    "committed-unverified-no-retry",
  ]);
});

test("golden fresh-session traces satisfy the full deterministic rubric", () => {
  const traces = Object.fromEntries(DATASET.scenarios.map((scenario) => [scenario.id, scenario.trace]));
  const result = summarizeAgentExperienceV6Eval(DATASET, traces);
  assert.equal(result.passed, true);
  assert.equal(result.pass_rate, 1);
  assert.equal(result.results.every((item) => item.passed), true);
});

test("grader rejects fallback, false success, text mutation, redundant discovery, unsafe retry, and duplicate writes", () => {
  const byId = Object.fromEntries(DATASET.scenarios.map((scenario) => [scenario.id, scenario]));
  const badThread = gradeAgentExperienceV6Trace(byId["target-scoped-thread-read"], [{
    action: "tool", command: "larkin im +chat-messages-list --chat-id oc_eval_thread 2>&1", exit_code: 0,
  }]);
  assert.deepEqual(new Set(badThread.failures.map((item) => item.rule)), new Set([
    "canonical_command", "forbidden_command", "stable_response_path",
  ]));

  const falseSuccess = gradeAgentExperienceV6Trace(byId["failed-thread-read-no-false-success"], [
    byId["failed-thread-read-no-false-success"].trace[0],
    { action: "provider_write", command: "larkin im +messages-send", transported_text: "remembered" },
  ]);
  assert.equal(falseSuccess.failures.some((item) => ["bounded_calls", "provider_write_count", "visible_failure", "no_memory_fallback"].includes(item.rule)), true);

  const changedText = structuredClone(byId["exact-text-punctuation"].trace);
  changedText[0].transported_text = "原文: \"修复 A/B\"; 不要改成 ASCII 引号。";
  changedText[0].shell_interpolation = true;
  assert.deepEqual(new Set(gradeAgentExperienceV6Trace(byId["exact-text-punctuation"], changedText).failures.map((item) => item.rule)),
    new Set(["exact_text", "shell_interpolation"]));

  const helpAndMarkdown = structuredClone(byId["exact-reply-no-help"].trace);
  helpAndMarkdown.splice(1, 0, {
    action: "tool", command: "larkin im +messages-reply --help", exit_code: 0,
  });
  helpAndMarkdown[2].command = "larkin im +messages-reply --message-id om_eval_exact_reply --markdown '收到：“A/B”' --json";
  const badExactReply = gradeAgentExperienceV6Trace(byId["exact-reply-no-help"], helpAndMarkdown);
  assert.deepEqual(new Set(badExactReply.failures.map((item) => item.rule)),
    new Set(["bounded_calls", "tool_call_count", "canonical_command", "forbidden_command"]));

  const conflictRetry = structuredClone(byId["precommit-exact-reply-safe-retry"].trace);
  conflictRetry[0].subtype = "freshness_conflict";
  assert.equal(gradeAgentExperienceV6Trace(byId["precommit-exact-reply-safe-retry"], conflictRetry).passed, true);
  const reversedRetry = [conflictRetry[1], conflictRetry[0]];
  assert.equal(gradeAgentExperienceV6Trace(byId["precommit-exact-reply-safe-retry"], reversedRetry)
    .failures.some((item) => item.rule === "safe_precommit_retry"), true);
  const zeroExitRetry = structuredClone(conflictRetry);
  zeroExitRetry[0].exit_code = 0;
  assert.equal(gradeAgentExperienceV6Trace(byId["precommit-exact-reply-safe-retry"], zeroExitRetry)
    .failures.some((item) => item.rule === "safe_precommit_retry"), true);
  const committedRetry = structuredClone(conflictRetry);
  committedRetry[0].provider_reached = true;
  assert.equal(gradeAgentExperienceV6Trace(byId["precommit-exact-reply-safe-retry"], committedRetry)
    .failures.some((item) => item.rule === "safe_precommit_retry"), true);

  const normalizedAndRediscovered = structuredClone(byId["tool-sourced-verbatim-thread-reply"].trace);
  normalizedAndRediscovered.splice(1, 0,
    { action: "tool", tool_name: "read", resource_path: "/skills/lark-im/SKILL.md", command: "read /skills/lark-im/SKILL.md", exit_code: 0 },
    { action: "tool", tool_name: "read", resource_path: "/skills/lark-im/references/messages.md", command: "read /skills/lark-im/references/messages.md", exit_code: 0 });
  normalizedAndRediscovered.at(-1).transported_text = '引用："抢到" 保留空格';
  const badToolSourcedReply = gradeAgentExperienceV6Trace(
    byId["tool-sourced-verbatim-thread-reply"], normalizedAndRediscovered);
  assert.deepEqual(new Set(badToolSourcedReply.failures.map((item) => item.rule)), new Set([
    "bounded_calls", "tool_call_count", "redundant_discovery_read", "exact_text",
  ]));

  const changedToolSource = structuredClone(byId["tool-sourced-verbatim-thread-reply"].trace);
  changedToolSource[1].source_text = '引用："抢到" 保留空格';
  changedToolSource[2].transported_text = changedToolSource[1].source_text;
  assert.deepEqual(new Set(gradeAgentExperienceV6Trace(byId["tool-sourced-verbatim-thread-reply"], changedToolSource)
    .failures.map((item) => item.rule)), new Set(["exact_text_source", "exact_text", "argv_source_binding"]));

  const sourceMovedToPoll = structuredClone(byId["tool-sourced-verbatim-thread-reply"].trace);
  sourceMovedToPoll[0].source_text = byId["tool-sourced-verbatim-thread-reply"].expected.exact_text;
  sourceMovedToPoll[1].source_text = '引用："抢到" 保留空格';
  assert.deepEqual(new Set(gradeAgentExperienceV6Trace(byId["tool-sourced-verbatim-thread-reply"], sourceMovedToPoll)
    .failures.map((item) => item.rule)), new Set(["exact_text_source", "exact_text", "argv_source_binding"]));

  for (const [label, argvText] of [
    ["ASCII quotes", '引用："抢到"  保留空格'],
    ["collapsed whitespace", "引用：“抢到” 保留空格"],
  ]) {
    const changedPlannedArgv = structuredClone(byId["tool-sourced-verbatim-thread-reply"].trace);
    changedPlannedArgv[2].argv_text = argvText;
    assert.equal(gradeAgentExperienceV6Trace(byId["tool-sourced-verbatim-thread-reply"], changedPlannedArgv)
      .failures.some((item) => item.rule === "argv_source_binding"), true, label);
  }

  const normalizationScenario = structuredClone(byId["tool-sourced-verbatim-thread-reply"]);
  const decomposedText = "Cafe\u0301";
  const normalizedText = decomposedText.normalize("NFC");
  const originalWriteCommand = normalizationScenario.expected.reply_anchor.write_command;
  const decomposedWriteCommand = originalWriteCommand.replace(normalizationScenario.expected.exact_text, decomposedText);
  normalizationScenario.expected.exact_text = decomposedText;
  normalizationScenario.expected.ordered_commands[2] = decomposedWriteCommand;
  normalizationScenario.expected.reply_anchor.write_command = decomposedWriteCommand;
  normalizationScenario.trace[1].source_text = decomposedText;
  normalizationScenario.trace[2] = {
    ...normalizationScenario.trace[2], command: decomposedWriteCommand,
    argv_text: normalizedText, transported_text: decomposedText,
  };
  assert.notEqual(normalizedText, decomposedText);
  assert.equal(gradeAgentExperienceV6Trace(normalizationScenario, normalizationScenario.trace)
    .failures.some((item) => item.rule === "argv_source_binding"), true, "Unicode normalization");

  const reorderedToolSourcedReply = structuredClone(byId["tool-sourced-verbatim-thread-reply"].trace);
  [reorderedToolSourcedReply[1], reorderedToolSourcedReply[2]] = [reorderedToolSourcedReply[2], reorderedToolSourcedReply[1]];
  assert.equal(gradeAgentExperienceV6Trace(byId["tool-sourced-verbatim-thread-reply"], reorderedToolSourcedReply)
    .failures.some((item) => item.rule === "canonical_order"), true);

  for (const index of [0, 1]) {
    const failedCanonicalRead = structuredClone(byId["tool-sourced-verbatim-thread-reply"].trace);
    failedCanonicalRead[index].exit_code = 2;
    assert.equal(gradeAgentExperienceV6Trace(byId["tool-sourced-verbatim-thread-reply"], failedCanonicalRead)
      .failures.some((item) => item.rule === "canonical_result"), true, `canonical read ${index}`);
  }

  const mismatchedReplyAnchor = structuredClone(byId["tool-sourced-verbatim-thread-reply"].trace);
  mismatchedReplyAnchor[0].message_id = "om_other";
  assert.equal(gradeAgentExperienceV6Trace(byId["tool-sourced-verbatim-thread-reply"], mismatchedReplyAnchor)
    .failures.some((item) => item.rule === "reply_anchor"), true);

  for (const id of ["exact-text-punctuation", "exact-reply-no-help", "precommit-exact-reply-safe-retry", "tool-sourced-verbatim-thread-reply"]) {
    const failedWrite = structuredClone(byId[id].trace);
    failedWrite.find((event) => event.action === "provider_write").exit_code = 9;
    assert.equal(gradeAgentExperienceV6Trace(byId[id], failedWrite)
      .failures.some((item) => item.rule === "provider_write_result"), true, id);
  }

  assert.equal(gradeAgentExperienceV6Trace(byId["exclusive-other-agent-silence"], [{
    action: "provider_write", command: "larkin im +messages-send", exit_code: 0,
  }]).failures.some((item) => item.rule === "exclusive_silence"), true);

  const duplicated = [...byId["committed-unverified-no-retry"].trace, ...byId["committed-unverified-no-retry"].trace];
  const duplicateGrade = gradeAgentExperienceV6Trace(byId["committed-unverified-no-retry"], duplicated);
  assert.equal(duplicateGrade.failures.some((item) => item.rule === "no_retry"), true);
});
