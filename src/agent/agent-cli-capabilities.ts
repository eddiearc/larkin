import type { AgentCliCapabilities } from "../runtime/runtime-contracts.js";
import process from "node:process";
import { CONFIG_CLI_OPERATIONS } from "./config-cli-contract.js";
import { INTERNAL_AGENT_CLI, internalCommandShell } from "../app/internal-command.js";

export const AGENT_CLI_CAPABILITIES = Object.freeze({
  version: 1,
  commands: Object.freeze({
    inbox: Object.freeze(["check", "poll"]),
    comment: Object.freeze(["reply"]),
    reminder: Object.freeze(["schedule", "list", "snooze", "update", "cancel", "log"]),
    interaction: Object.freeze(["callback-status", "callback-probe", "create", "get", "resolve"]),
    profile: Object.freeze(["show"]),
    config: CONFIG_CLI_OPERATIONS,
  }),
});

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function resolveAgentCliExecutable(
  cliPath?: string,
  runtimeExecutable = process.execPath,
): string {
  if (cliPath === INTERNAL_AGENT_CLI) return internalCommandShell("agent-cli");
  return cliPath ? `${posixQuote(runtimeExecutable)} ${posixQuote(cliPath)}` : "larkin";
}

export function agentCliPromptCapabilities(executable = "larkin"): AgentCliCapabilities {
  const commands = Object.entries(AGENT_CLI_CAPABILITIES.commands).flatMap(([group, operations]) =>
    operations.map((operation) => ({
      command: `${group} ${operation}`,
      purpose: group === "inbox" ? (operation === "check" ? "Read pending target summaries without consuming messages." : "Poll full messages and direct-ack the returned batch.") :
        group === "comment" ? "Reply once to the exact cloud-document comment bound by a polled Inbox message id." :
        group === "reminder" ? "Manage this Agent's durable reminders." :
          group === "interaction" ? "Create, inspect, or resolve a durable interactive card run." :
          group === "profile" ? "Show this Agent's locked identity." :
            group === "config" ? "Read or update safe Larkin configuration; credentials and Feishu identity stay locked." :
              "Use this Larkin-owned command.",
    })),
  );
  return { executable, commands: commands as AgentCliCapabilities["commands"] };
}
