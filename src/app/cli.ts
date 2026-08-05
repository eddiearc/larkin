#!/usr/bin/env bun
// Public larkin CLI router. This file deliberately owns only the outer shell:
// command selection, read-only help, child spawning, and signal/exit forwarding.

import "../platform/check-bun-version.cjs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_CLI_USAGE } from "../agent/config-cli-contract.js";
import { internalCommandSpec, type InternalMode } from "./internal-command.js";
import { packageVersion } from "../platform/build-info.js";

const command = process.argv[2] || "help";
let rest = process.argv.slice(3);
const PACKAGE_VERSION = packageVersion(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
const removedCommandMessages: Record<string, string> = {
  init: "首次配置或重新授权请使用 larkin setup。",
  "bot:connect": "首次配置或重新授权请使用 larkin setup。",
  build: "源码构建命令已移除；仓库维护者请使用 bun run build。",
  dashboard: "dashboard 已由 larkin start 自动启动和监控。",
};

if (removedCommandMessages[command]) {
  console.error(`larkin: ${command} 已移除；${removedCommandMessages[command]}`);
  process.exit(1);
}

type Route = readonly [mode: InternalMode, ...presetArguments: string[]];

const routes: Record<string, Route> = {
  start: ["run"],
  setup: ["setup"],
  status: ["agent-config", "agents"],
  agents: ["agent-config", "agents"],
  model: ["agent-config", "model"],
  runtime: ["agent-config", "runtime"],
  effort: ["agent-config", "effort"],
  chats: ["agent-config", "chats"],
  config: ["agent-config", "config"],
  session: ["session-cli"],
  "pi-auth": ["pi-auth"],
};
const runtimeAgentAuthority = typeof process.env.LARKIN_AGENT_ID === "string"
  && process.env.LARKIN_AGENT_ID.trim().length > 0;
const runtimeAgentCommand = runtimeAgentAuthority
  && ["inbox", "reminder", "interaction", "profile", "config"].includes(command);
if (runtimeAgentCommand) routes[command] = ["agent-cli", command];
if (runtimeAgentAuthority && command === "comment") routes.comment = ["lark-cli", "comment"];

// Help stays in the outer CLI so it never loads configuration, inspects a process,
// or starts a foreground service merely to print usage.
const commandHelp: Record<string, string> = {
  start: `Usage: larkin start [--agent <App ID> | --agents <App ID,...>]
Start one foreground supervisor for the daemon and local dashboard, or reuse it.`,
  setup: `Usage: larkin setup [--runtime <runtime>] [--no-start]
Run the interactive setup to create or connect a bot and configure its Agent.`,
  status: `Usage: larkin status [--json]
Show Agent configuration, bot identity, credentials, and connection status. Use --json for readiness automation.`,
  agents: `Usage: larkin agents [--json]
List every configured Agent and its current local status. Use --json for daemon/Runtime/channel readiness.`,
  model: `Usage: larkin model [<model>] [--agent <App ID>]
Show or change an Agent model.`,
  runtime: `Usage: larkin runtime [<runtime>] [--agent <App ID>] [--model <model>]
Show or change an Agent runtime.`,
  effort: `Usage: larkin effort [<level>|clear|default] [--agent <App ID>]
Show or change an Agent reasoning effort; clear/default restores the Runtime default.`,
  chats: `Usage: larkin chats [--agent <App ID>]
       larkin chats (free|strict) <oc_id> [--agent <App ID>]
List known chats or configure mention requirements.`,
  config: `Usage: ${CONFIG_CLI_USAGE.join("\n       ")}
Inspect and safely update user-facing Larkin configuration.

Values:
  default / clear  Do not persist a model override / clear effort to Runtime default
  inherit          Clear an Agent or chat mention override

Examples:
  larkin config show --agent cli_x --chat oc_x --json
  larkin config runtime pi --agent cli_x --model default
  larkin config mention chat oc_x free --agent cli_x

Credentials, internal paths, serverId, activeAgent, and raw config are never exposed here.`,
  session: `Usage: larkin session reset --agent <App ID> --json [--wait-ready <seconds>]
Atomically replace one idle, zero-backlog Agent Runtime session through authenticated local control.`,
  "pi-auth": `Usage: larkin pi-auth status [--agent <App ID>] [--json]
       larkin pi-auth logout <provider> [--agent <App ID>]
Show non-sensitive official Pi credential metadata or remove one target provider credential.`,
  comment: `Usage: larkin comment reply --message-id <doc_comment_message_id> --text '<reply>' --json
Reply once, as the Runtime-bound Bot, to the exact cloud-document comment locator supplied by canonical Inbox.`,
};

if (command === "--version" || command === "-V") {
  console.log(`larkin ${PACKAGE_VERSION}`);
  process.exit(0);
}

if (command === "help" && rest[0] && commandHelp[rest[0]]) {
  console.log(commandHelp[rest[0]]);
  process.exit(0);
}

if (!runtimeAgentCommand && routes[command] && rest.some((argument) => argument === "--help" || argument === "-h")) {
  console.log(commandHelp[command]);
  process.exit(0);
}

if (!runtimeAgentCommand && command === "config" && ["runtime", "model", "effort"].includes(rest[0] || "")) {
  routes.config = ["agent-config", rest[0]];
  rest = rest.slice(1);
}

// At a user terminal, unregistered non-flag commands keep the legacy lark-cli passthrough.
// Inside an Agent Runtime, unknown Feishu command groups enter the same Larkin-owned
// identity and freshness AOP before delegation to the verified global official CLI.
const wantsHelp = command === "help" || command === "--help" || command === "-h"
  || (!runtimeAgentAuthority && command.startsWith("-"));
if (!routes[command] && !wantsHelp) {
  routes[command] = runtimeAgentAuthority ? ["lark-cli", command] : ["lark", command];
}

if (!routes[command]) {
  console.log(`larkin — Run persistent-personality agents on Feishu

Usage: larkin <command>
  setup            Create or connect a bot, configure its Agent, start it, and open the dashboard
  start            Start and supervise configured Agents plus the local dashboard
  status           Show Agent configuration, bot identity, credentials, and connection status
  agents           List all Agents, including runtime, model, bot identity, and credential status
  model [<id>]     Show or change an Agent model, with workspace validation
  runtime [<id>]   Show or change an Agent runtime; changing it resets the model to its default
  effort [<level>] Show or set the reasoning effort; use clear to restore the default
  chats            List known chats; use free/strict <oc_id> to configure mention requirements
  config           Inspect effective config/source, edit mention inheritance, or explicitly apply runtime changes
  session reset    Replace one idle, zero-backlog Agent Runtime session for a fresh scenario
  pi-auth          Show non-sensitive built-in Pi auth status or logout one provider
  comment reply    Reply to the exact cloud-document comment bound by a polled Inbox message
  <lark-cli 命令组>  im/docs/wiki/drive 等 lark-cli 命令原样转发，机器人身份已锁定（如 larkin im +chat-list）
Getting started:
  First-time setup: larkin setup
  Daily startup:    larkin start
  Health check:     larkin status

Process persistence is managed externally. larkin start stays in the foreground and supervises the daemon and dashboard.`);
  process.exit(command === "help" || command === "--help" || command === "-h" ? 0 : 1);
}

const [mode, ...presetArguments] = routes[command];
const childSpec = internalCommandSpec(mode, [...presetArguments, ...rest]);
const child = spawn(childSpec.command, childSpec.args, { stdio: "inherit" });

// Package-manager bin shims add a wrapper process. Forward terminal signals so the actual command
// does not become an orphan that keeps the machine lock or Feishu connection.
const signalForwarders = new Map<NodeJS.Signals, () => void>();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const forward = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  signalForwarders.set(signal, forward);
  process.on(signal, forward);
}
const stopForwardingSignals = () => {
  for (const [signal, forward] of signalForwarders) process.off(signal, forward);
};
child.on("error", (error) => {
  stopForwardingSignals();
  console.error(`larkin ${command} 启动失败: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  stopForwardingSignals();
  if (code !== null) process.exit(code);
  if (!signal) process.exit(1);
  const fallback = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : signal === "SIGKILL" ? 137 : 1;
  try { process.kill(process.pid, signal); } catch { process.exit(fallback); }
  setImmediate(() => process.exit(fallback));
});
