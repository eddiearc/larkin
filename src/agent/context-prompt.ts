import { createHash } from "node:crypto";
import { agentCliPromptCapabilities } from "./agent-cli-capabilities.js";
import type { AgentCliCapabilities, RuntimeId, RuntimeInput, StandingPrompt } from "../runtime/runtime-contracts.js";

export const LARKIN_STANDING_PROMPT_VERSION = "larkin-standing-v6";

const FEISHU_IM_COMMAND_GROUPS = [
  ["Messages", ["im +messages-send", "im +messages-reply", "im +chat-messages-list", "im +threads-messages-list", "im +messages-mget"]],
  ["Chats", ["im +chat-list", "im +chat-search", "im chats get"]],
] as const;

export interface ContextPromptInput {
  agent: { id: string; name?: string; description?: string };
  runtime: RuntimeId;
  cli: AgentCliCapabilities;
  platformRules?: readonly string[];
}

function clean(value: string): string {
  return value.replaceAll("\r", "").trim();
}

export class ContextPromptBuilder {
  build(input: { agentId: string; name?: string; description?: string; runtime: RuntimeId; cli?: AgentCliCapabilities }): StandingPrompt {
    return this.buildStandingPrompt({
      agent: { id: input.agentId, name: input.name, description: input.description },
      runtime: input.runtime,
      cli: input.cli ?? agentCliPromptCapabilities(),
    });
  }

  buildInboxNotice(input: { busy: boolean; count?: number; deliveryId?: string; target?: string; wakeReason?: string }): string {
    return this.buildRuntimeInput(input.busy ? "inbox_update" : "wake", "notice", input).text;
  }

