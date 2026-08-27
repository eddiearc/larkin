import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BashToolInput } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { getSubagentBashWaitSeconds } from "./pi-subagent-bash-wait.js";

/**
 * pi bash 工具超时护栏扩展。
 *
 * 由 Larkin 向 builtin Pi 传入 inline factory，或通过 external Pi 的
 * `pi --extension/-e <bundle>` 注入，覆盖内置 `bash` 工具：
 * - 父会话无论模型是否传 `timeout`，都强制收窄到 <= MAX_BASH_SECONDS（默认 60s）。
 * - 仅当 Agent(run_in_background: true) 显式传入 max_command_wait_seconds (61..600)
 *   时，对应子会话的 bash 才允许该上限（issue #161）。子会话通过 loader 加载本扩展。
 * - 超时时 pi 会杀掉整个进程树，并禁止 nohup/`&`/disown。
 */

const MAX_BASH_SECONDS = 60;
const LARKIN_BASH_TIMEOUT_PATH = Symbol.for("larkin-pi-bash-timeout-extension-path");

function effectiveBashTimeout(): number {
  const raw = Number.parseInt(process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS || "", 10);
  if (Number.isInteger(raw) && raw > 0) return Math.min(raw, MAX_BASH_SECONDS);
  return MAX_BASH_SECONDS;
}

function rememberExtensionPath(): void {
  try {
    const here = fileURLToPath(import.meta.url);
    (globalThis as Record<symbol, string>)[LARKIN_BASH_TIMEOUT_PATH] = here;
  } catch {
    /* ignore */
  }
}

export default function (pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const builtin = createBashToolDefinition(cwd);
  const MAX = effectiveBashTimeout();
  rememberExtensionPath();

  const PARENT_GUIDANCE =
    `This command exceeded the ${MAX}s foreground hard limit. ` +
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
      const authorized = getSubagentBashWaitSeconds((ctx as { sessionManager?: object } | undefined)?.sessionManager);
      const cap = typeof authorized === "number" ? authorized : MAX;
      const requested = typeof params.timeout === "number" && params.timeout > 0 ? params.timeout : MAX;
      if (requested > cap) {
        const guidance = typeof authorized === "number"
          ? `This command exceeded the ${cap}s authorized background-subagent bash limit. Pass timeout <= ${cap}. Do not use nohup / '&' / disown.`
          : PARENT_GUIDANCE;
        throw new Error(`timeout:${requested} exceeds the ${cap}s ${typeof authorized === "number" ? "background-subagent bash" : "foreground hard"} limit. ${guidance}`);
      }
      const timeout = Math.min(requested, cap);
      try {
        return await builtin.execute(toolCallId, { ...params, timeout } satisfies BashToolInput, signal, onUpdate, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timed out after/i.test(message)) {
          throw new Error(`${message}\n\n${typeof authorized === "number" ? `Authorized background-subagent bash limit is ${cap}s.` : PARENT_GUIDANCE}`);
        }
        throw error;
      }
    },
  });
}
