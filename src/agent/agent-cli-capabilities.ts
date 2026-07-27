import type { AgentCliCapabilities } from "../runtime/runtime-contracts.js";
import process from "node:process";
import { CONFIG_CLI_OPERATIONS } from "./config-cli-contract.js";
import { INTERNAL_AGENT_CLI, internalCommandShell } from "../app/internal-command.js";

export const AGENT_CLI_CAPABILITIES = Object.freeze({
  version: 1,
  commands: Object.freeze({
    inbox: Object.freeze(["check"]),
    reminder: Object.freeze(["schedule", "list", "snooze", "update", "cancel", "log"]),
    interaction: Object.freeze(["callback-status", "callback-probe", "create", "get", "resolve"]),
    profile: Object.freeze(["show"]),
    config: CONFIG_CLI_OPERATIONS,
    im: Object.freeze(["passthrough"]),
  }),
});

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function resolveAgentCliExecutable(
  cliPath = process.env.LARKIN_COMPUTER_CLI_PATH,
  runtimeExecutable = process.execPath,
): string {
  if (cliPath === INTERNAL_AGENT_CLI) return internalCommandShell("agent-cli");
  return cliPath ? `${posixQuote(runtimeExecutable)} ${posixQuote(cliPath)}` : "larkin";
}

export function agentCliPromptCapabilities(executable = "larkin"): AgentCliCapabilities {
  const commands = Object.entries(AGENT_CLI_CAPABILITIES.commands).flatMap(([group, operations]) =>
    operations.map((operation) => ({
      command: group === "im" ? "im <lark-cli im arguments>" : `${group} ${operation}`,
      purpose: group === "inbox" ? "Drain the canonical Inbox once." :
        group === "reminder" ? "Manage this Agent's durable reminders." :
          group === "interaction" ? "Create, inspect, or resolve a durable interactive card run." :
          group === "profile" ? "Show this Agent's locked identity." :
            group === "config" ? "Read or update safe Larkin configuration, including explicit global/cross-Agent targets and runtime apply; credentials and Feishu identity stay locked." :
              "Use the locked bot identity for Feishu IM operations.",
    })),
  );
  return { executable, commands: commands as AgentCliCapabilities["commands"] };
}
