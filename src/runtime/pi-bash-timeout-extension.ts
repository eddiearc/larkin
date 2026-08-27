import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BashToolInput } from "@earendil-works/pi-coding-agent";

/**
 * pi bash 工具超时护栏扩展。
 *
 * 由 Larkin 向 builtin Pi 传入 inline factory，或通过 external Pi 的
 * `pi --extension/-e <bundle>` 注入，覆盖内置 `bash` 工具：
 * - 无论模型是否传 `timeout`，都强制收窄到 <= MAX_BASH_SECONDS（默认 60s），
 *   避免单个 bash 调用无限期占住整个 agent 回合（issue #55）。
 * - 超时时 pi 会杀掉整个进程树（不残留卡死子进程，issue #56 的进程堆积），
 *   并在返回的错误里明确提示：长任务必须改用后台 subagent
 *   （Agent(run_in_background: true)，来自 pi-subagents 扩展）。
 *
 * 这是 pi 扩展，运行在 Pi RPC 子进程内部；build.mjs 仍为 external Pi
 * 单独产出注入 bundle。
 */

/** 前台 bash 的硬性上限（秒）。issue #55 建议默认 60s。 */
const MAX_BASH_SECONDS = 60;
/** Background Agent 子会话允许的显式 bash 上限（秒）。issue #161。 */
const MAX_SUBAGENT_BASH_SECONDS = 600;
const ROOT_SESSION_ENV = "LARKIN_PI_ROOT_SESSION_ID";

/** 解析生效超时：默认 60，允许用 LARKIN_PI_BASH_TIMEOUT_SECONDS 调低（用于快速 eval），硬上限 60。 */
function effectiveBashTimeout(): number {
  const raw = Number.parseInt(process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS || "", 10);
  if (Number.isInteger(raw) && raw > 0) return Math.min(raw, MAX_BASH_SECONDS);
  return MAX_BASH_SECONDS;
}

function effectiveSubagentBashTimeout(): number {
  const raw = Number.parseInt(process.env.LARKIN_PI_SUBAGENT_BASH_TIMEOUT_SECONDS || "", 10);
  if (Number.isInteger(raw) && raw > 0) return Math.min(raw, MAX_SUBAGENT_BASH_SECONDS);
  return MAX_SUBAGENT_BASH_SECONDS;
}

function rememberRootSession(ctx: { sessionManager?: { getSessionId?: () => string } } | undefined): void {
  if (process.env[ROOT_SESSION_ENV]) return;
  const id = ctx?.sessionManager?.getSessionId?.();
  if (typeof id === "string" && id) process.env[ROOT_SESSION_ENV] = id;
}

function isNestedSubagentSession(ctx: { sessionManager?: { getSessionId?: () => string } } | undefined): boolean {
  const root = process.env[ROOT_SESSION_ENV];
  const current = ctx?.sessionManager?.getSessionId?.();
  return Boolean(root && current && current !== root);
}

export default function (pi: ExtensionAPI): void {
  const cwd = process.cwd();
  // Built-in bash tool definition (keeps renderCall/renderResult/system-prompt metadata).
  const builtin = createBashToolDefinition(cwd);
  const MAX = effectiveBashTimeout();
  const SUBAGENT_MAX = effectiveSubagentBashTimeout();
  pi.on("session_start", (ctx) => rememberRootSession(ctx as { sessionManager?: { getSessionId?: () => string } }));

  const SUBAGENT_GUIDANCE =
    `This command exceeded the ${MAX}s foreground hard limit. ` +
    "Long-running or deploy-style work MUST run in a background subagent instead: " +
    "call Agent({ prompt, description, run_in_background: true }), report the returned agent id, and end the turn; " +
    "a completion notification arrives automatically. " +
    "Do NOT retry this command in the foreground, and do not use nohup / '&' / disown shell background jobs " +
    "(they bypass subagent isolation and die with this run).";
  const NESTED_GUIDANCE =
    `This command exceeded the ${SUBAGENT_MAX}s background-subagent bash limit. ` +
    "Pass an explicit bash timeout no greater than that bound. Do not use nohup / '&' / disown.";

  pi.registerTool({
    ...builtin,
    name: "bash",
    label: "bash",
    description: builtin.description,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const nested = isNestedSubagentSession(ctx as { sessionManager?: { getSessionId?: () => string } } | undefined);
      const cap = nested ? SUBAGENT_MAX : MAX;
      const requested = typeof params.timeout === "number" && params.timeout > 0 ? params.timeout : MAX;
      if (!nested && requested > MAX) {
        throw new Error(`timeout:${requested} exceeds the ${MAX}s foreground hard limit. ${SUBAGENT_GUIDANCE}`);
      }
      if (nested && requested > cap) {
        throw new Error(`timeout:${requested} exceeds the ${cap}s background-subagent bash limit. ${NESTED_GUIDANCE}`);
      }
      const timeout = nested ? Math.min(requested, cap) : Math.min(requested, MAX);
      const guidance = nested ? NESTED_GUIDANCE : SUBAGENT_GUIDANCE;
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
