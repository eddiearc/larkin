import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { createRuntimeCliBinding, ensureCompatibleGlobalLarkCli } from "../../dist/app/runtime-cli-binding.mjs";

const liveTest = process.env.LARKIN_RUN_RUNTIME_CLI_DELEGATE_WORKFLOW === "1" ? test : test.skip;

liveTest("Mock E2E: login zsh/bash delegate isolated Agents through Larkin and block stale writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-cli-workflow-"));
  fs.chmodSync(root, 0o700);
  const bin = path.join(root, "bin");
  const zdot = path.join(root, "zdot");
  const home = path.join(root, "home");
  const oldBin = path.join(root, "old-bin");
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.mkdirSync(zdot, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(oldBin, { mode: 0o700 });
  const marker = path.join(root, "provider.ndjson");
  const cli = path.join(bin, "lark-cli");
  const fixture = `#!/usr/bin/env bun
const fs=require("node:fs"),cp=require("node:child_process");
const args=process.argv.slice(2),env=process.env;
if(args.length===1&&args[0]==="__runtime-delegate-capabilities"){
  process.stdout.write(JSON.stringify({name:"lark-cli",version:"workflow-fixture",runtimeDelegateProtocol:1})+"\\n");process.exit(0);
}
if(!env.LARK_CLI_RUNTIME_BOUND){
  const d=JSON.parse(fs.readFileSync(env.LARK_CLI_RUNTIME_DELEGATE,"utf8"));
  const childEnv={...env,LARK_CLI_RUNTIME_NATIVE_EXECUTABLE:d.context.nativeCli,LARK_CLI_RUNTIME_NATIVE_VERSION:d.context.nativeVersion};
  const r=cp.spawnSync(d.delegate,[...d.delegateArgs,...args],{env:childEnv,stdio:"inherit",cwd:process.cwd()});process.exit(r.status??1);
}
if(args[0]==="api"){
  const params=JSON.parse(args[args.indexOf("--params")+1]);
  fs.appendFileSync(env.PROVIDER_MARKER,JSON.stringify({kind:"probe",agent:env.LARKIN_AGENT_ID,chat:params.container_id})+"\\n");
  process.stdout.write(JSON.stringify({ok:true,identity:"bot",data:{messages:[{message_id:"om_stale_"+env.LARKIN_AGENT_ID,chat_id:params.container_id,create_time:"200"}]}})+"\\n");
  process.exit(0);
}
fs.appendFileSync(env.PROVIDER_MARKER,JSON.stringify({kind:"write",agent:env.LARKIN_AGENT_ID,args})+"\\n");process.exit(0);
`;
  fs.writeFileSync(cli, fixture, { mode: 0o700 });
  fs.writeFileSync(path.join(oldBin, "lark-cli"), "#!/bin/sh\nprintf '%s\\n' '{\"name\":\"lark-cli\",\"version\":\"old\",\"runtimeDelegateProtocol\":0}'\n", { mode: 0o700 });
  const zshMarker = path.join(root, "zprofile-started");
  const bashMarker = path.join(root, "bash-profile-started");
  const zshrcMarker = path.join(root, "zshrc-must-not-run");
  fs.writeFileSync(path.join(zdot, ".zprofile"), `export PATH=${JSON.stringify(bin)}:$PATH\nprintf started > ${JSON.stringify(zshMarker)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(zdot, ".zshrc"), `alias lark-cli=${JSON.stringify(path.join(oldBin, "lark-cli"))}\nexport PATH=${JSON.stringify(oldBin)}:$PATH\nprintf bad > ${JSON.stringify(zshrcMarker)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(home, ".bash_profile"), `export PATH=${JSON.stringify(bin)}:$PATH\nprintf started > ${JSON.stringify(bashMarker)}\n`, { mode: 0o600 });
  const agents = ["cli_WorkflowA1", "cli_WorkflowB2"];
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "workflow", mentionPolicy: "require", activeAgent: agents[0],
    agents: Object.fromEntries(agents.map((agentId) => [agentId, { runtime: "codex", model: "default" }])),
  })}\n`, { mode: 0o600 });
  try {
    const shellCases = [
      { shell: "/bin/zsh", env: { ...process.env, HOME: home, ZDOTDIR: zdot } },
      { shell: "/bin/bash", env: { ...process.env, HOME: home } },
    ];
    for (const shellCase of shellCases) ensureCompatibleGlobalLarkCli(root, shellCase);
    assert.equal(fs.readFileSync(zshMarker, "utf8"), "started");
    assert.equal(fs.readFileSync(bashMarker, "utf8"), "started");
    assert.equal(fs.existsSync(zshrcMarker), false, "non-interactive login zsh must not source .zshrc aliases/PATH");
    const bindings = agents.map((agentId, index) => {
      const stateDir = path.join(root, "state", "agents", agentId);
      const larkConfigDir = path.join(stateDir, "lark-cli-config");
      fs.mkdirSync(larkConfigDir, { recursive: true, mode: 0o700 });
      return createRuntimeCliBinding({ agentId, stateDir, larkConfigDir }, {
        ...shellCases[index].env, SHELL: shellCases[index].shell, LARKIN_CONFIG_DIR: root,
        LARKIN_BINARY_ENTRY_PATH: path.join(import.meta.dirname, "../../dist/app/binary-entry.mjs"),
      });
    });
    assert.notEqual(bindings[0].descriptor, bindings[1].descriptor);
    for (let index = 0; index < agents.length; index += 1) {
      const shellCase = shellCases[index];
      const result = spawnSync(shellCase.shell, ["-lc", `lark-cli im +messages-send --chat-id oc_${index} --text stale`], {
        encoding: "utf8",
        env: { ...shellCase.env, SHELL: shellCase.shell, PROVIDER_MARKER: marker, LARKIN_CONFIG_DIR: root,
          LARKIN_AGENT_ID: agents[index], ...bindings[index].env,
          LARKIN_BINARY_ENTRY_PATH: path.join(import.meta.dirname, "../../dist/app/binary-entry.mjs") },
      });
      assert.equal(result.status, 3, result.stderr || result.stdout);
      assert.match(result.stderr, /freshness_conflict/);
    }
    const calls = fs.readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.map(({ kind, agent, chat }) => ({ kind, agent, chat })), [
      { kind: "probe", agent: agents[0], chat: "oc_0" },
      { kind: "probe", agent: agents[1], chat: "oc_1" },
    ]);
    assert.equal(calls.filter((call) => call.kind === "write").length, 0);
    fs.writeFileSync(path.join(zdot, ".zprofile"), `export PATH=${JSON.stringify(oldBin)}:$PATH\n`, { mode: 0o600 });
    assert.throws(() => createRuntimeCliBinding({ agentId: agents[0], stateDir: path.join(root, "state", "agents", agents[0]),
      larkConfigDir: path.join(root, "state", "agents", agents[0], "lark-cli-config") }, {
      ...shellCases[0].env, SHELL: "/bin/zsh", LARKIN_CONFIG_DIR: root,
    }), /login shell.*setup/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
