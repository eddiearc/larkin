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

test.skipIf(!enabled)("Bun source dependency keeps one Runtime-bound larkin bin and uses a host official CLI", { timeout: 180_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-git-dependency-"));
  try {
    const sourceRepo = path.join(temp, "source");
    const consumer = path.join(temp, "consumer");
    fs.mkdirSync(sourceRepo);
    fs.mkdirSync(consumer);
    for (const relative of ["src", "assets", "scripts", "patches", "README.md", "package.json", "bun.lock"]) {
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
    const isolatedHome = path.join(temp, "home");
    const npmPrefix = path.join(temp, "npm-prefix");
    fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(npmPrefix, { recursive: true, mode: 0o700 });
    const isolatedEnv = {
      ...process.env,
      HOME: isolatedHome,
      SHELL: "/bin/bash",
      npm_config_prefix: npmPrefix,
      BUN_INSTALL_CACHE_DIR: path.join(temp, "bun-cache"),
      PATH: `${path.join(npmPrefix, "bin")}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
    };
    fs.writeFileSync(path.join(isolatedHome, ".bash_profile"), `export PATH=${JSON.stringify(path.join(npmPrefix, "bin"))}:${JSON.stringify(path.dirname(process.execPath))}:/usr/local/bin:/usr/bin:/bin\n`, { mode: 0o600 });
    checked("npm", ["install", "--global", "@larksuite/cli@1.0.80"], { env: isolatedEnv, timeout: 120_000 }, "install host official CLI into isolated prefix");
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
    const transport = path.join(installed, "dist", "agent", "agent-transport.cjs");
    assert.equal(fs.existsSync(cli), true, "prepare must generate dist/app/cli.mjs");
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
    assert.equal(fs.existsSync(larkBin), false, "installed package must not expose a second lark-cli launcher");
    assert.equal(JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8")).dependencies["@larksuite/cli"], undefined);
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
    if (process.platform === "darwin") {
      const sourceDir = path.join(inboxDir, "lark-channel-source");
      const workspaceDir = path.join(inboxDir, "lark-cli-config", "lark-channel");
      for (const directory of [sourceDir, workspaceDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(sourceDir, "config.json"), JSON.stringify({
        accounts: { app: { id: "cli_test", secret: { source: "exec", provider: "larkin-bot-credential", id: "cli_test" } } },
        secrets: { providers: { "larkin-bot-credential": { source: "exec", command: process.execPath, args: [],
          env: { LARKIN_AGENT_ID: "cli_test", LARKIN_SECRET_PROVIDER_CONTEXT: "bind" } } } },
      }), { mode: 0o600 });
      fs.writeFileSync(path.join(workspaceDir, "config.json"), JSON.stringify({ apps: [{ appId: "cli_test",
        appSecret: { source: "keychain", id: "appsecret:cli_test" }, defaultAs: "bot", strictMode: "bot", users: null }] }), { mode: 0o600 });
    }
    const syncResult = checked(process.execPath, ["--eval", `
      const runtimeProcess = await import(${JSON.stringify(pathToFileURL(path.join(installed, "dist", "app", "runtime-process.mjs")).href)});
      const runtimeConfig = await import(${JSON.stringify(pathToFileURL(path.join(installed, "dist", "app", "runtime-agent-config.mjs")).href)});
      const platformConfig = await import(${JSON.stringify(pathToFileURL(path.join(installed, "dist", "platform", "config.mjs")).href)});
      const agent = process.platform === "darwin"
        ? runtimeConfig.hydrateRuntimeAgent(process.env.LARKIN_CONFIG_DIR,
          platformConfig.selectAgent(platformConfig.loadConfig(process.env).config, process.env))
        : runtimeProcess.loadAndSyncRuntimeAgent(process.env, "cli_test");
      if (process.platform === "darwin") runtimeConfig.installRuntimeCommandShims(agent);
      process.stdout.write(agent.stateDir);
    `], { cwd: consumer, env: runtimeEnv, timeout: 30_000 }, process.platform === "darwin"
      ? "prepare installed package with a keychain-safe workspace fixture"
      : "bind installed package Agent lark-channel workspace");
    assert.equal(syncResult.stdout.trim(), inboxDir);
    const installedProfile = JSON.parse(fs.readFileSync(path.join(inboxDir, "lark-cli-config", "lark-channel", "config.json"), "utf8"));
    assert.deepEqual(installedProfile.apps.map((app) => ({
      appId: app.appId, defaultAs: app.defaultAs, strictMode: app.strictMode, users: app.users,
    })), [{ appId: "cli_test", defaultAs: "bot", strictMode: "bot", users: null }]);
    assert.deepEqual(installedProfile.apps[0].appSecret, { source: "keychain", id: "appsecret:cli_test" });
    const runtimeBin = path.join(inboxDir, "runtime-bin");
    const runtimeLarkin = path.join(runtimeBin, "larkin");
    const runtimeLarkCliPath = path.join(runtimeBin, "lark-cli");
    const runtimeLarkCli = runtimeLarkin;
    assert.equal(fs.statSync(runtimeLarkin).mode & 0o077, 0);
    assert.equal(fs.existsSync(runtimeLarkCliPath), false);
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
    const officialCli = await import(pathToFileURL(path.join(installed, "dist", "app", "official-lark-cli.mjs")).href);
    const pinnedNative = officialCli.resolveOfficialLarkCli({ env: runtimeEnv });
    assert.match([pinnedNative.command, ...pinnedNative.argsPrefix].join(" "), /@larksuite[/\\]cli|lark-cli/);
    const evaluatorHelpArgv = ["im", "+messages-send", "--as", "user", "--chat-id", "a", "--chat-id=b", "--help"];
    const installedWorkspaceFile = path.join(inboxDir, "lark-cli-config", "lark-channel", "config.json");
    const beforeHelpConfig = fs.readFileSync(installedWorkspaceFile);
    const beforeHelpState = fs.readFileSync(path.join(inboxDir, "inbox-state.json"));
    const directEvaluatorHelp = spawnSync(pinnedNative.command, [...pinnedNative.argsPrefix, ...evaluatorHelpArgv], {
      cwd: consumer,
      env: { ...runtimeEnv, LARK_CHANNEL: "1",
        LARK_CHANNEL_CONFIG: path.join(inboxDir, "lark-channel-source", "config.json"),
        LARKSUITE_CLI_CONFIG_DIR: path.join(inboxDir, "lark-cli-config") },
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
    assert.deepEqual(fs.readFileSync(installedWorkspaceFile), beforeHelpConfig);
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
        env: { ...runtimeEnv, LARK_CHANNEL: "1",
          LARK_CHANNEL_CONFIG: path.join(inboxDir, "lark-channel-source", "config.json"),
          LARKSUITE_CLI_CONFIG_DIR: path.join(inboxDir, "lark-cli-config") },
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
      ["im", "+messages-send", "--chat-id", "oc_installed", "--text", "observational dry run", "--dry-run"],
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
