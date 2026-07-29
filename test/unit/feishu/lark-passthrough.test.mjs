import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = path.join(ROOT, "dist", "app", "cli.mjs");
const { assessPassthrough, applyArgvTweaks } = await import(
  pathToFileURL(path.join(ROOT, "dist", "feishu", "lark-passthrough.mjs")).href
);
const { AGENT_CLI_CAPABILITIES } = await import(
  pathToFileURL(path.join(ROOT, "dist", "agent", "agent-cli-capabilities.mjs")).href
);

test("terminal passthrough decision forwards plain argv and strips --agent anywhere", () => {
  const plain = assessPassthrough(["im", "send", "--chat-id", "oc_x", "--text", "hi"]);
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.argv, ["im", "send", "--chat-id", "oc_x", "--text", "hi"]);
  assert.equal(plain.explicitAgent, null);

  const trailing = assessPassthrough(["docs", "+fetch", "--token", "t", "--agent", "cli_larkA1"]);
  assert.equal(trailing.ok, true);
  assert.equal(trailing.explicitAgent, "cli_larkA1");
  assert.deepEqual(trailing.argv, ["docs", "+fetch", "--token", "t"]);

  const empty = assessPassthrough([]);
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /用法/);

  // 微调层默认为空：argv 原样
  assert.deepEqual(applyArgvTweaks(["im", "send", "--text", "hi"]), ["im", "send", "--text", "hi"]);
});

