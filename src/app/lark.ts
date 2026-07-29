#!/usr/bin/env bun
// larkin 顶级 lark-cli 直通入口：锁定当前 Agent 的 lark-channel workspace 后原样转发。

import { spawn } from "node:child_process";
import * as larkinConfig from "../platform/config.js";
import { assessPassthrough, PASSTHROUGH_USAGE } from "../feishu/lark-passthrough.js";
import { managedOfficialLarkCli } from "./agent-lark-cli-workspace.js";

const decision = assessPassthrough(process.argv.slice(2), process.env);
if (!decision.ok) {
  console.error(`larkin: ${decision.reason}`);
  process.exit(2);
}

let cliEnv: NodeJS.ProcessEnv;
let cliCommand: string;
let cliPrefix: string[];
try {
  const { config } = larkinConfig.loadConfig(process.env);
  const agent = larkinConfig.selectAgent(
    config,
    decision.explicitAgent ? { LARKIN_AGENT_ID: decision.explicitAgent } : process.env,
  );
  const managed = managedOfficialLarkCli(agent, process.env);
  cliEnv = managed.env;
  cliCommand = managed.command.command;
  cliPrefix = managed.command.argsPrefix;
} catch (error) {
  console.error(`larkin: ${(error as Error).message}`);
  process.exit(1);
}

const child = spawn(cliCommand!, [...cliPrefix!, ...decision.argv!], {
  stdio: "inherit",
  env: cliEnv,
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
