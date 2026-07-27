import { execFile as nodeExecFile } from "node:child_process";
import type { HostAgent } from "./host-business-state.js";

interface EyeAgent extends HostAgent { feishuProfile?: string | null }
interface Reaction { msgId: string; reactionId: string }
interface EyeState {
  sawActive: boolean;
  fallbackTimer: NodeJS.Timeout | null;
  completionTimer: NodeJS.Timeout | null;
  gen: number;
}
interface ApiResult { ok?: boolean; data?: { reaction_id?: string }; error?: unknown; [key: string]: unknown }
type ApiCallback = (error: Error | null, result: ApiResult | null) => void;
type ExecFile = typeof nodeExecFile;

export interface ProcessingEyeOptions {
  execFile?: ExecFile;
  log?: (...parts: unknown[]) => void;
  recordStatusError?: (agent: EyeAgent, text: string) => void;
  readPending?: (agent: EyeAgent) => Reaction[];
  writePending?: (agent: EyeAgent, items: readonly Reaction[]) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "?");
}

export class ProcessingEyeOrchestrator {
  private readonly pending = new Map<string, Reaction[]>();
  private readonly state = new Map<string, EyeState>();
  private readonly execFile: ExecFile;
  private readonly log: (...parts: unknown[]) => void;
  private readonly recordError: (agent: EyeAgent, text: string) => void;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(private readonly options: ProcessingEyeOptions = {}) {
    this.execFile = options.execFile ?? nodeExecFile;
    this.log = options.log ?? (() => {});
    this.recordError = options.recordStatusError ?? (() => {});
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  larkApi(agent: EyeAgent, method: string, apiPath: string, data: unknown, callback?: ApiCallback): void {
    const args = ["--profile", String(agent.feishuProfile || ""), "api", method, apiPath];
    if (data) args.push("--data", JSON.stringify(data));
    this.execFile("lark-cli", args, { encoding: "utf8", timeout: 10_000 }, (error, stdout, stderr) => {
      let result: ApiResult | null = null;
      try { result = JSON.parse(String(stdout)) as ApiResult; } catch { /* non-JSON */ }
      if (error && !result) {
        const killed = "killed" in error && Boolean(error.killed);
        // 不回显命令行：execFile 的 message 以整条命令开头，会占满 recentErrors 的 200 字符截断额度，
        // 把真正可诊断的 exit 码和 stderr 挤出去（2026-07-17 三次偶发失败均因此无法定位）。
        const code = (error as { code?: number | string }).code;
        const head = String(stderr || "").trim().slice(0, 160) || String(stdout || "").trim().slice(0, 120);
        const detail = (killed ? "超时(10s)被杀" : `exit=${code ?? "?"}`) + (head ? ` | ${head}` : "");
        const endpoint = apiPath.split("/").slice(-2).join("/");
        this.log(`larkApi ${method} ${endpoint} 失败 agent=${agent.name}: ${detail}`);
        this.recordError(agent, `larkApi ${method} ${endpoint}: ${detail}`);
      }
      callback?.(error, result);
    });
  }

  private save(agent: EyeAgent): void {
    try { this.options.writePending?.(agent, this.pending.get(agent.agentId) || []); }
    catch { /* best effort */ }
  }

  private getState(agent: EyeAgent): EyeState {
    const existing = this.state.get(agent.agentId);
    if (existing) return existing;
    const created = { sawActive: false, fallbackTimer: null, completionTimer: null, gen: 0 };
    this.state.set(agent.agentId, created);
    return created;
  }

  private cancelCompletion(state: EyeState): void {
    if (!state.completionTimer) return;
    this.clearTimer(state.completionTimer);
    state.completionTimer = null;
  }

  restoreAndClear(agent: EyeAgent): void {
    let leftovers: Reaction[] = [];
    try { leftovers = this.options.readPending?.(agent) || []; } catch { return; }
    if (!leftovers.length) return;
    this.pending.set(agent.agentId, leftovers);
    this.clear(agent, "启动清扫遗留");
  }

  add(agent: EyeAgent, msgId: string): void {
    if (!agent.feishuProfile || !msgId || !msgId.startsWith("om_")) {
      this.log(`👀 跳过 agent=${agent.name} msg=${msgId || "?"} profile=${agent.feishuProfile || "缺"}（不满足点表情条件）`);
      return;
    }
    this.log(`👀 点上尝试 agent=${agent.name} msg=${msgId}`);
    const state = this.getState(agent);
    state.gen += 1;
    // A successful delivery may emit turn-start before the Feishu POST is
    // attempted, and a new inbound message may arrive during idle grace. The
    // add itself therefore establishes an active generation instead of
    // erasing activity already observed for that turn.
    state.sawActive = true;
    this.cancelCompletion(state);
    if (state.fallbackTimer) this.clearTimer(state.fallbackTimer);
    const generation = state.gen;
    let fallbackTimer: NodeJS.Timeout;
    fallbackTimer = this.setTimer(() => {
      const current = this.state.get(agent.agentId);
      if (current?.gen !== generation || current.fallbackTimer !== fallbackTimer) return;
      this.clear(agent, "15分钟兜底");
    }, 15 * 60 * 1000);
    state.fallbackTimer = fallbackTimer;
    this.larkApi(agent, "POST", `/open-apis/im/v1/messages/${msgId}/reactions`, { reaction_type: { emoji_type: "OnIt" } }, (error, result) => {
      const reactionId = result?.data?.reaction_id;
      if (!reactionId) {
        this.log(`👀 点上失败 msg=${msgId}: ${result ? JSON.stringify(result.error || result).slice(0, 120) : errorMessage(error)}`);
        return;
      }
      if ((this.state.get(agent.agentId)?.gen ?? 0) !== generation) {
        this.log(`👀 迟到回执自删 agent=${agent.name} msg=${msgId}（点上生效前执行已结束）`);
        this.larkApi(agent, "DELETE", `/open-apis/im/v1/messages/${msgId}/reactions/${reactionId}`, null, () => {});
        return;
      }
      const list = this.pending.get(agent.agentId) || [];
      list.push({ msgId, reactionId });
      this.pending.set(agent.agentId, list);
      this.save(agent);
    });
  }

  clear(agent: EyeAgent, reason?: string): void {
    const state = this.state.get(agent.agentId);
    if (state) {
      state.gen += 1;
      state.sawActive = false;
      if (state.fallbackTimer) { this.clearTimer(state.fallbackTimer); state.fallbackTimer = null; }
      this.cancelCompletion(state);
    }
    const list = this.pending.get(agent.agentId) || [];
    if (!list.length) {
      this.log(`👀 清除(无待摘) agent=${agent.name} 原因=${reason || "?"}`);
      return;
    }
    this.pending.set(agent.agentId, []);
    this.save(agent);
    for (const { msgId, reactionId } of list) {
      this.larkApi(agent, "DELETE", `/open-apis/im/v1/messages/${msgId}/reactions/${reactionId}`, null, (error, result) => {
        if (error || result?.ok === false) {
          this.log(`👀 摘除失败 msg=${msgId}: ${result ? JSON.stringify(result.error || {}).slice(0, 120) : errorMessage(error)}`);
        }
      });
    }
    this.log(`👀 已摘 agent=${agent.name} n=${list.length} 原因=${reason || "?"}`);
  }

  observeActivity(agent: EyeAgent, activity: string | undefined): void {
    const state = this.getState(agent);
    if (activity === "error" || activity === "offline") {
      this.clear(agent, `activity:${activity}`);
      return;
    }
    if (activity === "idle") {
      if (!state.sawActive || state.completionTimer) return;
      const generation = state.gen;
      let completionTimer: NodeJS.Timeout;
      completionTimer = this.setTimer(() => {
        const current = this.state.get(agent.agentId);
        if (current?.gen !== generation || current.completionTimer !== completionTimer) return;
        this.clear(agent, "activity:idle(执行结束缓冲完成)");
      }, 1_000);
      state.completionTimer = completionTimer;
      return;
    }
    // Runtime adapters may add new intermediate activity types. Anything other
    // than an explicit terminal state means the turn is still active.
    state.sawActive = true;
    this.cancelCompletion(state);
  }
}
