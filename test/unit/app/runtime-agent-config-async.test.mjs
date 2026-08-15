import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncAgentProfileAsync } from "../../../dist/app/runtime-agent-config.mjs";

function fixture(root, mode) {
  const agentId = "cli_asyncProfileA1";
  const stateDir = path.join(root, "state", "agents", agentId);
  const larkConfigDir = path.join(stateDir, "lark-cli-config");
  const script = path.join(root, `lark-cli-${mode}.mjs`);
  fs.writeFileSync(script, `import fs from "node:fs"; import path from "node:path";\n`
    + `const mode=process.env.TEST_CLI_MODE;\n`
    + `if(mode==="timeout"||mode==="abort") await new Promise(()=>{});\n`
    + `if(mode==="overflow"){process.stdout.write("x".repeat(131072));await new Promise(r=>setTimeout(r,1000));}\n`
    + `const dir=path.join(process.env.LARKSUITE_CLI_CONFIG_DIR,"lark-channel");fs.mkdirSync(dir,{recursive:true,mode:0o700});\n`
    + `fs.writeFileSync(path.join(dir,"config.json"),JSON.stringify({apps:[{appId:process.env.TEST_APP_ID,appSecret:{source:"keychain",id:"appsecret:"+process.env.TEST_APP_ID},defaultAs:"bot",strictMode:"bot",users:[]}]}),{mode:0o600});\n`, { mode: 0o600 });
  return {
    agent: {
      agentId, feishuAppId: agentId, feishuAppSecret: "async-secret-sentinel", feishuDomain: "https://open.feishu.cn",
      credentialRevision: "updated:async", stateDir, larkConfigDir,
      workspaceDir: path.join(root, "agents", agentId), runtime: "pi", model: "default", feishuProfile: agentId,
    },
    env: { ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_BUN_TEST_RUNNER: "1", TEST_CLI_MODE: mode, TEST_APP_ID: agentId },
    resolveOfficialCli: () => ({ command: process.execPath, argsPrefix: [script], version: "1.0.80" }),
  };
}

test("async profile sync bounds timeout/output and cleans children on abort", { timeout: 15_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-profile-async-"));
  const previousTestRunner = process.env.LARKIN_BUN_TEST_RUNNER;
  process.env.LARKIN_BUN_TEST_RUNNER = "1";
  try {
    for (const mode of ["timeout", "overflow", "abort"]) {
      const root = path.join(temp, mode);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const input = fixture(root, mode);
      const children = [];
      const controller = new AbortController();
      if (mode === "abort") setTimeout(() => controller.abort(), 100);
      await assert.rejects(() => syncAgentProfileAsync(input.agent, input.env, {
        forceRebind: true,
        resolveOfficialCli: input.resolveOfficialCli,
        timeoutMs: mode === "timeout" ? 100 : 5_000,
        maxOutputBytes: 1024,
        signal: controller.signal,
        onChild(child) { children.push(child); },
      }), mode === "timeout" ? /timed out/ : mode === "overflow" ? /bounded limit/ : /cancelled/);
      assert.ok(children[0], `${mode} must expose its pending child`);
      assert.equal(children.at(-1), null, `${mode} must clear the pending child`);
      assert.notEqual(children[0].exitCode === null && children[0].signalCode === null, true, `${mode} child must terminate`);
    }
  } finally {
    if (previousTestRunner === undefined) delete process.env.LARKIN_BUN_TEST_RUNNER;
    else process.env.LARKIN_BUN_TEST_RUNNER = previousTestRunner;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
