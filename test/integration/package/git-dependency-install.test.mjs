import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const enabled = process.env.LARKIN_RUN_GIT_DEPENDENCY_TEST === "1";

function checked(command, args, options, label) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

test.skipIf(!enabled)("Bun source dependency workflow exposes Runtime-bound larkin and package-local lark-cli bins", { timeout: 180_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-git-dependency-"));
  try {
    const sourceRepo = path.join(temp, "source");
    const consumer = path.join(temp, "consumer");
    fs.mkdirSync(sourceRepo);
    fs.mkdirSync(consumer);
    for (const relative of ["src", "assets", "scripts", "README.md", "package.json", "bun.lock"]) {
      fs.cpSync(path.join(ROOT, relative), path.join(sourceRepo, relative), { recursive: true });
    }
    checked("git", ["init", "--quiet", sourceRepo], {}, "git init source fixture");
    checked("git", ["-C", sourceRepo, "config", "user.name", "Larkin Test"], {}, "configure fixture user name");
    checked("git", ["-C", sourceRepo, "config", "user.email", "larkin-test@example.invalid"], {}, "configure fixture user email");
    checked("git", ["-C", sourceRepo, "add", "."], {}, "stage source fixture");
    checked("git", ["-C", sourceRepo, "commit", "--quiet", "-m", "source fixture"], {}, "commit source fixture");
    assert.equal(fs.existsSync(path.join(sourceRepo, "dist")), false, "Git source fixture must start without dist");

    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({
      name: "larkin-git-consumer",
      private: true,
      trustedDependencies: ["larkin"],
    }, null, 2));
    const isolatedEnv = {
      ...process.env,
      HOME: path.join(temp, "home"),
      BUN_INSTALL_CACHE_DIR: path.join(temp, "bun-cache"),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
    };
    checked(process.execPath, ["install", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: sourceRepo,
      env: isolatedEnv,
      timeout: 120_000,
    }, "install source fixture dependencies with Bun");
    checked(process.execPath, ["run", "prepare"], {
      cwd: sourceRepo,
      env: isolatedEnv,
      timeout: 120_000,
    }, "prepare source fixture with Bun");
    checked(process.execPath, ["add", `file:${sourceRepo}`], {
      cwd: consumer,
      env: isolatedEnv,
      timeout: 120_000,
    }, "install local source dependency with Bun");

    const installed = path.join(consumer, "node_modules", "larkin");
    const cli = path.join(installed, "dist", "app", "cli.mjs");
    const larkCliLauncher = path.join(installed, "dist", "app", "lark-cli.mjs");
    const transport = path.join(installed, "dist", "agent", "agent-transport.cjs");
    assert.equal(fs.existsSync(cli), true, "prepare must generate dist/app/cli.mjs");
    assert.equal(fs.statSync(larkCliLauncher).mode & 0o111, 0o111, "package-local lark-cli launcher must be executable");
    assert.equal(fs.existsSync(transport), true, "prepare must generate the CJS transport");
    assert.equal(fs.existsSync(path.join(installed, "test")), false, "installed Git dependency must exclude repository tests");
    const bin = process.platform === "win32"
      ? path.join(consumer, "node_modules", ".bin", "larkin.cmd")
      : path.join(consumer, "node_modules", ".bin", "larkin");
    const help = checked(bin, ["--help"], { cwd: consumer, env: isolatedEnv, timeout: 15_000 }, "run Git-installed package bin");
    assert.match(help.stdout, /Usage:\s*larkin <command>/);
    const larkBin = process.platform === "win32"
      ? path.join(consumer, "node_modules", ".bin", "larkin-lark-cli.cmd")
      : path.join(consumer, "node_modules", ".bin", "larkin-lark-cli");
    assert.equal(fs.existsSync(larkBin), true, "installed package must expose its collision-free fixed lark-cli launcher");
    assert.equal(JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8")).dependencies["@larksuite/cli"], "1.0.78");
    const importConfigDir = path.join(temp, "import-config");
    fs.mkdirSync(importConfigDir, { recursive: true });
    fs.writeFileSync(path.join(importConfigDir, "config.json"), `${JSON.stringify({
      version: 4,
      serverId: "git-dependency-test",
      mentionPolicy: "require",
      activeAgent: "cli_test",
      agents: { cli_test: { runtime: "pi", model: "default" } },
    }, null, 2)}\n`, { mode: 0o600 });
    const runtimeEnv = { ...isolatedEnv, LARKIN_CONFIG_DIR: importConfigDir, LARKIN_AGENT_ID: "cli_test" };
    const inboxDir = path.join(importConfigDir, "state", "agents", "cli_test");
    fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
    const botsDir = path.join(importConfigDir, "bots");
    fs.mkdirSync(botsDir, { mode: 0o700 });
    fs.writeFileSync(path.join(botsDir, "cli_test.json"), JSON.stringify({
      appId: "cli_test", appSecret: "installed-fixture-secret", tenant: "feishu",
    }), { mode: 0o600 });
    const syncResult = checked(process.execPath, ["--eval", `
      const runtimeProcess = await import(${JSON.stringify(pathToFileURL(path.join(installed, "dist", "app", "runtime-process.mjs")).href)});
      const agent = runtimeProcess.loadAndSyncRuntimeAgent(process.env, "cli_test");
      process.stdout.write(agent.stateDir);
    `], { cwd: consumer, env: runtimeEnv, timeout: 30_000 }, "sync installed package-local Bot-only profile");
    assert.equal(syncResult.stdout.trim(), inboxDir);
    const installedProfile = JSON.parse(fs.readFileSync(path.join(inboxDir, "lark-cli-config", "config.json"), "utf8"));
    assert.deepEqual(installedProfile.apps.map((app) => ({
      appId: app.appId, name: app.name, defaultAs: app.defaultAs, strictMode: app.strictMode, users: app.users,
    })), [{ appId: "cli_test", name: "cli_test", defaultAs: "bot", strictMode: "bot", users: [] }]);
    const runtimeBin = path.join(inboxDir, "runtime-bin");
    const runtimeLarkin = path.join(runtimeBin, "larkin");
    const runtimeLarkCli = path.join(runtimeBin, "lark-cli");
    assert.equal(fs.statSync(runtimeLarkin).mode & 0o077, 0);
    assert.equal(fs.statSync(runtimeLarkCli).mode & 0o077, 0);
    const inboxFile = path.join(inboxDir, "feishu-inbox.ndjson");
    fs.writeFileSync(inboxFile, `${JSON.stringify({
      envelope_version: 2, target: "chat:oc_installed", target_seq: 1,
      message_id: "om_installed_1", chat_id: "oc_installed", sender_id: "ou_fixture", content: "installed workflow body",
    })}\n`, { mode: 0o600 });
    const beforeCheck = fs.readFileSync(inboxFile);
    const checkedInbox = JSON.parse(checked(runtimeLarkin, ["inbox", "check"], {
      cwd: consumer, env: runtimeEnv, timeout: 15_000,
    }, "run installed Runtime-bound inbox check").stdout);
    assert.deepEqual(checkedInbox.targets.map(({ target, pending_count }) => ({ target, pending_count })), [
      { target: "chat:oc_installed", pending_count: 1 },
    ]);
    assert.equal("events" in checkedInbox, false);
    assert.deepEqual(fs.readFileSync(inboxFile), beforeCheck, "installed check must not consume Inbox bytes");
    const polledInbox = JSON.parse(checked(runtimeLarkin, ["inbox", "poll", "--target", "chat:oc_installed"], {
      cwd: consumer, env: runtimeEnv, timeout: 15_000,
    }, "run installed Runtime-bound inbox poll").stdout);
    assert.equal(polledInbox.delivery, "direct_ack");
    assert.equal(polledInbox.at_most_once, true);
    assert.equal(polledInbox.events[0].content, "installed workflow body");
    assert.equal(JSON.parse(checked(runtimeLarkin, ["inbox", "poll", "--target", "chat:oc_installed"], {
      cwd: consumer, env: runtimeEnv, timeout: 15_000,
    }, "repeat installed Runtime-bound inbox poll").stdout).events.length, 0);

    const nativeHelp = checked(runtimeLarkCli, ["--help"], {
      cwd: consumer, env: runtimeEnv, timeout: 120_000,
    }, "run installed package-local native lark-cli help");
    assert.match(nativeHelp.stdout, /lark-cli|Usage|USAGE/i);
    const runtimeAgentConfig = await import(pathToFileURL(path.join(installed, "dist", "app", "runtime-agent-config.mjs")).href);
    const pinnedNative = runtimeAgentConfig.resolvePinnedLarkCliCommand(inboxDir);
    assert.match([pinnedNative.command, ...pinnedNative.argsPrefix].join(" "), /@larksuite[/\\]cli|lark-cli/);
    const evaluatorHelpArgv = ["im", "+messages-send", "--as", "user", "--chat-id", "a", "--chat-id=b", "--help"];
    const beforeHelpConfig = fs.readFileSync(path.join(inboxDir, "lark-cli-config", "config.json"));
    const beforeHelpState = fs.readFileSync(path.join(inboxDir, "inbox-state.json"));
    const directEvaluatorHelp = spawnSync(pinnedNative.command, [...pinnedNative.argsPrefix, ...evaluatorHelpArgv], {
      cwd: consumer,
      env: { ...runtimeEnv, LARKSUITE_CLI_CONFIG_DIR: path.join(inboxDir, "lark-cli-config") },
      encoding: "utf8", timeout: 15_000,
    });
    const wrappedEvaluatorHelp = spawnSync(runtimeLarkCli, evaluatorHelpArgv, {
      cwd: consumer, env: runtimeEnv, encoding: "utf8", timeout: 15_000,
    });
    assert.deepEqual(
      { status: wrappedEvaluatorHelp.status, stdout: wrappedEvaluatorHelp.stdout, stderr: wrappedEvaluatorHelp.stderr },
      { status: directEvaluatorHelp.status, stdout: directEvaluatorHelp.stdout, stderr: directEvaluatorHelp.stderr },
      "Runtime help must preserve native stdout/stderr/exit exactly",
    );
    assert.equal(wrappedEvaluatorHelp.status, 0);
    assert.deepEqual(fs.readFileSync(path.join(inboxDir, "lark-cli-config", "config.json")), beforeHelpConfig);
    assert.deepEqual(fs.readFileSync(path.join(inboxDir, "inbox-state.json")), beforeHelpState);

    const boundedHistory = checked(runtimeLarkCli, [
      "im", "+chat-messages-list", "--chat-id", "oc_installed_window", "--dry-run", "--json",
    ], {
      cwd: consumer, env: runtimeEnv, timeout: 15_000,
    }, "run installed Runtime history shortcut with Larkin default window");
    assert.match(boundedHistory.stdout, /"page_size"\s*:\s*(?:"20"|20)/,
      "installed Runtime wrapper must override the pinned shortcut default 50 with 20");

    for (const dryRunArgv of [
      ["--chat-id", "oc_native_order", "im", "+messages-send", "--text", "native prefix", "--dry-run"],
      ["im", "--chat-id", "oc_native_order", "+messages-send", "--text", "native middle", "--dry-run"],
    ]) {
      const nativeDryRun = checked(pinnedNative.command, [...pinnedNative.argsPrefix, ...dryRunArgv], {
        cwd: consumer,
        env: { ...runtimeEnv, LARKSUITE_CLI_CONFIG_DIR: path.join(inboxDir, "lark-cli-config") },
        timeout: 15_000,
      }, `run native ordered flag dry-run: ${dryRunArgv.join(" ")}`);
      assert.match(nativeDryRun.stdout, /oc_native_order/);
    }
    const identityEscape = spawnSync(runtimeLarkCli, ["im", "+chat-list", "--profile", "idan"], {
      cwd: consumer, env: runtimeEnv, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(identityEscape.status, 2);
    assert.match(identityEscape.stderr, /身份边界|--profile/);
    fs.appendFileSync(inboxFile, `${JSON.stringify({
      envelope_version: 2, target: "chat:oc_installed", target_seq: 2,
      message_id: "om_installed_unseen", chat_id: "oc_installed", content: "new installed context",
    })}\n`);
    for (const guardedArgv of [
      ["--chat-id", "oc_installed", "im", "+messages-send", "--text", "stale prefix", "--dry-run"],
      ["im", "--chat-id", "oc_installed", "+messages-send", "--text", "stale middle", "--dry-run"],
    ]) {
      const held = spawnSync(runtimeLarkCli, guardedArgv, {
        cwd: consumer, env: runtimeEnv, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(held.status, 0, held.stderr);
      assert.notEqual(JSON.parse(held.stdout).status, "held", "native dry-run is observational and does not enter the write gate");
    }
    const duplicateTarget = spawnSync(runtimeLarkCli, ["im", "+messages-send", "--chat-id", "oc_first", "--chat-id=oc_last", "--text", "x"], {
      cwd: consumer, env: runtimeEnv, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(duplicateTarget.status, 2);
    assert.match(duplicateTarget.stderr, /--chat-id.*重复|参数边界/);
    const genericBypass = spawnSync(runtimeLarkCli, ["--as", "bot", "api", "POST", "/open-apis/im/v1/messages"], {
      cwd: consumer, env: runtimeEnv, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(genericBypass.status, 2);
    assert.match(genericBypass.stderr, /generic API/);
    const unsafeForward = spawnSync(runtimeLarkCli, ["im", "messages", "forward", "--message-id", "om_installed_1"], {
      cwd: consumer, env: runtimeEnv, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(unsafeForward.status, 2);
    assert.match(unsafeForward.stderr, /target freshness/);
    const unsafeThreadForward = spawnSync(runtimeLarkCli, ["im", "threads", "forward", "--message-id", "om_installed_1"], {
      cwd: consumer, env: runtimeEnv, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(unsafeThreadForward.status, 2);
    assert.match(unsafeThreadForward.stderr, /target freshness/);
    const importedTransport = checked(process.execPath, ["--eval", `
      const transport = await import(${JSON.stringify(pathToFileURL(transport).href)});
      if (typeof transport.createAgentTransport !== "function") {
        throw new Error("installed transport does not export createAgentTransport");
      }
      process.stdout.write("createAgentTransport:function\\n");
    `], {
      cwd: consumer,
      env: { ...isolatedEnv, LARKIN_CONFIG_DIR: importConfigDir },
      timeout: 15_000,
    }, "dynamically import Git-installed CJS transport with Bun");
    assert.equal(importedTransport.stdout.trim(), "createAgentTransport:function");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
