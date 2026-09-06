import { RUNTIME_REMINDER_TARGET } from "./inbox-projection.js";

export const INBOX_AUDIT_CADENCE_MS = 15 * 60_000;

interface AuditAgent { agentId: string }
interface AuditStateStore {
  appendCanonicalInboxOnce(value: unknown): { status: "appended" | "duplicate_pending" | "duplicate_consumed"; envelope: unknown };
}
interface AuditRuntime { deliver(agentId: string, envelope: object): Promise<unknown> | unknown }
export interface InboxAuditSchedule { enabled: boolean; intervalMs: number }
type Timer = ReturnType<typeof setTimeout>;

function safeIntervalMs(intervalMs: number): number {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("inbox audit cadence must be a positive integer");
  return intervalMs;
}

/** One Host-owned timer per Agent; disabled Agents are re-armed without a model wake. */
export class InboxAuditHeartbeat {
  private readonly timers = new Map<string, Timer>();
  private running = false;
  private sequence = 0;

  constructor(private readonly options: {
    agents: readonly AuditAgent[];
    stateStore(agent: AuditAgent): AuditStateStore;
    runtimeHost: AuditRuntime;
    log?: (...parts: unknown[]) => void;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    now?: () => number;
    schedule(agent: AuditAgent): InboxAuditSchedule;
    /** Skip model wake when audit is disabled or there is no pending originally-wake=true work. */
    shouldDispatch(agent: AuditAgent): boolean;
  }) {
    for (const agent of options.agents) safeIntervalMs(options.schedule(agent).intervalMs);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const agent of this.options.agents) this.arm(agent);
  }

  stop(): void {
    this.running = false;
    const clearTimer = this.options.clearTimer ?? clearTimeout;
    for (const timer of this.timers.values()) clearTimer(timer);
    this.timers.clear();
  }

  private arm(agent: AuditAgent): void {
    if (!this.running || this.timers.has(agent.agentId)) return;
    let intervalMs = INBOX_AUDIT_CADENCE_MS;
    try { intervalMs = safeIntervalMs(this.options.schedule(agent).intervalMs); }
    catch (error) {
      this.options.log?.(`inbox audit schedule failed agent=${agent.agentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const timer = (this.options.setTimer ?? setTimeout)(() => {
      this.timers.delete(agent.agentId);
      return this.fire(agent).finally(() => { if (this.running) this.arm(agent); });
    }, intervalMs);
    timer.unref?.();
    this.timers.set(agent.agentId, timer);
  }

  private async fire(agent: AuditAgent): Promise<void> {
    try {
      const schedule = this.options.schedule(agent);
      if (!schedule.enabled || !this.options.shouldDispatch(agent)) return;
    } catch (error) {
      this.options.log?.(`inbox audit schedule failed agent=${agent.agentId}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const now = this.options.now ?? Date.now;
    const message_id = `rem_inbox_audit_${now()}_${++this.sequence}_${agent.agentId}`;
    const envelope = {
      kind: "reminder",
      message_id,
      target: RUNTIME_REMINDER_TARGET,
      wake: true,
      content: "Internal inbox audit wake. Poll runtime:reminder, then run larkin inbox audit --json. No finding stays silent.",
    };
    try {
      const appended = this.options.stateStore(agent).appendCanonicalInboxOnce(envelope);
      if (appended.status === "appended") await this.options.runtimeHost.deliver(agent.agentId, appended.envelope as object);
    } catch (error) {
      this.options.log?.(`inbox audit heartbeat failed agent=${agent.agentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
