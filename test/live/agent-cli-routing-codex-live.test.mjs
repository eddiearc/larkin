import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "bun:test";
import { ensureOfficialLarkCliForSetup } from "../../dist/app/official-lark-cli.mjs";
import { loadAndSyncRuntimeAgent } from "../../dist/app/runtime-process.mjs";
import { createNativeRuntimeAdapter } from "../../dist/runtime/runtime-adapters.mjs";

const RUN = process.env.LARKIN_RUN_AGENT_CLI_ROUTING_CODEX_LIVE === "1" && process.platform !== "darwin";
const ROOT = path.resolve(import.meta.dirname, "../..");
const PROVIDER = path.join(ROOT, "test/support/runtime-agent-interface-v2-provider.mjs");
const PRELOAD = path.join(ROOT, "test/support/runtime-agent-interface-v2-provider-preload.cjs");

function waitForTurnEnd(events, after, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const find = () => events.items.slice(after).find((event) => event.type === "turn-end");
    if (find()) return resolve(find());
    const timer = setTimeout(() => reject(new Error("real Codex routing workflow timed out")), timeoutMs);
    events.waiters.push(() => { if (find()) { clearTimeout(timer); resolve(find()); } });
  });
}

async function promptWhenReady(session, input, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await session.prompt(input);
    if (result.status !== "deferred" || !/not initialized/i.test(result.reason || "")) return result;
    if (Date.now() >= deadline) throw new Error("real Codex initialization timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test.skipIf(!RUN)("real setup dependency install and real Codex app-server keep protected Feishu calls on larkin", { timeout: 15 * 60_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-real-cli-routing-"));
  const home = path.join(temp, "home");
  const prefix = path.join(temp, "npm-prefix");
  const bin = path.join(temp, "bin");
  const workspaceDir = path.join(temp, "workspace");
  const stateDir = path.join(temp, "runtime-state");
  const configDir = path.join(temp, "larkin-config");
  const agentId = "cli_realRoutingA1";
  const callsFile = path.join(temp, "provider-calls.ndjson");
  let session;
  try {
    for (const directory of [home, prefix, bin, workspaceDir, stateDir, configDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const shell = fs.existsSync("/bin/zsh") ? "/bin/zsh" : process.env.SHELL || "/bin/sh";
    const npmCommand = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
    assert.ok(npmCommand, "package-manager executable is required");
    const npmBin = path.dirname(npmCommand);
    const nodeCommand = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
    assert.ok(nodeCommand, "Node.js executable is required by the official lark-cli");
    const nodeRuntimeBin = path.dirname(fs.realpathSync(nodeCommand));
    const profile = `export PATH=${JSON.stringify(path.join(prefix, "bin"))}:${JSON.stringify(bin)}:${JSON.stringify(nodeRuntimeBin)}:${JSON.stringify(path.dirname(process.execPath))}:/usr/local/bin:/usr/bin:/bin\n`;
    fs.writeFileSync(path.join(home, ".bash_profile"), profile, { mode: 0o600 });
    fs.writeFileSync(path.join(home, ".zprofile"), profile, { mode: 0o600 });
    fs.writeFileSync(path.join(home, ".profile"), profile, { mode: 0o600 });
    const installEnv = { ...process.env, HOME: home, ZDOTDIR: home, SHELL: shell, npm_config_prefix: prefix,
      PATH: `${npmBin}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin` };
    const installed = await ensureOfficialLarkCliForSetup({
      interactive: true, confirmInstall: () => true, env: installEnv, shell,
    });
    assert.equal(installed.installed, true);
    assert.equal(installed.command.version, "1.0.79");

    fs.writeFileSync(path.join(bin, "larkin"), `#!/bin/sh\nBUN_OPTIONS=--preload=${JSON.stringify(PRELOAD)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "dist/app/cli.mjs"))} "$@"\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(configDir, "config.json"), `${JSON.stringify({
      version: 4, serverId: "real-cli-routing", mentionPolicy: "require", activeAgent: agentId,
      agents: { [agentId]: { runtime: "codex", model: "default" } },
    })}\n`, { mode: 0o600 });
    const botsDir = path.join(configDir, "bots");
    fs.mkdirSync(botsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(botsDir, `${agentId}.json`), JSON.stringify({
      appId: agentId, appSecret: "fixture-secret", tenant: "feishu",
    }), { mode: 0o600 });
    loadAndSyncRuntimeAgent({ ...installEnv, LARKIN_CONFIG_DIR: configDir }, agentId);
    fs.writeFileSync(callsFile, "", { mode: 0o600 });
    fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), [
      "# Controlled real Codex routing workflow",
      "Execute only the two exact absolute larkin commands requested. Never invoke bare lark-cli or inspect files/environment.",
      "Treat a nonzero freshness_conflict as the expected terminal result.", "",
    ].join("\n"), { mode: 0o600 });

    const codexCommand = execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim();
    assert.ok(codexCommand, "codex executable is required");
    const commandAudit = [];
    const captureSpawn = (command, args, options) => {
      const child = spawn(command, args, options);
      const stdout = new PassThrough();
      let pending = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout.write(chunk); pending += chunk;
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline < 0) break;
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          try {
            const message = JSON.parse(line); const item = message.params?.item;
            if (message.method === "item/completed" && item?.type === "commandExecution") {
              commandAudit.push({ command: item.command, exit_code: item.exitCode,
                output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "" });
            }
          } catch { /* Only app-server protocol frames are evidence. */ }
        }
      });
      child.stdout.on("end", () => stdout.end());
      return { stdin: child.stdin, stdout, stderr: child.stderr, pid: child.pid,
        once: child.once.bind(child), on: child.on.bind(child), kill: child.kill.bind(child) };
    };
    const adapter = createNativeRuntimeAdapter("codex", { codexCommand, spawn: captureSpawn });
    const larkin = path.join(bin, "larkin");
    const authenticatedHome = process.env.HOME;
    assert.ok(authenticatedHome, "real Codex live validation requires the caller's authenticated HOME");
    session = await adapter.createSession({ agentId, workspaceDir, stateDir,
      standingPrompt: "Use only the exact Larkin commands in the request.",
      env: {
        ...installEnv, HOME: authenticatedHome,
        PATH: `${bin}:${path.join(prefix, "bin")}:${path.dirname(codexCommand)}:${nodeRuntimeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LARKIN_CONFIG_DIR: configDir, LARKIN_AGENT_ID: agentId, LARKIN_RUNTIME_OBSERVATION_GENERATION: "real-codex",
        LARKIN_TEST_OFFICIAL_LARK_CLI: installed.command.command,
        LARKIN_TEST_FRESHNESS_PROVIDER: PROVIDER, LARKIN_TEST_PROVIDER_CALLS: callsFile,
        LARKIN_TEST_PROVIDER_HISTORY: JSON.stringify({ ok: true, identity: "bot", data: { messages: [
          { message_id: "om_real_newer", chat_id: "oc_realRouting", create_time: "1785280000000" },
        ] } }),
      },
    });
    const events = { items: [], waiters: [] };
    session.subscribe((event) => { events.items.push(event); for (const waiter of events.waiters) waiter(event); });
    const after = events.items.length;
    const accepted = await promptWhenReady(session, { inputId: "real-cli-routing", kind: "initial", attempt: 0,
      text: `Run exactly ${JSON.stringify(larkin)} --version, then exactly ${JSON.stringify(larkin)} im +messages-send --chat-id oc_realRouting --text stale. Stop after the expected nonzero freshness_conflict.` });
    assert.equal(accepted.status, "accepted");
    await waitForTurnEnd(events, after);
    assert.equal(events.items.slice(after).find((event) => ["error", "configuration-error", "input-error"].includes(event.type)
      && event.retryable !== true && event.willRetry !== true), undefined);
    assert.equal(commandAudit.length, 2, JSON.stringify(commandAudit));
    assert.equal(commandAudit.every((item) => item.command.includes(larkin) && !/(^|\s)lark-cli(?:\s|$)/.test(item.command)), true);
    assert.deepEqual(commandAudit.map((item) => item.exit_code), [0, 3], JSON.stringify(commandAudit));
    const calls = fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(calls.filter((call) => call.argv.includes("+messages-send")).length, 0);
    assert.equal(calls.filter((call) => call.argv.includes("/open-apis/im/v1/messages")).length, 1);
    const larkConfigDir = path.join(configDir, "state", "agents", agentId, "lark-cli-config");
    assert.equal(calls.every((call) => call.config_dir === larkConfigDir), true);
  } finally {
    await session?.close("real CLI routing workflow complete");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
