import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectSetupAgentChoice, recoverUnavailableExternalPi } from "../../../dist/setup/setup-agent-choice.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

function questioner(answers, secret = "test-secret") {
  const prompts = [];
  return {
    prompts,
    ask: async (prompt) => { prompts.push(prompt); return answers.shift() ?? ""; },
    secret: async (prompt) => { prompts.push(prompt); return secret; },
  };
}

test("new setup visibly offers Pi first, then external/built-in, before Codex and Claude", async () => {
  const q = questioner(["1", "2", "1", ""]);
  const choice = await collectSetupAgentChoice(q);
  assert.deepEqual(choice, { runtime: "pi", distribution: "builtin", preset: "deepseek", model: "deepseek/deepseek-v4-pro" });
  assert.match(q.prompts[0], /1\. Pi（推荐）[\s\S]*2\. Codex[\s\S]*3\. Claude Code/);
  assert.match(q.prompts[1], /1\. 外置 Pi[\s\S]*2\. 内置 Pi/);
  assert.match(q.prompts[2], /DeepSeek（推荐）[\s\S]*Kimi[\s\S]*MiniMax[\s\S]*智谱[\s\S]*Custom[\s\S]*官方 Pi provider 登录/);
});

test("existing Agent setup preserves runtime/model unless the user explicitly chooses change", async () => {
  const q = questioner([""]);
  assert.equal(await collectSetupAgentChoice(q, { runtime: "pi", model: "deepseek/deepseek-v4-pro", piDistribution: "builtin" }), null);
  assert.match(q.prompts[0], /直接回车保留/);
});

test("missing external Pi offers a bounded recovery and can switch to built-in Pi", async () => {
  const q = questioner(["1", "1", ""]);
  const reports = [];
  let probes = 0;
  const choice = await recoverUnavailableExternalPi(
    { runtime: "pi", distribution: "external" },
    q,
    async () => { probes += 1; return { state: "missing", reason: "pi not found", nextAction: "install pi" }; },
    (message) => reports.push(message),
  );
  assert.equal(probes, 1);
  assert.match(reports[0], /missing.*pi not found.*install pi/);
  assert.deepEqual(choice, {
    runtime: "pi", distribution: "builtin", preset: "deepseek", model: "deepseek/deepseek-v4-pro",
  });
});

test("built-in Pi dynamically offers every official provider auth method", async () => {
  const q = questioner(["1", "2", "6", "2", ""]);
  const services = {
    providers: async () => [{ id: "alpha", name: "Alpha", methods: [
      { type: "api_key", name: "Alpha key" }, { type: "oauth", name: "Alpha subscription" },
    ], models: ["alpha/a-1"], ambientOnly: false }],
    status: async () => [], logout: async () => {}, report() {},
  };
  assert.deepEqual(await collectSetupAgentChoice(q, undefined, services), {
    runtime: "pi", distribution: "builtin", preset: "official", providerId: "alpha", authType: "oauth", model: "alpha/a-1",
  });
  assert.match(q.prompts[3], /Alpha key \[api_key\][\s\S]*Alpha subscription \[oauth\]/);
});

test("built-in Pi status/logout returns to selection without exposing credential values", async () => {
  const reports = [];
  const loggedOut = [];
  const q = questioner(["1", "2", "7", "1", "1", ""]);
  const services = {
    providers: async () => [],
    status: async () => [{ providerId: "alpha", providerName: "Alpha", credentialType: "oauth", source: "OAuth", stored: true }],
    logout: async (providerId) => loggedOut.push(providerId), report: (message) => reports.push(message),
  };
  assert.deepEqual(await collectSetupAgentChoice(q, undefined, services), {
    runtime: "pi", distribution: "builtin", preset: "deepseek", model: "deepseek/deepseek-v4-pro",
  });
  assert.deepEqual(loggedOut, ["alpha"]);
  assert.match(reports.join("\n"), /Alpha.*oauth\/OAuth[\s\S]*已退出 Alpha/);
});

test("external Pi recovery cancellation preserves config and the retry loop is bounded", async () => {
  const cancelled = questioner(["3"]);
  await assert.rejects(() => recoverUnavailableExternalPi(
    { runtime: "pi", distribution: "external" }, cancelled, async () => ({ state: "incompatible" })), /未修改 Agent\/config/);

  // Three re-selections of the same unavailable external Pi are allowed; a
  // fourth probe is never attempted and no configuration is published.
  const repeated = questioner(["2", "1", "1", "2", "1", "1", "2", "1", "1"]);
  let probes = 0;
  await assert.rejects(() => recoverUnavailableExternalPi(
    { runtime: "pi", distribution: "external" }, repeated,
    async () => { probes += 1; return { state: "missing" }; }), /达到 3 次.*未修改 Agent\/config/);
  assert.equal(probes, 3);
});

test.skipIf(!Bun.which("expect"))("TTY API Key input is received without echo and releases stdin so the process exits", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-secret-pty-"));
  const sentinel = "pty-secret-SENTINEL-8391";
  try {
    const fixture = path.join(temp, "secret-fixture.mjs");
    const transcript = path.join(temp, "terminal-transcript.txt");
    const expectScript = path.join(temp, "secret.expect");
    const moduleUrl = pathToFileURL(path.join(ROOT, "dist/setup/setup-agent-choice.mjs")).href;
    fs.writeFileSync(fixture, `import { terminalSetupQuestioner } from ${JSON.stringify(moduleUrl)};\n`
      + `const q = terminalSetupQuestioner();\nconst value = await q.secret("API_KEY> ");\n`
      + `process.stdout.write("RECEIVED_LENGTH=" + value.length + "\\n");\n`, { mode: 0o600 });
    fs.writeFileSync(expectScript, `set timeout 10\nlog_file -noappend {${transcript}}\n`
      + `spawn -noecho {${process.execPath}} {${fixture}}\nexpect {API_KEY> }\nsend -- "${sentinel}\\r"\n`
      + `expect {RECEIVED_LENGTH=${sentinel.length}}\nexpect eof\n`, { mode: 0o600 });
    const result = spawnSync(Bun.which("expect"), [expectScript], { cwd: temp, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = fs.readFileSync(transcript, "utf8");
    assert.match(output, new RegExp(`RECEIVED_LENGTH=${sentinel.length}`));
    assert.doesNotMatch(output, new RegExp(sentinel), "PTY transcript must not contain the API Key");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