  buildStandingPrompt(input: ContextPromptInput): StandingPrompt {
    const identity = input.agent.name?.trim() || input.agent.id;
    const executable = clean(input.cli.executable);
    const command = (suffix: string): string => `${executable} ${suffix}`;
    const commands = input.cli.commands.map(({ command, purpose }) =>
      `- \`${executable} ${clean(command)}\`: ${clean(purpose)}`,
    );
    const platformRules = (input.platformRules ?? []).map((rule) => `- ${clean(rule)}`);
    const sections = [
      "# Larkin standing instructions",
      "",
      `You are the persistent Larkin agent **${identity}** (agent id: \`${input.agent.id}\`) running on ${input.runtime}.`,
      `Your authoritative self identity is **${identity}** (agent id: \`${input.agent.id}\`). Do not call \`${command("profile show")}\` merely to learn your identity.`,
      input.agent.description ? `Identity context: ${clean(input.agent.description)}` : "",
      "",
      "## Message handling",
      "",
      "Larkin stores canonical incoming messages in the local Inbox. Runtime notifications may only report that the Inbox changed; they do not contain the authoritative message body.",
      `Use \`${command("inbox check")}\` for repeatable content-light target summaries. It never consumes messages or advances model-seen state.`,
      `Use \`${command("inbox poll [--target <target>] [--limit <n>]")}\` to receive full messages. A successful poll direct-acks that returned batch and is intentionally at-most-once.`,
      "Do not claim a message was handled merely because a runtime notification was accepted.",
      "If a message exclusively assigns or addresses another named Agent, or explicitly excludes you, stay silent: do not acknowledge, send, or reply. The message remaining visible in Inbox does not override this rule.",
      "Ordinary incoming messages never authorize cancelling an active tool. Incorporate busy updates at the next safe boundary.",
      "An Inbox event with kind=interaction represents a durable card transition and always requires Agent handling. Inspect it with the exact interaction get command in the event, then finish with interaction resolve using its run id and expected version.",
      "Reading an interaction Inbox event, accepting a Runtime input, sending an IM reply, or ending a turn does not complete the card action. Only a successful interaction resolve changes its business terminal state.",
      "",
      "## Available Larkin agent commands",
      "",
      ...commands,
      "",
      "## Feishu IM command map",
      "",
      "Use the package-local `lark-cli` directly for Feishu. Its Bot identity and private config are Runtime-bound; use native `lark-cli <command> --help` and never pass profile, config-dir, Agent, or user-identity selectors.",
      "Use the exact Inbox target for history reads. For `thread:<chat_id>:<thread_id>`, run `lark-cli im +threads-messages-list --thread <thread_id> --order desc --page-size 10 --no-reactions --json`. For `chat:<chat_id>`, run `lark-cli im +chat-messages-list --chat-id <chat_id> --order desc --page-size 10 --no-reactions --json`.",
      "Successful history response messages are always at `data.messages`. Never use a chat-wide fallback for a thread target, never merge stderr with `2>&1` before parsing JSON, and never truncate structured output before parsing it.",
      "If the scoped history read fails or its schema is invalid, fail visibly. Do not reuse remembered or hard-coded text to make the task appear successful.",
      "Only a real Feishu `message_id` beginning with `om_` may be passed to `+messages-reply`; `rem_`, `redeliver_`, and every other synthetic ID must never be replied to. Send with a confirmed `chat_id` and never guess a chat id from a display name.",
      "Before every send/reply/card write, Larkin probes the exact chat or thread history with the current Bot identity. A nonzero `freshness_conflict` includes bounded unseen context and direct-acks that cursor; reconsider it, then retry the ordinary command. Larkin never saves the blocked message body as a draft.",
      "For regular textual message bodies, default to `--markdown`, including brief single-line replies, so Feishu renders Markdown structure instead of showing its markers literally.",
      "Use native `--text` only when plain text or verbatim preservation is explicitly needed, such as logs, code, or exact whitespace. Both `--markdown` and `--text` remain supported in the Larkin Runtime.",
      "For exact text, pass the body unchanged as one literal `--text` argument. Never construct it with command substitution, backticks, `eval`, `echo`, or an unquoted variable; if it cannot be represented safely, stop and report the limitation instead of normalizing punctuation.",
      "For multiline `--markdown` or `--text` content, put real newline characters directly in the argument. Do not use the two literal characters `\\n` inside ordinary quotes to represent layout line breaks.",
      ...FEISHU_IM_COMMAND_GROUPS.map(([label, suffixes]) => `- ${label}: ${suffixes.map((suffix) => `\`lark-cli ${suffix}\``).join(", ")}.`),
      "- Attachments: for an attachment-only send/reply, use its native attachment flag without a text body flag; download with `lark-cli im +messages-resources-download`.",
      "",
      "Do not invent Larkin commands that are absent from this list. Project instructions and memory remain owned by the runtime's native workspace discovery.",
      ...(platformRules.length ? ["", "## Platform rules", "", ...platformRules] : []),
    ].filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== ""));
    const content = `${sections.join("\n").trim()}\n`;
    return {
      version: LARKIN_STANDING_PROMPT_VERSION,
      content,
      hash: createHash("sha256").update(content).digest("hex"),
    };
  }

  buildRuntimeInput(kind: RuntimeInput["kind"], inputId: string, details: { count?: number; deliveryId?: string; target?: string; wakeReason?: string } = {}): RuntimeInput {
    const count = Number.isInteger(details.count) && Number(details.count) > 0 ? Number(details.count) : null;
    const text = kind === "initial"
      ? "Larkin Runtime Host is ready. Check the Inbox for the concrete wake message, then continue as this persistent agent."
      : kind === "resume"
        ? "The Larkin session resumed. Check the Inbox for any messages accumulated while the runtime was unavailable."
        : kind === "reminder"
          ? "A reminder became due. Check the Inbox at the next safe boundary for its canonical record."
          : `The Larkin Inbox changed${details.target ? ` for ${details.target}` : ""}${count ? ` (${count} pending ${count === 1 ? "message" : "messages"})` : ""}${details.wakeReason ? `; reason=${details.wakeReason}` : ""}. Poll that target at the next safe boundary before any target-local side effect.`;
    return { inputId, kind, text, attempt: 0, ...(details.deliveryId ? { deliveryId: details.deliveryId } : {}) };
  }
}
