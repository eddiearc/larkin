import { createHash } from "node:crypto";
import { agentCliPromptCapabilities } from "./agent-cli-capabilities.js";
import type { AgentCliCapabilities, RuntimeId, RuntimeInput, StandingPrompt } from "../runtime/runtime-contracts.js";

export const LARKIN_STANDING_PROMPT_VERSION = "larkin-standing-v3";

const FEISHU_IM_COMMAND_GROUPS = [
  ["Messages", ["im +messages-send", "im +messages-reply", "im +chat-messages-list", "im +messages-mget"]],
  ["Reactions", ["im reactions create", "im reactions delete"]],
  ["Chats", ["im +chat-list", "im +chat-search", "im chats get", "im +chat-create", "im +chat-update"]],
  ["Chat members", ["im chat.members get", "im chat.members create", "im chat.members delete"]],
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

  buildInboxNotice(input: { busy: boolean; count?: number; deliveryId?: string; executable?: string }): string {
    const notice = this.buildRuntimeInput(input.busy ? "inbox_update" : "wake", "notice", input).text;
    return input.executable?.trim()
      ? `${notice} First, before any IM send or reply, run this exact command without substituting a global larkin executable: ${input.executable.trim()} inbox check`
      : notice;
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
      input.agent.description ? `Identity context: ${clean(input.agent.description)}` : "",
      "",
      "## Message handling",
      "",
      "Larkin stores canonical incoming messages in the local Inbox. Runtime notifications may only report that the Inbox changed; they do not contain the authoritative message body.",
      `At a natural execution boundary, drain pending messages once with \`${command("inbox check")}\` before actions whose correctness depends on current conversation state.`,
      "Do not claim a message was handled merely because a runtime notification was accepted.",
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
      "Use the exact identity-locked lark-cli forms below. Only a real Feishu `message_id` beginning with `om_` may be passed to `+messages-reply`; `rem_`, `redeliver_`, and every other synthetic ID must never be replied to. Send with a confirmed `chat_id`. Never guess a chat id from a display name.",
      "For regular textual message bodies, default to `--markdown`, including brief single-line replies, so Feishu renders Markdown structure instead of showing its markers literally.",
      "Use native `--text` only when plain text or verbatim preservation is explicitly needed, such as logs, code, or exact whitespace. Both `--markdown` and `--text` remain supported in the Larkin Runtime.",
      "For multiline `--markdown` or `--text` content, put real newline characters directly in the argument. Do not use the two literal characters `\\n` inside ordinary quotes to represent layout line breaks.",
      ...FEISHU_IM_COMMAND_GROUPS.map(([label, suffixes]) => `- ${label}: ${suffixes.map((suffix) => `\`${command(suffix)}\``).join(", ")}.`),
      `- Attachments: for an attachment-only send/reply, use its attachment flag (\`--file\`, \`--image\`, \`--video\` with \`--video-cover\`, or \`--audio\`) without a text body flag; download with \`${command("im +messages-resources-download")}\`.`,
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

  buildRuntimeInput(kind: RuntimeInput["kind"], inputId: string, details: { count?: number; deliveryId?: string } = {}): RuntimeInput {
    const count = Number.isInteger(details.count) && Number(details.count) > 0 ? Number(details.count) : null;
    const text = kind === "initial"
      ? "Larkin Runtime Host is ready. Check the Inbox for the concrete wake message, then continue as this persistent agent."
      : kind === "resume"
        ? "The Larkin session resumed. Check the Inbox for any messages accumulated while the runtime was unavailable."
        : kind === "reminder"
          ? "A reminder became due. Check the Inbox at the next safe boundary for its canonical record."
          : `The Larkin Inbox changed${count ? ` (${count} pending wake ${count === 1 ? "message" : "messages"})` : ""}. Check it once at the next safe boundary.`;
    return { inputId, kind, text, attempt: 0, ...(details.deliveryId ? { deliveryId: details.deliveryId } : {}) };
  }
}
