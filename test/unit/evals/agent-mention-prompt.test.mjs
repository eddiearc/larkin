import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";
import {
  AGENT_MENTION_GUIDANCE,
  ContextPromptBuilder,
  LARKIN_STANDING_PROMPT_VERSION,
} from "../../../dist/agent/context-prompt.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const launcher = await import(pathToFileURL(path.join(ROOT, "dist/app/lark-cli.mjs")).href);
const stateModule = await import(pathToFileURL(path.join(ROOT, "dist/agent/agent-state-store.mjs")).href);
import { gradeMentionConstructionTrace, loadMentionConstructionEval } from "../../support/mention-construction-grader.mjs";

function buildPrompt(runtime = "pi") {
  return new ContextPromptBuilder().build({ agentId: "cli_eval", runtime }).content;
}

test("standing prompt teaches real Feishu mention elements for Agent wake-ups", () => {
  const prompt = buildPrompt();
  // 纯文本 @ 不会产生 mention 事件，目标 Agent 不会被唤醒。
  assert.match(prompt, /plain-text @ \(for example `@三蛋 干活`\) never produces a Feishu mention event.*target Agent will not be woken/i);
  // text 消息：--content 内嵌 <at user_id="{open_id}">（合法 JSON 转义），--msg-type text。
  assert.match(prompt, /--content '\{"text":"<at user_id=\\"\{open_id\}\\"><\/at> <body>"}' --msg-type text/);
  // post 消息：首个元素为 {"tag":"at","user_id":"{open_id}"}，--msg-type post。
  assert.match(prompt, /\{"tag":"at","user_id":"\{open_id\}"\}/);
  assert.match(prompt, /--msg-type post/);
  // 发送前先解析目标 open_id；保持 loop-prevention 边界。
  assert.match(prompt, /Resolve the target's open_id first \(contact or chat-member lookup\) before sending/i);
  assert.match(prompt, /keep the existing loop-prevention boundary/i);
});

test("deletion counterfactual: the guidance constant is the only source of the mention-element recipes", () => {
  const prompt = buildPrompt();
  // 每条引导都以常量形式出现在最终 prompt 中（唯一来源）。
  for (const line of AGENT_MENTION_GUIDANCE) {
    assert.equal(prompt.includes(line), true, `guidance line missing: ${line.slice(0, 80)}`);
  }
  const remainder = AGENT_MENTION_GUIDANCE.reduce((text, line) => text.replaceAll(line, ""), prompt);
  // 移除该常量后，这些关键短语必须从 prompt 中消失（删除反事实）。
  for (const phrase of [
    /plain-text @ \(for example/,
    /construct a real Feishu mention element/,
    /--content '\{"text":"<at user_id=\\"\{open_id\}\\"><\/at> <body>"}' --msg-type text/,
    /\{"tag":"at","user_id":"\{open_id\}"\}/,
    /--msg-type post/,
    /Resolve the target's open_id first/,
  ]) {
    assert.equal(phrase.test(remainder), false, `phrase survived without the guidance constant: ${phrase}`);
  }
});

test("lark-cli launcher passes --mention argv through without injecting --content/--msg-type", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-mention-prompt-eval-"));
  try {
    const agentId = "cli_mentionPromptEvalA1";
    fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-mention-prompt-eval", mentionPolicy: "require", activeAgent: agentId,
      agents: { [agentId]: { runtime: "codex", model: "default" } },
    })}\n`, { mode: 0o600 });
    const store = stateModule.createAgentStateStore(root, agentId);
    const calls = [];
    const spawn = (command, args) => {
      calls.push(args);
      const isHistory = ["+chat-messages-list", "+threads-messages-list"].includes(args[2])
        || (args[1] === "api" && args[2] === "GET" && args[3] === "/open-apis/im/v1/messages");
      return isHistory
        ? { status: 0, signal: null, output: [], pid: 1, stdout: '{"ok":true,"identity":"bot","data":{"messages":[]}}', stderr: "", error: undefined }
        : { status: 0, signal: null, output: [], pid: 1,
            stdout: '{"ok":true,"data":{"message_id":"om_eval_passthrough"}}', stderr: "", error: undefined };
    };
    const argv = ["im", "+messages-send", "--chat-id", "oc_eval_mention", "--mention", "ou_eval_target123", "--text", "hello"];
    const code = launcher.runLarkCli(argv, { LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId }, {
      io: { stdout() {}, stderr() {} },
      spawn,
      nativeCommand: { command: process.execPath, argsPrefix: ["/fixed/@larksuite/cli/scripts/run.js"], version: "1.0.80" },
      stateStore: store,
    });
    assert.equal(code, 0);
    const write = calls.find((args) => args.includes("+messages-send"));
    assert.ok(write, "expected the guarded send to reach the native CLI");
    // --mention 不再被翻译：不注入 --content/--msg-type，正文与 --mention 原样透传。
    assert.equal(write.includes("--mention"), true);
    assert.equal(write[write.indexOf("--mention") + 1], "ou_eval_target123");
    assert.equal(write.includes("--content"), false);
    assert.equal(write.includes("--msg-type"), false);
    assert.equal(write[write.indexOf("--text") + 1], "hello");
    // 非 +messages-send/reply 命令同样原样透传。
    assert.equal(launcher.classifyLarkCliCommand(["im", "+chat-list", "--mention", "ou_eval_target123"]).kind, "passthrough");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mention guidance ships under the current standing prompt version", () => {
  assert.equal(LARKIN_STANDING_PROMPT_VERSION, "larkin-standing-v24");
  const prompt = buildPrompt("codex");
  assert.match(prompt, /## Collaboration and delivery/);
});

test("mention-construction grader passes a real at element and fails plain-text @", () => {
  const dataset = loadMentionConstructionEval(path.join(ROOT, "evals/mention-construction/scenarios.json"));
  const scenario = dataset.scenarios[0];
  const textForm = {
    action: "provider_write",
    command: "larkin im +messages-send --chat-id oc_eval_partner_group --content '{\"text\":\"<at user_id=\\\"ou_eval_target123\\\"></at> 请处理\"}' --msg-type text",
    chat_id: "oc_eval_partner_group", content: "{\"text\":\"<at user_id=\\\"ou_eval_target123\\\"></at> 请处理\"}",
    text: null, msg_type: "text", exit_code: 0,
  };
  const postForm = {
    action: "provider_write",
    command: "larkin im +messages-send --chat-id oc_eval_partner_group --content '{\"zh_cn\":{\"title\":\"\",\"content\":[[{\"tag\":\"at\",\"user_id\":\"ou_eval_target123\"}],[{\"tag\":\"text\",\"text\":\"请处理\"}]]}}' --msg-type post",
    chat_id: "oc_eval_partner_group", content: "{\"zh_cn\":{\"title\":\"\",\"content\":[[{\"tag\":\"at\",\"user_id\":\"ou_eval_target123\"}],[{\"tag\":\"text\",\"text\":\"请处理\"}]]}}",
    text: null, msg_type: "post", exit_code: 0,
  };
  assert.equal(gradeMentionConstructionTrace(scenario, [textForm]).passed, true);
  assert.equal(gradeMentionConstructionTrace(scenario, [postForm]).passed, true);
  const plainText = {
    action: "provider_write",
    command: "larkin im +messages-send --chat-id oc_eval_partner_group --text '@三蛋 干活' --json",
    chat_id: "oc_eval_partner_group", content: null, text: "@三蛋 干活", msg_type: null, exit_code: 0,
  };
  const plainGrade = gradeMentionConstructionTrace(scenario, [plainText]);
  assert.equal(plainGrade.passed, false);
  assert.equal(plainGrade.failures.some((item) => item.rule === "real_mention"), true,
    "plain-text @ without an at element must fail");
  assert.equal(gradeMentionConstructionTrace(scenario, []).passed, false, "no write must fail");
  const wrongChat = gradeMentionConstructionTrace(scenario, [{
    ...textForm,
    command: textForm.command.replace("oc_eval_partner_group", "oc_other_group"),
    chat_id: "oc_other_group",
  }]);
  assert.equal(wrongChat.passed, false);
  assert.equal(wrongChat.failures.some((item) => item.rule === "target_chat"), true);
});
