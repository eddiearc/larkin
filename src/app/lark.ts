#!/usr/bin/env bun
// larkin 顶级 lark-cli 直通入口：身份锁定（本 agent 的 lark-cli 配置目录 + bot profile）后原样转发。

import { spawn } from "node:child_process";
import * as larkinConfig from "../platform/config.js";
import { assessPassthrough, PASSTHROUGH_USAGE } from "../feishu/lark-passthrough.js";

const decision = assessPassthrough(process.argv.slice(2), process.env);
if (!decision.ok) {
  console.error(`larkin: ${decision.reason}`);
  process.exit(2);
}

let profile: string;
let larkConfigDir: string;
try {
  const { config } = larkinConfig.loadConfig(process.env);
  const agent = larkinConfig.selectAgent(
    config,
    decision.explicitAgent ? { LARKIN_AGENT_ID: decision.explicitAgent } : process.env,
  );
  profile = agent.feishuProfile;
  larkConfigDir = agent.larkConfigDir;
} catch (error) {
  console.error(`larkin: ${(error as Error).message}`);
  process.exit(1);
}

const child = spawn("lark-cli", ["--profile", profile, ...decision.argv!], {
  stdio: "inherit",
  env: { ...process.env, LARKSUITE_CLI_CONFIG_DIR: larkConfigDir },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
child.on("error", (error) => {
  console.error(`larkin: lark-cli 启动失败：${error.message}。${PASSTHROUGH_USAGE}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (code !== null) process.exit(code);
  process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