test("public CLI exposes package version and complete nested config help without loading config", () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-cli-help-"));
  try {
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, LARKIN_CONFIG_DIR: isolated },
    });
    for (const args of [["--version"], ["-V"]]) {
      const result = run(...args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), `larkin ${JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version}`);
    }
    for (const args of [["config", "--help"], ["config", "-h"], ["help", "config"]]) {
      const result = run(...args);
      assert.equal(result.status, 0, result.stderr);
      for (const token of ["config runtime", "config model", "config effort", "config mention global", "config mention agent", "config mention chat", "config apply", "--agent", "--chat", "--json", "inherit", "default", "clear"]) {
        assert.match(result.stdout, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${args.join(" ")} missing ${token}`);
      }
      for (const operation of AGENT_CLI_CAPABILITIES.commands.config) assert.match(result.stdout, new RegExp(`config ${operation}`));
    }
    const effortHelp = run("effort", "--help");
    assert.equal(effortHelp.status, 0, effortHelp.stderr);
    assert.match(effortHelp.stdout, /<level>\|clear\|default/);
    assert.equal(fs.existsSync(path.join(isolated, "config.json")), false);
  } finally { fs.rmSync(isolated, { recursive: true, force: true }); }
});

test("runtime message send and reply preserve native text and markdown argv", () => {
  const runtime = { LARKIN_AGENT_ID: "cli_larkA1" };
  for (const operation of ["+messages-send", "+messages-reply"]) {
    const prefix = operation === "+messages-send"
      ? ["im", operation, "--chat-id", "oc_x"]
      : ["im", operation, "--message-id", "om_x"];

    for (const plainArgv of [
      [...prefix, "--text", "**looks odd**"],
      [...prefix, "--text=plain"],
    ]) {
      const plain = assessPassthrough(plainArgv, runtime);
      assert.equal(plain.ok, true, plain.reason);
      assert.deepEqual(plain.argv, plainArgv, `${operation} text must stay byte-for-byte argv equivalent`);
    }

    const markdownArgv = [...prefix, "--markdown", "**renders bold**"];
    const markdown = assessPassthrough(markdownArgv, runtime);
    assert.equal(markdown.ok, true, markdown.reason);
    assert.deepEqual(markdown.argv, markdownArgv, `${operation} markdown must stay byte-for-byte argv equivalent`);
  }
});

test("native text remains untouched outside the identity-locked runtime message boundary", () => {
  const terminal = assessPassthrough(["im", "+messages-send", "--chat-id", "oc_x", "--text", "plain"]);
  assert.equal(terminal.ok, true, terminal.reason);
  assert.deepEqual(terminal.argv, ["im", "+messages-send", "--chat-id", "oc_x", "--text", "plain"]);

  const unrelatedRuntimeCommand = assessPassthrough(
    ["im", "reactions", "create", "--message-id", "om_x", "--text", "native-option"],
    { LARKIN_AGENT_ID: "cli_larkA1" },
  );
  assert.equal(unrelatedRuntimeCommand.ok, true, unrelatedRuntimeCommand.reason);
  assert.deepEqual(unrelatedRuntimeCommand.argv, ["im", "reactions", "create", "--message-id", "om_x", "--text", "native-option"]);
});

test("agent runtime passthrough rejects every explicit --agent selector", () => {
  for (const runtimeEnv of [
    { LARKIN_AGENT_ID: "cli_larkA1" },
  ]) for (const explicitAgent of ["cli_larkA1", "cli_larkB2"]) {
    const decision = assessPassthrough(
      ["docs", "+fetch", "--token", "t", "--agent", explicitAgent],
      runtimeEnv,
    );
    assert.equal(decision.ok, false, `agent runtime must reject --agent ${explicitAgent}`);
    assert.match(decision.reason, /身份边界|当前 Agent|--agent/);
  }
});

test("terminal passthrough rejects missing or repeated --agent selectors", () => {
  for (const argv of [
    ["docs", "+fetch", "--agent"],
    ["docs", "+fetch", "--agent", "cli_larkA1", "--agent", "cli_larkB2"],
  ]) {
    const decision = assessPassthrough(argv);
    assert.equal(decision.ok, false, `malformed selector must fail closed: ${JSON.stringify(argv)}`);
    assert.match(decision.reason, /--agent/);
  }
});

test("passthrough decision enforces the identity boundary", () => {
  for (const argv of [
    ["im", "send", "--as", "user"],
    ["im", "send", "--as=user"],
    ["im", "chats-list", "--profile", "other"],
    ["im", "chats-list", "--profile=other"],
    ["im", "chats-list", "--config-dir", "/tmp/x"],
    ["auth", "logout"],
    ["auth", "login"],
    ["profile", "use", "other"],
    ["config", "set", "x", "y"],
    ["update"],
  ]) {
    const decision = assessPassthrough(argv);
    assert.equal(decision.ok, false, `expected rejection for ${JSON.stringify(argv)}`);
    assert.match(decision.reason, /身份边界|凭证/, `reason for ${JSON.stringify(argv)}`);
  }
  const bot = assessPassthrough(["im", "send", "--as", "bot"]);
  assert.equal(bot.ok, true, "--as bot 是本来身份，放行");
});

test("passthrough blocks the event stream and user-only domains with clear reasons", () => {
  const event = assessPassthrough(["event", "consume", "SomeKey"]);
  assert.equal(event.ok, false);
  assert.match(event.reason, /事件流/, "event rejection must explain the daemon stream conflict");

  for (const domain of ["mail", "attendance", "okr"]) {
    const decision = assessPassthrough([domain, "list"]);
    assert.equal(decision.ok, false, `expected rejection for ${domain}`);
    assert.match(decision.reason, /用户身份域/, `reason for ${domain}`);
  }

  // 未列入名单的用户域保持开放，交给飞书自然报错（Owner 定：不做大面积裁剪）
  for (const domain of ["approval", "minutes", "mindnotes", "application"]) {
    assert.equal(assessPassthrough([domain, "list"]).ok, true, `${domain} must stay open`);
  }
});

function passthroughWorkspace() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-lark-passthrough-"));
  const first = "cli_larkA1";
  const second = "cli_larkB2";
  fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
    version: 3,
    serverId: "server-lark-passthrough",
    activeAgent: first,
    agents: {
      // effort 触发 runtime-models 目录加载：回归覆盖 ESM 产物下的模块目录定位（曾因裸 __dirname 崩溃）。
      [first]: { runtime: "codex", model: "gpt-5.6-sol", effort: "high" },
      [second]: { runtime: "claude", model: "claude-sonnet-4-5" },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const bin = path.join(temp, "bin");
  fs.mkdirSync(bin);
  const marker = path.join(temp, "lark-cli-calls.txt");
  const officialPackage = path.join(temp, "official", "node_modules", "@larksuite", "cli");
  fs.mkdirSync(path.join(officialPackage, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(officialPackage, "package.json"), JSON.stringify({
    name: "@larksuite/cli", version: "1.0.78", bin: { "lark-cli": "scripts/run.sh" },
  }));
  const official = path.join(officialPackage, "scripts", "run.sh");
  fs.writeFileSync(official, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.0.78\n'; exit 0; fi
{
  printf 'CONFIGDIR=%s\\n' "$LARKSUITE_CLI_CONFIG_DIR"
  for arg in "$@"; do printf 'ARG=%s\\n' "$arg"; done
} > "$LARK_MOCK_MARKER"
echo '{"ok":true,"data":{"mock":true}}'
`);
  fs.chmodSync(official, 0o755);
  fs.symlinkSync(official, path.join(bin, "lark-cli"));
  const shellHome = path.join(temp, "home");
  fs.mkdirSync(shellHome);
  fs.writeFileSync(path.join(shellHome, ".bash_profile"), `export PATH=${JSON.stringify(bin)}:$PATH\n`);
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      LARKIN_CONFIG_DIR: temp,
      LARK_MOCK_MARKER: marker,
      HOME: shellHome,
      SHELL: "/bin/bash",
      PATH: `${bin}:${process.env.PATH}`,
      ...extraEnv,
    },
  });
  return { temp, first, second, marker, run };
}

