import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BashToolInput } from "@earendil-works/pi-coding-agent";

/**
 * pi bash 工具超时护栏扩展。
 *
 * 父会话强制 <= MAX_BASH_SECONDS（默认 60s）。授权 nested wait 不走全局
 * WeakMap：child session 由 pi-subagents runAgent 把带闭包 cap 的 bash
 * execute 直接装到该 session 的 bash tool 上。
 */

const MAX_BASH_SECONDS = 60;

export function effectiveParentBashTimeout(): number {
  const raw = Number.parseInt(process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS || "", 10);
  if (Number.isInteger(raw) && raw > 0) return Math.min(raw, MAX_BASH_SECONDS);
  return MAX_BASH_SECONDS;
}

export function commandUsesDetachedShell(command: string): boolean {
  if (/\bnohup\b/.test(command) || /\bdisown\b/.test(command)) return true;
  const stripped = command.replace(/&&/g, " ");
  return /(?:^|[\s;|&])&(?:[\s;]|$)/.test(stripped) || /(?:^|[\s;])[^>&\n]*&\s*$/.test(stripped);
}

export function installGuardedBashTool(pi: ExtensionAPI, cap: number): void {
  const cwd = process.cwd();
  const builtin = createBashToolDefinition(cwd);
  const MAX = cap;
  const authorized = MAX > effectiveParentBashTimeout();
  const guidance = authorized
    ? `This command exceeded the ${MAX}s authorized background-subagent bash limit. Pass timeout <= ${MAX}. Do not use nohup / '&' / disown.`
    : `This command exceeded the ${MAX}s foreground hard limit. ` +
      "Long-running or deploy-style work MUST run in a background subagent instead: " +
      "call Agent({ prompt, description, run_in_background: true, max_command_wait_seconds: <61-600> }), " +
      "report the returned agent id, and end the turn; a completion notification arrives automatically. " +
      "Do NOT retry this command in the foreground, and do not use nohup / '&' / disown shell background jobs " +
      "(they bypass subagent isolation and die with this run).";

  pi.registerTool({
    ...builtin,
    name: "bash",
    label: "bash",
    description: builtin.description,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const command = typeof params.command === "string" ? params.command : "";
      if (commandUsesDetachedShell(command)) {
        throw new Error("detached shell process is not allowed (nohup, '&', disown). Use a background Agent with max_command_wait_seconds instead.");
      }
      const requested = typeof params.timeout === "number" && params.timeout > 0 ? params.timeout : effectiveParentBashTimeout();
      if (requested > MAX) {
        throw new Error(`timeout:${requested} exceeds the ${MAX}s ${authorized ? "background-subagent bash" : "foreground hard"} limit. ${guidance}`);
      }
      const timeout = Math.min(requested, MAX);
      try {
        return await builtin.execute(toolCallId, { ...params, timeout } satisfies BashToolInput, signal, onUpdate, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timed out after/i.test(message)) {
          throw new Error(`${message}\n\n${guidance}`);
        }
        throw error;
      }
    },
  });
}

export default function (pi: ExtensionAPI): void {
  installGuardedBashTool(pi, effectiveParentBashTimeout());
}
