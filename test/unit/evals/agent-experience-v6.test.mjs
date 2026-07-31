import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
    "tool-sourced-verbatim-message-reply",
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
  const apostrophePrefix = DATASET.scenarios.find((scenario) => scenario.id === "tool-sourced-verbatim-message-reply");
  const shellSyntax = spawnSync("sh", ["-n", "-c", apostrophePrefix.trace[1].command], { encoding: "utf8" });
  assert.equal(shellSyntax.status, 0, shellSyntax.stderr);
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
    "bounded_calls", "tool_call_count", "redundant_discovery_read", "exclusive_source_selector", "exact_text",
  ]));

  for (const hiddenAction of [
    { action: "read", command: "read /skills/lark-im/SKILL.md", resource_path: "/skills/lark-im/SKILL.md" },
    { action: "command", command: "larkin im +messages-reply --help", exit_code: 0 },
  ]) {
    const hiddenDiscovery = structuredClone(byId["tool-sourced-verbatim-thread-reply"].trace);
    hiddenDiscovery.splice(1, 0, hiddenAction);
    assert.equal(gradeAgentExperienceV6Trace(byId["tool-sourced-verbatim-thread-reply"], hiddenDiscovery)
      .failures.some((item) => item.rule === "trace_action_schema"), true, hiddenAction.action);
  }

  const threadScenario = byId["tool-sourced-verbatim-thread-reply"];
  const messageScenario = byId["tool-sourced-verbatim-message-reply"];
  const threadPreview = {
    action: "tool", command: "larkin im +threads-messages-list --thread omt_eval_verbatim --order desc --page-size 10 --no-reactions --json",
    exit_code: 0, read_path: "data.messages",
  };
  const useSource = (write, sourceCommand, sourceTarget, sourceSelector) => {
    write.command = `larkin im +messages-reply --message-id ${write.message_id} --content "$(${sourceCommand})" --json`;
    write.source_command = sourceCommand;
    write.source_target = sourceTarget;
    write.source_selector = sourceSelector;
    write.composite_internal_commands = 2;
  };
  const mgetForThread = messageScenario.expected.exact_source_dataflow.source_command
    .replaceAll("om_eval_mget_source", "om_eval_discovered")
    .replace("作者'\\''s：", "引用：");
  const threadForMessage = threadScenario.expected.exact_source_dataflow.source_command
    .replaceAll("omt_eval_verbatim", "omt_eval_wrong")
    .replace("引用：", "作者'\\''s：");

  const previewThenMget = structuredClone(threadScenario.trace);
  previewThenMget.splice(1, 0, threadPreview);
  useSource(previewThenMget[2], mgetForThread, "message:om_eval_discovered", "message");
  const previewThenMgetGrade = gradeAgentExperienceV6Trace(threadScenario, previewThenMget);
  assert.equal(previewThenMgetGrade.failures.some((item) => item.rule === "exact_text"), false);
  assert.equal(previewThenMgetGrade.failures.some((item) => item.rule === "exclusive_source_selector"), true);

  const threadUsingMget = structuredClone(threadScenario.trace);
  useSource(threadUsingMget[1], mgetForThread, "message:om_eval_discovered", "message");
  assert.equal(gradeAgentExperienceV6Trace(threadScenario, threadUsingMget)
    .failures.some((item) => item.rule === "exclusive_source_selector"), true);

  const messageUsingThread = structuredClone(messageScenario.trace);
  useSource(messageUsingThread[1], threadForMessage, "thread:oc_eval_wrong:omt_eval_wrong", "thread");
  assert.equal(gradeAgentExperienceV6Trace(messageScenario, messageUsingThread)
    .failures.some((item) => item.rule === "exclusive_source_selector"), true);

  const crossTargetThread = structuredClone(threadScenario);
  const crossTargetSource = crossTargetThread.expected.exact_source_dataflow.source_command
    .replaceAll("omt_eval_verbatim", "omt_other");
  const crossTargetWrite = `larkin im +messages-reply --message-id om_eval_verbatim --content "$(${crossTargetSource})" --json`;
  crossTargetThread.expected.exact_source_dataflow.source_target = "thread:oc_other:omt_other";
  crossTargetThread.expected.exact_source_dataflow.source_command = crossTargetSource;
  crossTargetThread.expected.ordered_commands[1] = crossTargetWrite;
  crossTargetThread.expected.reply_anchor.write_command = crossTargetWrite;
  crossTargetThread.trace[1].source_target = "thread:oc_other:omt_other";
  crossTargetThread.trace[1].source_command = crossTargetSource;
  crossTargetThread.trace[1].command = crossTargetWrite;
  assert.equal(gradeAgentExperienceV6Trace(crossTargetThread, crossTargetThread.trace)
    .failures.some((item) => item.rule === "exclusive_source_selector"), true,
  "thread source target must match the polled target");

  const twoThreadReads = structuredClone(threadScenario.trace);
  twoThreadReads.splice(1, 0, threadPreview);
  assert.equal(gradeAgentExperienceV6Trace(threadScenario, twoThreadReads)
    .failures.some((item) => item.rule === "exclusive_source_selector"), true);

  const wrongInternalCount = structuredClone(threadScenario.trace);
  wrongInternalCount[1].composite_internal_commands = 3;
  assert.equal(gradeAgentExperienceV6Trace(threadScenario, wrongInternalCount)
    .failures.some((item) => item.rule === "exclusive_source_selector"), true);

  const hiddenInternalPreview = structuredClone(threadScenario);
  const previewPrefix = "larkin im +chat-messages-list --chat-id oc_eval_verbatim --order desc --page-size 1 --no-reactions --json >/dev/null; ";
  const originalSourceCommand = hiddenInternalPreview.expected.exact_source_dataflow.source_command;
  const previewedSourceCommand = `${previewPrefix}${originalSourceCommand}`;
  const previewedWriteCommand = `larkin im +messages-reply --message-id om_eval_verbatim --content "$(${previewedSourceCommand})" --json`;
  hiddenInternalPreview.expected.exact_source_dataflow.source_command = previewedSourceCommand;
  hiddenInternalPreview.expected.ordered_commands[1] = previewedWriteCommand;
  hiddenInternalPreview.expected.reply_anchor.write_command = previewedWriteCommand;
  hiddenInternalPreview.trace[1].source_command = previewedSourceCommand;
  hiddenInternalPreview.trace[1].command = previewedWriteCommand;
  const hiddenInternalPreviewGrade = gradeAgentExperienceV6Trace(hiddenInternalPreview, hiddenInternalPreview.trace);
  assert.equal(hiddenInternalPreviewGrade.failures.some((item) => item.rule === "exact_text"), false);
  assert.equal(hiddenInternalPreviewGrade.failures.some((item) => item.rule === "exclusive_source_selector"), true);

  for (const suffix of [
    "; lark''in im +chat-messages-''list --chat-id oc_eval_verbatim --json >/dev/null",
    "; $LARKIN_BIN im +chat-messages-''list --chat-id oc_eval_verbatim --json >/dev/null",
  ]) {
    const tokenBypass = structuredClone(threadScenario);
    const bypassedSourceCommand = `${tokenBypass.expected.exact_source_dataflow.source_command}${suffix}`;
    const bypassedWriteCommand = `larkin im +messages-reply --message-id om_eval_verbatim --content "$(${bypassedSourceCommand})" --json`;
    tokenBypass.expected.exact_source_dataflow.source_command = bypassedSourceCommand;
    tokenBypass.expected.ordered_commands[1] = bypassedWriteCommand;
    tokenBypass.expected.reply_anchor.write_command = bypassedWriteCommand;
    tokenBypass.trace[1].source_command = bypassedSourceCommand;
    tokenBypass.trace[1].command = bypassedWriteCommand;
    assert.equal(gradeAgentExperienceV6Trace(tokenBypass, tokenBypass.trace)
      .failures.some((item) => item.rule === "exclusive_source_selector"), true, suffix);
  }

  const literalLarkinPrefix = structuredClone(threadScenario);
  const originalPrefix = literalLarkinPrefix.expected.exact_source_dataflow.literal_prefix;
  const replacementPrefix = "larkin 引用：";
  const prefixSourceCommand = literalLarkinPrefix.expected.exact_source_dataflow.source_command
    .replace(JSON.stringify(originalPrefix), JSON.stringify(replacementPrefix));
  const prefixWriteCommand = `larkin im +messages-reply --message-id om_eval_verbatim --content "$(${prefixSourceCommand})" --json`;
  literalLarkinPrefix.expected.exact_source_dataflow.literal_prefix = replacementPrefix;
  literalLarkinPrefix.expected.exact_source_dataflow.source_command = prefixSourceCommand;
  literalLarkinPrefix.expected.exact_text = replacementPrefix + literalLarkinPrefix.trace[1].source_text;
  literalLarkinPrefix.expected.ordered_commands[1] = prefixWriteCommand;
  literalLarkinPrefix.expected.reply_anchor.write_command = prefixWriteCommand;
  literalLarkinPrefix.trace[1].literal_prefix = replacementPrefix;
  literalLarkinPrefix.trace[1].source_command = prefixSourceCommand;
  literalLarkinPrefix.trace[1].command = prefixWriteCommand;
  literalLarkinPrefix.trace[1].content_argument = JSON.stringify({ text: literalLarkinPrefix.expected.exact_text });
  literalLarkinPrefix.trace[1].transported_text = literalLarkinPrefix.expected.exact_text;
  assert.equal(gradeAgentExperienceV6Trace(literalLarkinPrefix, literalLarkinPrefix.trace).passed, true,
    "literal prefix containing larkin text");

  for (const disguisedExecution of [
    { action: "final", command: threadPreview.command, read_path: "data.messages", exit_code: 0 },
    { action: "final", tool_name: "read", command: "read /skills/lark-im/SKILL.md",
      resource_path: "/skills/lark-im/SKILL.md", exit_code: 0 },
  ]) {
    const disguisedTrace = structuredClone(threadScenario.trace);
    disguisedTrace.splice(1, 0, disguisedExecution);
    const disguisedGrade = gradeAgentExperienceV6Trace(threadScenario, disguisedTrace);
    assert.equal(disguisedGrade.failures.some((item) => item.rule === "exact_text"), false);
    assert.equal(disguisedGrade.failures.some((item) => item.rule === "trace_action_schema"), true,
      `${disguisedExecution.command}`);
  }

  for (const [label, mutate] of [
    ["tool unknown field", (trace) => { trace[0].executed_command = threadPreview.command; }],
    ["provider unknown field", (trace) => { trace[1].executed_command = threadPreview.command; }],
    ["provider nested result", (trace) => { trace[1].result = { command: threadPreview.command }; }],
    ["final visible_failure type", (trace) => {
      trace.splice(1, 0, { action: "final", visible_failure: threadPreview.command });
    }],
    ["final reused_memory type", (trace) => {
      trace.splice(1, 0, { action: "final", reused_memory: { command: "read /skills/lark-im/SKILL.md" } });
    }],
  ]) {
    const disguisedTrace = structuredClone(threadScenario.trace);
    mutate(disguisedTrace);
    const disguisedGrade = gradeAgentExperienceV6Trace(threadScenario, disguisedTrace);
    if (!label.startsWith("provider")) {
      assert.equal(disguisedGrade.failures.some((item) => item.rule === "exact_text"), false, label);
    }
    assert.equal(disguisedGrade.failures.some((item) => item.rule === "trace_action_schema"), true, label);
  }

  for (const malformedEvent of [null, "primitive", []]) {
    const malformedTrace = structuredClone(threadScenario.trace);
    malformedTrace.splice(1, 0, malformedEvent);
    let malformedGrade;
    assert.doesNotThrow(() => { malformedGrade = gradeAgentExperienceV6Trace(threadScenario, malformedTrace); });
    assert.equal(malformedGrade.failures.some((item) => item.rule === "trace_action_schema"), true,
      String(malformedEvent));
    assert.equal(malformedGrade.failures.some((item) => item.rule === "exact_text"), false,
      String(malformedEvent));
  }

  for (const malformedTrace of [null, "primitive", 7]) {
    let malformedGrade;
    assert.doesNotThrow(() => { malformedGrade = gradeAgentExperienceV6Trace(threadScenario, malformedTrace); });
    assert.equal(malformedGrade.failures.some((item) => item.rule === "trace_action_schema"), true,
      `trace=${String(malformedTrace)}`);
  }

  for (const [label, mutate] of [
    ["content key drift", (scenario) => {
      scenario.expected.exact_source_dataflow.content_key = "foo";
      scenario.trace[1].content_argument = JSON.stringify({ foo: scenario.expected.exact_text });
    }],
    ["source exit drift", (scenario) => {
      scenario.expected.exact_source_dataflow.source_exit_code = 2;
      scenario.trace[1].source_exit_code = 2;
    }],
    ["source path drift", (scenario) => {
      scenario.expected.exact_source_dataflow.source_read_path = "wrong.path";
      scenario.trace[1].source_read_path = "wrong.path";
    }],
    ["substitution mode drift", (scenario) => {
      scenario.expected.exact_source_dataflow.shell_substitution = "unquoted";
      scenario.trace[1].shell_substitution = "unquoted";
    }],
  ]) {
    const structuralDrift = structuredClone(threadScenario);
    mutate(structuralDrift);
    const driftGrade = gradeAgentExperienceV6Trace(structuralDrift, structuralDrift.trace);
    assert.equal(driftGrade.failures.some((item) => item.rule === "exact_text"), false, label);
    assert.equal(driftGrade.failures.some((item) => item.rule === "exact_source_dataflow"), true, label);
  }

  for (const id of ["tool-sourced-verbatim-thread-reply", "tool-sourced-verbatim-message-reply"]) {
    const scenario = byId[id];
    for (const [label, mutate] of [
      ["normalized JSON content", (event) => { event.content_argument = JSON.stringify({ text: '引用："改写" 单空格' }); }],
      ["wrong source", (event) => { event.source_text = "wrong source"; }],
      ["wrong target", (event) => { event.source_target = "message:om_wrong"; }],
      ["changed prefix", (event) => { event.literal_prefix = "changed:"; }],
      ["omitted prefix", (event) => {
        event.literal_prefix = "";
        event.content_argument = JSON.stringify({ text: event.source_text });
      }],
      ["raw schema drift", (event) => { event.source_command = event.source_command.replaceAll(".content", ".body.content"); }],
      ["extra inner read", (event) => { event.source_read_count = 2; }],
      ["failed inner read", (event) => { event.source_exit_code = 2; }],
      ["unquoted substitution", (event) => { event.shell_substitution = "unquoted"; }],
    ]) {
      const changedDataflow = structuredClone(scenario.trace);
      mutate(changedDataflow[1]);
      assert.equal(gradeAgentExperienceV6Trace(scenario, changedDataflow)
        .failures.some((item) => item.rule === "exact_source_dataflow"), true, `${id}: ${label}`);
    }
  }

  const unsafePrefix = structuredClone(byId["tool-sourced-verbatim-message-reply"]);
  const safePrefixFragment = "作者'\\''s：";
  const unsafePrefixFragment = "作者's：";
  unsafePrefix.expected.exact_source_dataflow.source_command = unsafePrefix.expected.exact_source_dataflow.source_command
    .replace(safePrefixFragment, unsafePrefixFragment);
  unsafePrefix.expected.ordered_commands[1] = unsafePrefix.expected.ordered_commands[1]
    .replace(safePrefixFragment, unsafePrefixFragment);
  unsafePrefix.expected.reply_anchor.write_command = unsafePrefix.expected.reply_anchor.write_command
    .replace(safePrefixFragment, unsafePrefixFragment);
  unsafePrefix.trace[1].source_command = unsafePrefix.trace[1].source_command
    .replace(safePrefixFragment, unsafePrefixFragment);
  unsafePrefix.trace[1].command = unsafePrefix.trace[1].command.replace(safePrefixFragment, unsafePrefixFragment);
  assert.equal(gradeAgentExperienceV6Trace(unsafePrefix, unsafePrefix.trace)
    .failures.some((item) => item.rule === "exact_source_dataflow"), true, "unsafe apostrophe prefix");

  const normalizationScenario = structuredClone(byId["tool-sourced-verbatim-message-reply"]);
  const decomposedText = "Cafe\u0301";
  const normalizedText = decomposedText.normalize("NFC");
  const prefix = normalizationScenario.expected.exact_source_dataflow.literal_prefix;
  normalizationScenario.expected.exact_text = prefix + decomposedText;
  normalizationScenario.trace[1].source_text = decomposedText;
  normalizationScenario.trace[1].content_argument = JSON.stringify({ text: prefix + normalizedText });
  normalizationScenario.trace[1].transported_text = prefix + decomposedText;
  assert.notEqual(normalizedText, decomposedText);
  assert.equal(gradeAgentExperienceV6Trace(normalizationScenario, normalizationScenario.trace)
    .failures.some((item) => item.rule === "exact_source_dataflow"), true, "Unicode normalization");

  const reorderedToolSourcedReply = structuredClone(byId["tool-sourced-verbatim-thread-reply"].trace);
  [reorderedToolSourcedReply[0], reorderedToolSourcedReply[1]] = [reorderedToolSourcedReply[1], reorderedToolSourcedReply[0]];
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

  for (const id of ["tool-sourced-verbatim-thread-reply", "tool-sourced-verbatim-message-reply"]) {
    const wrongProvider = structuredClone(byId[id].trace);
    wrongProvider[1].transported_text = "wrong provider text";
    assert.equal(gradeAgentExperienceV6Trace(byId[id], wrongProvider)
      .failures.some((item) => item.rule === "exact_text"), true, id);
  }

  for (const id of ["exact-text-punctuation", "exact-reply-no-help", "precommit-exact-reply-safe-retry",
    "tool-sourced-verbatim-thread-reply", "tool-sourced-verbatim-message-reply"]) {
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