test("larkin <group> forwards to lark-cli with locked profile and config dir", () => {
  const { temp, second, marker, run } = passthroughWorkspace();
  try {
    const result = run(["im", "+chat-list", "--json", "--agent", second]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"mock":true/, "mock lark-cli output must reach the caller");
    const lines = fs.readFileSync(marker, "utf8").trim().split("\n");
    assert.match(lines[0], /^CONFIGDIR=.+lark-cli-config$/, "config dir must be locked to the larkin passthrough config dir");
    assert.ok(lines[0].startsWith(`CONFIGDIR=${temp}`), "config dir must live under the larkin root");
    assert.deepEqual(
      lines.slice(1),
      ["ARG=--profile", `ARG=${second}`, "ARG=im", "ARG=+chat-list", "ARG=--json"],
      "profile must be injected first and caller argv forwarded verbatim",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("terminal larkin <group> honours --agent selector and rejects identity escapes", () => {
  const { first, temp, marker, run } = passthroughWorkspace();
  try {
    const explicit = run(["docs", "+fetch", "--token", "t", "--agent", first]);
    assert.equal(explicit.status, 0, explicit.stderr);
    const lines = fs.readFileSync(marker, "utf8").trim().split("\n");
    assert.deepEqual(lines.slice(1), ["ARG=--profile", `ARG=${first}`, "ARG=docs", "ARG=+fetch", "ARG=--token", "ARG=t"]);

    fs.rmSync(marker, { force: true });
    const rejected = run(["im", "send", "--chat-id", "oc_x", "--as", "user"], { LARKIN_AGENT_ID: first });
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /身份边界/);
    assert.equal(fs.existsSync(marker), false, "rejected calls must never reach lark-cli");

    const prefixedRejected = run(["--as", "user", "im", "+chat-list"], { LARKIN_AGENT_ID: first });
    assert.equal(prefixedRejected.status, 2);
    assert.match(prefixedRejected.stderr, /身份边界/);
    assert.equal(fs.existsSync(marker), false, "leading identity flags must enter policy classification before spawn");

    for (const managementArgs of [
      ["auth", "login"],
      ["profile", "list"],
      ["update"],
    ]) {
      fs.rmSync(marker, { force: true });
      const management = run(managementArgs);
      assert.equal(management.status, 2, `${managementArgs[0]} must be rejected by the public process`);
      assert.match(management.stderr, /身份边界|凭证/);
      assert.equal(fs.existsSync(marker), false, `${managementArgs[0]} rejection must happen before lark-cli spawn`);
    }

    const unknown = run(["im", "+chat-list"], { LARKIN_AGENT_ID: "cli_missing9" });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Agent|不存在|配置/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("agent runtime larkin <group> rejects --agent before spawning lark-cli", () => {
  const { first, second, temp, marker, run } = passthroughWorkspace();
  try {
    for (const explicitAgent of [first, second]) {
      fs.rmSync(marker, { force: true });
      const result = run(["docs", "+fetch", "--token", "t", "--agent", explicitAgent], { LARKIN_AGENT_ID: first });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      assert.match(result.stderr, /身份边界|当前 Agent|--agent|不支持的 Agent 命令/);
      assert.equal(fs.existsSync(marker), false, "rejected agent-context calls must never reach lark-cli");
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("Agent Runtime routes Feishu groups through the Larkin-owned AOP to the official CLI", () => {
  const { first, temp, marker, run } = passthroughWorkspace();
  try {
    for (const args of [["im", "+chat-list"], ["docs", "+fetch", "--token", "t"]]) {
      fs.rmSync(marker, { force: true });
      const result = run(args, { LARKIN_AGENT_ID: first });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(fs.existsSync(marker), true, "Runtime must reach the verified official CLI through larkin");
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("larkin own commands and help keep precedence over the passthrough", () => {
  const { marker, temp, run } = passthroughWorkspace();
  try {
    const help = run(["help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: larkin <command>/);
    assert.match(help.stdout, /lark-cli 命令组/, "usage must mention the passthrough surface");
    assert.match(help.stdout, /im\/docs\/wiki\/drive/, "usage must teach the current lark-cli docs command group");
    assert.doesNotMatch(help.stdout, /docx/, "usage must not teach the removed docx command group");
    assert.equal(fs.existsSync(marker), false, "help must not touch lark-cli");

    const statusHelp = run(["status", "--help"]);
    assert.equal(statusHelp.status, 0);
    assert.match(statusHelp.stdout, /Usage: larkin status/);
    assert.equal(fs.existsSync(marker), false, "larkin own commands must not forward to lark-cli");

    for (const removedCommand of ["init", "bot:connect"]) {
      fs.rmSync(marker, { force: true });
      const removed = run([removedCommand]);
      assert.equal(removed.status, 1, `${removedCommand} must stay explicitly removed`);
      assert.match(removed.stderr, /已移除|不支持|setup/);
      assert.equal(fs.existsSync(marker), false, `removed ${removedCommand} must never be forwarded to lark-cli`);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("Runtime-bound installed larkin routes local Agent commands to agent-cli", () => {
  const { first, marker, temp, run } = passthroughWorkspace();
  try {
    const check = run(["inbox", "check"], { LARKIN_AGENT_ID: first });
    assert.equal(check.status, 0, check.stderr || check.stdout);
    assert.deepEqual(JSON.parse(check.stdout), { version: 2, targets: [], pending_total: 0, has_more: false });
    assert.equal(fs.existsSync(marker), false, "Runtime-local Inbox commands must never reach lark-cli");

    const configHelp = run(["config", "--help"], { LARKIN_AGENT_ID: first });
    assert.equal(configHelp.status, 0, configHelp.stderr || configHelp.stdout);
    assert.ok(JSON.parse(configHelp.stdout).usage.some((line) => line.includes("larkin config apply")));
    assert.equal(fs.existsSync(marker), false, "Runtime-local config help must stay on agent-cli");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("external Agent CLI exposes only Larkin-owned commands and migrates IM to native lark-cli", () => {
  const AGENT_CLI = path.join(ROOT, "dist", "app", "agent-cli.mjs");
  const { temp, first, marker, run: _run } = passthroughWorkspace();
  try {
    const run = (args, extraEnv = {}) => spawnSync(process.execPath, [AGENT_CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        LARKIN_CONFIG_DIR: temp,
        LARKIN_AGENT_ID: first,
        LARKIN_SERVER_ID: "server-lark-passthrough",
        LARKIN_SERVER_URL: "http://127.0.0.1:8787",
        LARKIN_AGENT_PROXY_URL: "http://127.0.0.1:8788",
        LARKIN_AGENT_PROXY_TOKEN: "dummy",
        LARK_MOCK_MARKER: marker,
        PATH: `${path.join(temp, "bin")}:${process.env.PATH}`,
        ...extraEnv,
      },
    });
    const migrated = run(["im", "+chat-list", "--json"]);
    assert.equal(migrated.status, 2, migrated.stderr);
    assert.match(migrated.stderr, /`larkin im/);
    assert.equal(fs.existsSync(marker), false, "legacy larkin im must not spawn lark-cli");

    for (const removedCommand of ["init", "bot:connect"]) {
      fs.rmSync(marker, { force: true });
      const removed = run([removedCommand]);
      assert.equal(removed.status, 2, `${removedCommand} must stay unavailable in agent-cli`);
      assert.match(removed.stderr, /已移除|不支持|setup/);
      assert.equal(fs.existsSync(marker), false, `agent-cli removed ${removedCommand} must never reach lark-cli`);
    }
    fs.rmSync(marker, { force: true });
    const unavailableBuild = run(["build"]);
    assert.equal(unavailableBuild.status, 2, "agent-cli must not expose a build command");
    assert.match(unavailableBuild.stderr, /源码|source|不可用|不支持/);
    assert.equal(fs.existsSync(marker), false, "agent-cli build must never reach lark-cli");

    // profile show is local and never reaches lark-cli.
    const profile = run(["profile", "show", "--json"]);
    assert.equal(profile.status, 0, profile.stderr || profile.stdout);
    assert.equal(JSON.parse(profile.stdout).id, first);
    assert.equal(fs.existsSync(marker), false, "profile show must never be forwarded to lark-cli");

    const removedMessage = run(["message", "check"]);
    assert.equal(removedMessage.status, 2);
    assert.equal(fs.existsSync(marker), false, "removed envelope commands must never be forwarded to lark-cli");

    // Bare help describes only the current Agent CLI surface and stays local.
    const help = run(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    const helpPayload = JSON.parse(help.stdout);
    assert.deepEqual(helpPayload.capabilities.commands.inbox, ["check", "poll"]);
    assert.equal("im" in helpPayload.capabilities.commands, false);
    assert.doesNotMatch(help.stdout, /im\/docs\/wiki\/drive|docx/);
    assert.equal(fs.existsSync(marker), false, "help must not touch lark-cli");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("platform rules teach the sole larkin surface, long-running task updates, and the irreversible-op convention", async () => {
  const { PLATFORM_RULES } = await import(
    pathToFileURL(path.join(ROOT, "dist", "platform", "workspace-service.mjs")).href
  );
  assert.match(PLATFORM_RULES, /standing instructions.*Larkin 本地能力/, "platform rules must defer to the capability manifest");
  assert.match(PLATFORM_RULES, /inbox check/, "platform rules must teach the external Inbox command");
  assert.match(PLATFORM_RULES, /只用 larkin.*不要调用裸 lark-cli/, "platform rules must teach the Larkin-owned surface");
  assert.doesNotMatch(PLATFORM_RULES, /larkin message|larkin task claim|larkin docs/, "platform rules must not teach removed commands");
  assert.match(PLATFORM_RULES, /--as user/, "platform rules must state the identity boundary");
  assert.match(PLATFORM_RULES, /commentary.*final_answer.*(?:不可见|不等于飞书出站)/, "runtime-native output must not be presented as user-visible IM");
  assert.match(PLATFORM_RULES, /只有[^\n]*成功调用[^\n]*larkin[^\n]*(?:发送|回复)[^\n]*(?:可见|反馈)/, "only a successful routed send or reply is user-visible");
  assert.match(PLATFORM_RULES, /多个外部步骤[^\n]*(?:首个|第一个)[^\n]*(?:外部|耗时)步骤前[^\n]*(?:简短确认|首响)/, "multi-step external work must acknowledge before its first external or slow step");
  assert.match(PLATFORM_RULES, /短任务[^\n]*(?:直接处理|无需)[^\n]*(?:收到|确认|首响)/, "short work must not gain a mechanical acknowledgement");
  assert.match(PLATFORM_RULES, /用户[^\n]*步骤顺序[^\n]*(?:严格|必须)[^\n]*顺序[^\n]*不得[^\n]*(?:fallback|重排|重复)/, "explicit user ordering must forbid premature fallback, repetition, and reordering");
  assert.match(PLATFORM_RULES, /进度[^\n]*用户[^\n]*大阶段[^\n]*(?:而非|不按)[^\n]*(?:工具|小步骤)[^\n]*(?:仅在|只在)[^\n]*阶段变化[^\n]*明显延迟[^\n]*需要用户动作[^\n]*用户可感知阻塞[^\n]*同一阶段[^\n]*同一阻塞[^\n]*(?:不重复|只发送一次)/, "phase-level progress must stay bounded and user-meaningful");
  assert.match(PLATFORM_RULES, /(?:^|\n)- 依赖前一步结果[^\n]*每次只调用一个[^\n]*禁止[^\n]*批量[^\n]*并行[^\n]*观察失败结果后[^\n]*只看下一动作[^\n]*继续同一方案[^\n]*retry[^\n]*禁止重复发送[^\n]*改用[^\n]*fallback[^\n]*其他方案[^\n]*必须先用 larkin[^\n]*阻塞[^\n]*下一步[^\n]*发送成功后[^\n]*才可调用新方案/, "dependent work must be observed one call at a time before one binary retry-or-fallback decision");
  assert.match(PLATFORM_RULES, /不得[^\n]*(?:每次工具调用|逐次工具调用)[^\n]*(?:刷屏|发送)|(?:而非|不按)[^\n]*(?:工具|小步骤)/, "progress must not spam on every tool call");
  assert.match(PLATFORM_RULES, /不得泄露[^\n]*thinking[^\n]*凭证[^\n]*原始工具输出[^\n]*内部路径/, "progress must protect sensitive runtime details");
  assert.match(PLATFORM_RULES, /(?:完成|无法继续|需要用户动作)[^\n]*larkin[^\n]*(?:最终结论|明确请求)/, "terminal outcomes must be sent through larkin");
  assert.match(PLATFORM_RULES, /不可逆|撤回|删除/, "platform rules must carry the irreversible-op convention");
  assert.match(PLATFORM_RULES, /standing instructions.*身份.*权威/, "injected identity must be authoritative");
  assert.match(PLATFORM_RULES, /仅(?:点名|指派).*其他 Agent.*不得回复/, "exclusive assignment must keep non-target agents silent");
  assert.match(PLATFORM_RULES, /thread:<chat_id>:<thread_id>.*threads-messages-list.*data\.messages/, "thread reads must use one target-scoped stable recipe");
  assert.match(PLATFORM_RULES, /2>&1.*(?:禁止|不得).*JSON|JSON.*(?:禁止|不得).*2>&1/, "structured output must keep stderr separate");
});
