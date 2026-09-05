import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectSetupAgentChoice } from "../../../dist/setup/setup-agent-choice.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

function questioner(answers, secret = "test-secret") {
  const prompts = [];
  return {
    prompts,
    ask: async (prompt) => { prompts.push(prompt); return answers.shift() ?? ""; },
    secret: async (prompt) => { prompts.push(prompt); return secret; },
  };
}

const ALL_INSTALLED = [
  { runtime: "codex", installed: true },
  { runtime: "claude", installed: true },
  { runtime: "pi", installed: true },
];

test("new setup lists three external runtimes with install status and no builtin-pi", async () => {
  const q = questioner(["3"]);
  assert.deepEqual(await collectSetupAgentChoice(q, undefined, ALL_INSTALLED), { runtime: "pi" });
  assert.match(q.prompts[0], /1\. Codex \[installed\][\s\S]*2\. Claude Code \[installed\][\s\S]*3\. pi（本机官方 pi CLI） \[installed\]/);
  assert.doesNotMatch(q.prompts[0], /builtin-pi|捆绑|Provider Credentials|pi-auth/);
});

test("existing Agent setup preserves runtime/model unless the user explicitly chooses change", async () => {
  const q = questioner([""]);
  assert.equal(await collectSetupAgentChoice(q, { runtime: "pi", model: "deepseek/deepseek-v4-pro" }, ALL_INSTALLED), null);
  assert.match(q.prompts[0], /已有 Agent：pi\/deepseek\/deepseek-v4-pro/);
  assert.match(q.prompts[0], /直接回车保留/);
});

test("interactive setup refuses to bind a runtime that is not installed", async () => {
  const statuses = [
    { runtime: "codex", installed: false, reason: "codex is not installed", nextAction: "Install Codex and ensure `codex` is on PATH, or set LARKIN_CODEX_COMMAND." },
    { runtime: "claude", installed: true },
    { runtime: "pi", installed: true },
  ];
  const q = questioner(["1"]);
  await assert.rejects(() => collectSetupAgentChoice(q, undefined, statuses), /codex is not installed.*LARKIN_CODEX_COMMAND/);
  assert.match(q.prompts[0], /1\. Codex \[not installed\]/);
});

test.skipIf(!Bun.which("expect"))("TTY secret input is received without echo and releases stdin so the process exits", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-secret-pty-"));
  const sentinel = "pty-secret-SENTINEL-8391";
  try {
    const fixture = path.join(temp, "secret-fixture.mjs");
    const transcript = path.join(temp, "terminal-transcript.txt");
    const expectScript = path.join(temp, "secret.expect");
    const moduleUrl = pathToFileURL(path.join(ROOT, "dist/setup/setup-agent-choice.mjs")).href;
    fs.writeFileSync(fixture, `import { terminalSetupQuestioner } from ${JSON.stringify(moduleUrl)};\n`
      + `const q = terminalSetupQuestioner();\nconst value = await q.secret("SECRET> ");\n`
      + `process.stdout.write("RECEIVED_LENGTH=" + value.length + "\\n");\n`, { mode: 0o600 });
    fs.writeFileSync(expectScript, `set timeout 10\nlog_file -noappend {${transcript}}\n`
      + `spawn -noecho {${process.execPath}} {${fixture}}\nexpect {SECRET> }\nsend -- "${sentinel}\\r"\n`
      + `expect {RECEIVED_LENGTH=${sentinel.length}}\nexpect eof\n`, { mode: 0o600 });
    const result = spawnSync(Bun.which("expect"), [expectScript], { cwd: temp, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = fs.readFileSync(transcript, "utf8");
    assert.match(output, new RegExp(`RECEIVED_LENGTH=${sentinel.length}`));
    assert.doesNotMatch(output, new RegExp(sentinel), "PTY transcript must not contain the secret");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
