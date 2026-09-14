import crypto from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createLarkinTmux,
  DEFAULT_BASH_WAIT_SECONDS,
  ForeignTmuxTaskError,
  formatTmuxTaskText,
  LARKIN_TMUX_COMPLETION_TYPE,
  tmuxAvailable,
  tmuxSessionName,
  tmuxSocketName,
  type TmuxTaskSnapshot,
} from "./pi-tmux.js";

function resultOf(snapshot: TmuxTaskSnapshot, attachHint: string | null = null) {
  return {
    content: [{ type: "text" as const, text: formatTmuxTaskText(snapshot, { attachHint }) }],
    details: {
      taskId: snapshot.taskId,
      status: snapshot.status,
      exitCode: snapshot.exitCode,
      output: snapshot.output,
    },
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { taskId: "", status: "failed" as const, exitCode: null, output: message },
  };
}

export function registerLarkinTmuxExtension(pi: ExtensionAPI): boolean {
  if (!tmuxAvailable()) return false;

  const stateDir = process.env.LARKIN_STATE_DIR || `${process.cwd()}/.larkin`;
  const agentId = process.env.LARKIN_AGENT_ID || "agent";
  const instanceId = process.env.LARKIN_TMUX_INSTANCE_ID
    || process.env.LARKIN_RUNTIME_OBSERVATION_GENERATION
    || crypto.randomUUID();
  // 可选独立 socket：设置 LARKIN_TMUX_SOCKET 后所有 tmux 调用走 `-L <name>`，任务会话与
  // 用户默认 server 完全隔离（不推进其编号、不受 kill-server 波及）；未设置时行为不变。
  // 开启时在 agent 可见文本里给出 attach 提示，观察性不打折。
  const tmuxSocket = tmuxSocketName(process.env);
  const attachHintFor = (snapshot: TmuxTaskSnapshot): string | null => tmuxSocket && snapshot.status === "running"
    ? `tmux -L ${tmuxSocket} attach -t =${tmuxSessionName(agentId, instanceId, snapshot.taskId)}`
    : null;
  const tmux = createLarkinTmux({ stateDir, agentId, instanceId, env: process.env });
  const watchers = new Map<string, ReturnType<typeof setInterval>>();
  const notified = new Set<string>();

  const stopWatchers = (): void => {
    for (const timer of watchers.values()) clearInterval(timer);
    watchers.clear();
  };

  const notifyOnce = (snapshot: TmuxTaskSnapshot): void => {
    if (snapshot.status === "running" || notified.has(snapshot.taskId)) return;
    notified.add(snapshot.taskId);
    pi.sendMessage({
      customType: LARKIN_TMUX_COMPLETION_TYPE,
      content: formatTmuxTaskText(snapshot, { attachHint: attachHintFor(snapshot) }),
      display: true,
      details: {
        taskId: snapshot.taskId,
        exitCode: snapshot.exitCode,
        output: snapshot.output,
      },
    }, { triggerTurn: true, deliverAs: "followUp" });
  };

  const watch = (taskId: string): void => {
    if (watchers.has(taskId) || notified.has(taskId)) return;
    const timer = setInterval(() => {
      try {
        const snapshot = tmux.peek(taskId);
        if (snapshot.status === "running") return;
        clearInterval(timer);
        watchers.delete(taskId);
        notifyOnce(snapshot);
      } catch {
        clearInterval(timer);
        watchers.delete(taskId);
      }
    }, 250);
    watchers.set(taskId, timer);
  };

  pi.on("session_shutdown", () => {
    stopWatchers();
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: "Run a command in a detached tmux window. timeout is a wait window only and never hard-kills. background:true returns immediately.",
    parameters: Type.Object({
      command: Type.String(),
      timeout: Type.Optional(Type.Number()),
      background: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const snapshot = tmux.start(params.command, ctx.cwd);
      if (params.background === true) {
        watch(snapshot.taskId);
        const current = tmux.peek(snapshot.taskId);
        return resultOf(current, attachHintFor(current));
      }
      const timeout = typeof params.timeout === "number" && params.timeout >= 0 ? params.timeout : DEFAULT_BASH_WAIT_SECONDS;
      const waited = await tmux.wait(snapshot.taskId, timeout, signal);
      if (waited.status === "running") watch(waited.taskId);
      return resultOf(waited, attachHintFor(waited));
    },
  });

  pi.registerTool({
    name: "tmux",
    label: "tmux",
    description: "List, peek, or kill Larkin-owned tmux tasks for this Agent. Foreign task IDs are rejected.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("peek"), Type.Literal("kill")]),
      taskId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      try {
        if (params.action === "list") {
          const tasks = tmux.list();
          return {
            content: [{ type: "text" as const, text: tasks.map((task) => formatTmuxTaskText(task)).join("\n---\n") || "no owned tmux tasks" }],
            details: { taskId: "", status: "completed" as const, exitCode: 0, output: "" },
          };
        }
        if (!params.taskId) return errorResult("taskId is required for peek and kill");
        if (params.action === "peek") {
          const snapped = tmux.peek(params.taskId);
          return resultOf(snapped, attachHintFor(snapped));
        }
        const killed = tmux.kill(params.taskId);
        notified.add(params.taskId);
        const timer = watchers.get(params.taskId);
        if (timer) {
          clearInterval(timer);
          watchers.delete(params.taskId);
        }
        return resultOf(killed, attachHintFor(killed));
      } catch (error) {
        if (error instanceof ForeignTmuxTaskError) return errorResult(error.message);
        throw error;
      }
    },
  });
  return true;
}

export default function larkinTmuxExtension(pi: ExtensionAPI): void {
  registerLarkinTmuxExtension(pi);
}
