import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PROVIDER = path.join(ROOT, "test/support/runtime-agent-interface-v2-provider.mjs");

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
}

function fixture(shell) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-agent-shell-${path.basename(shell)}-`));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, "home");
  const bin = path.join(root, "managed-bin");
  const calls = path.join(root, "provider-calls.ndjson");
  const agents = ["cli_shellAgentA1", "cli_shellAgentB2"];
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(bin, { mode: 0o700 });
  writePrivate(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "shell-routing", mentionPolicy: "require", activeAgent: agents[0],
    agents: Object.fromEntries(agents.map((agentId) => [agentId, { runtime: "codex", model: "default" }])),
  })}\n`);
  for (const agentId of agents) {
    writePrivate(path.join(root, "state", "agents", agentId, "lark-cli-config", "config.json"), `${JSON.stringify({
      apps: [{ appId: agentId, name: agentId, appSecret: "fixture", brand: "feishu", defaultAs: "bot", strictMode: "bot", users: [] }],
    })}\n`);
    writePrivate(path.join(root, "state", "agents", agentId, "lark-channel-source", "config.json"), `${JSON.stringify({
      accounts: { app: { id: agentId, secret: { source: "exec", provider: "larkin-bot-credential", id: agentId } } },
      secrets: { providers: { "larkin-bot-credential": { source: "exec", command: process.execPath, args: [], env: {
        LARKIN_AGENT_ID: agentId, LARKIN_SECRET_PROVIDER_CONTEXT: "bind",
      } } } },
    })}\n`);
    writePrivate(path.join(root, "state", "agents", agentId, "lark-cli-config", "lark-channel", "config.json"), `${JSON.stringify({ apps: [{
      appId: agentId, appSecret: { source: "keychain", id: `appsecret:${agentId}` }, defaultAs: "bot", strictMode: "bot", users: [],
    }] })}\n`);
  }
  const packageDir = path.join(root, "official", "node_modules", "@larksuite", "cli");
  const official = path.join(packageDir, "scripts", "run.sh");
  fs.mkdirSync(path.dirname(official), { recursive: true, mode: 0o700 });
  writePrivate(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@larksuite/cli", version: "1.0.80", bin: { "lark-cli": "scripts/run.sh" },
  }));
  fs.writeFileSync(official, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.0.80\\n'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "bind" ] && [ "$3" = "--help" ]; then printf '%s\\n' '--source lark-channel --identity bot-only'; exit 0; fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(PROVIDER)} "$@"
`, { mode: 0o700 });
  fs.symlinkSync(official, path.join(bin, "lark-cli"));
  fs.writeFileSync(path.join(bin, "larkin"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "dist", "app", "cli.mjs"))} "$@"\n`, { mode: 0o700 });
  const profile = `export PATH=${JSON.stringify(bin)}:${JSON.stringify(path.dirname(process.execPath))}:/usr/bin:/bin\nprintf 'loaded\\n' >> ${JSON.stringify(path.join(root, "startup.marker"))}\n`;
  fs.writeFileSync(path.join(home, ".bash_profile"), profile, { mode: 0o600 });
  fs.writeFileSync(path.join(home, ".zprofile"), profile, { mode: 0o600 });
  const baseEnv = { ...process.env, HOME: home, ZDOTDIR: home, SHELL: shell,
    BASH_ENV: path.join(home, ".bash_profile"), LARKIN_CONFIG_DIR: root,
    LARKIN_TEST_PROVIDER_CALLS: calls, PATH: `/usr/bin:/bin:${bin}` };
  return { root, agents, calls, baseEnv };
}

for (const shell of ["/bin/bash", "/bin/zsh"]) {
  test.skipIf(!fs.existsSync(shell))(`${path.basename(shell)} login-shell routing keeps two Agents on larkin AOP and blocks the stale write`, () => {
    const f = fixture(shell);
    const chatId = "oc_shellRouting";
    try {
      const first = spawnSync(shell, ["-lc", `larkin im +messages-send --chat-id ${chatId} --text first`], {
        cwd: f.root, encoding: "utf8", env: { ...f.baseEnv, LARKIN_AGENT_ID: f.agents[0],
          LARKIN_RUNTIME_OBSERVATION_GENERATION: "agent-a", LARKIN_TEST_PROVIDER_HISTORY: JSON.stringify({ ok: true, identity: "bot", data: { messages: [] } }),
          LARKIN_TEST_PROVIDER_WRITE_STDOUT: JSON.stringify({ ok: true, data: { message_id: "om_shell_first", chat_id: chatId, create_time: "1" } }) },
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      const staleHistory = JSON.stringify({ ok: true, identity: "bot", data: { messages: [
        { message_id: "om_shell_first", chat_id: chatId, create_time: "1" },
      ] } });
      const second = spawnSync(shell, ["-lc", `larkin im +messages-send --chat-id ${chatId} --text stale`], {
        cwd: f.root, encoding: "utf8", env: { ...f.baseEnv, LARKIN_AGENT_ID: f.agents[1],
          LARKIN_RUNTIME_OBSERVATION_GENERATION: "agent-b", LARKIN_TEST_PROVIDER_HISTORY: staleHistory },
      });
      assert.equal(second.status, 3, second.stderr || second.stdout);
      assert.equal(JSON.parse(second.stderr).error.subtype, "freshness_conflict");
      const providerCalls = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(providerCalls.filter((call) => call.argv?.includes("+messages-send")).length, 1);
      assert.deepEqual(new Set(providerCalls.map((call) => call.config_dir)), new Set(f.agents.map((agentId) =>
        path.join(f.root, "state", "agents", agentId, "lark-cli-config"))));
      assert.match(fs.readFileSync(path.join(f.root, "startup.marker"), "utf8"), /loaded/);
      for (const agentId of f.agents) assert.equal(fs.existsSync(path.join(f.root, "state", "agents", agentId, "runtime-bin", "lark-cli")), false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}
