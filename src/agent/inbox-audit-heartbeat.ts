import * as fs from "node:fs";
import * as path from "node:path";
import { RUNTIME_REMINDER_TARGET } from "./inbox-projection.js";

export const INBOX_AUDIT_CADENCE_MS = 15 * 60_000;
export const MAX_INBOX_AUDIT_DIAGNOSTIC_CHARS = 120;

export function boundedInboxAuditDiagnostic(error: unknown): string {
  const max = MAX_INBOX_AUDIT_DIAGNOSTIC_CHARS;
  const code = error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code.slice(0, max) : "";
  const raw = error instanceof Error ? error.message : String(error);
  const text = String(raw).slice(0, max).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return [code, text].filter(Boolean).join(" ").slice(0, max);
}

interface AuditAgent { agentId: string }
interface AuditStateStore { appendCanonicalInboxOnce(value: unknown): { status: "appended" | "duplicate_pending" | "duplicate_consumed"; envelope: unknown } }
interface AuditRuntime { deliver(agentId: string, envelope: object): Promise<unknown> | unknown }
export interface InboxAuditSchedule { enabled: boolean; intervalMs: number }
type Timer = ReturnType<typeof setTimeout>;

function safeIntervalMs(intervalMs: number): number {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("inbox audit cadence must be a positive integer");
  return intervalMs;
}

/** A Host-owned, config-file-reactive single timer per enabled Agent. */
export class InboxAuditHeartbeat {
  private readonly timers = new Map<string, Timer>();
  private readonly generations = new Map<string, number>();
  private running = false;
  private sequence = 0;
  private watcher: fs.FSWatcher | null = null;
  private refreshTimer: Timer | null = null;

  constructor(private readonly options: {
    agents: readonly AuditAgent[];
    stateStore(agent: AuditAgent): AuditStateStore;
    runtimeHost: AuditRuntime;
    log?: (...parts: unknown[]) => void;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    now?: () => number;
    schedule(agent: AuditAgent): InboxAuditSchedule;
    shouldDispatch(agent: AuditAgent): boolean;
    /** Config saves are observed without replacing Runtime sessions. */
    configFile?: string;
    watch?: typeof fs.watch;
  }) {
    for (const agent of options.agents) safeIntervalMs(options.schedule(agent).intervalMs);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const agent of this.options.agents) this.reschedule(agent);
    this.watchConfig();
  }

  stop(): void {
    this.running = false;
    const clearTimer = this.options.clearTimer ?? clearTimeout;
    for (const timer of this.timers.values()) clearTimer(timer);
    this.timers.clear();
    if (this.refreshTimer) clearTimer(this.refreshTimer);
    this.refreshTimer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  /** Safe for a Host config watcher or a direct in-process config mutation hook. */
  refresh(): void {
    if (!this.running) return;
    for (const agent of this.options.agents) this.reschedule(agent);
  }

  private watchConfig(): void {
    if (!this.options.configFile || this.watcher) return;
    const file = path.resolve(this.options.configFile);
    const parent = path.dirname(file);
    const basename = path.basename(file);
    try {
      this.watcher = (this.options.watch ?? fs.watch)(parent, (_event, changed) => {
        if (changed && String(changed) !== basename) return;
        this.scheduleRefresh();
      });
    } catch (error) { this.options.log?.(`inbox audit config watch failed: ${boundedInboxAuditDiagnostic(error)}`); }
  }

  private scheduleRefresh(): void {
    if (!this.running || this.refreshTimer) return;
    this.refreshTimer = (this.options.setTimer ?? setTimeout)(() => {
      this.refreshTimer = null;
      this.refresh();
    }, 30);
    this.refreshTimer.unref?.();
  }

  private reschedule(agent: AuditAgent): void {
    const clearTimer = this.options.clearTimer ?? clearTimeout;
    const prior = this.timers.get(agent.agentId);
    if (prior) clearTimer(prior);
    this.timers.delete(agent.agentId);
    const generation = (this.generations.get(agent.agentId) ?? 0) + 1;
    this.generations.set(agent.agentId, generation);
    let schedule: InboxAuditSchedule;
    try { schedule = this.options.schedule(agent); safeIntervalMs(schedule.intervalMs); }
    catch (error) { this.options.log?.(`inbox audit schedule failed agent=${agent.agentId}: ${boundedInboxAuditDiagnostic(error)}`); return; }
    // Disabled means no future audit timer or model wake at all.
    if (!schedule.enabled || !this.running) return;
    let timer!: Timer;
    timer = (this.options.setTimer ?? setTimeout)(() => {
      // A cancelled callback can still be queued. It must not remove the
      // replacement timer installed by a newer config revision.
      if (this.timers.get(agent.agentId) === timer) this.timers.delete(agent.agentId);
      void this.fire(agent, generation).finally(() => {
        if (this.running && this.generations.get(agent.agentId) === generation) this.reschedule(agent);
      });
    }, schedule.intervalMs);
    timer.unref?.();
    this.timers.set(agent.agentId, timer);
  }

  private async fire(agent: AuditAgent, generation: number): Promise<void> {
    if (this.generations.get(agent.agentId) !== generation) return;
    try {
      const schedule = this.options.schedule(agent);
      if (!schedule.enabled || !this.options.shouldDispatch(agent)) return;
    } catch (error) {
      this.options.log?.(`inbox audit schedule failed agent=${agent.agentId}: ${boundedInboxAuditDiagnostic(error)}`);
      return;
    }
    const now = this.options.now ?? Date.now;
    const message_id = `rem_inbox_audit_${now()}_${++this.sequence}_${agent.agentId}`;
    const envelope = { kind: "reminder", message_id, target: RUNTIME_REMINDER_TARGET, wake: true,
      content: "Inbox audit is due. Poll runtime:reminder, run larkin inbox audit --json, and follow its steps and each target's numbered instruction through its receipt." };
    try {
      const appended = this.options.stateStore(agent).appendCanonicalInboxOnce(envelope);
      if (appended.status === "appended") await this.options.runtimeHost.deliver(agent.agentId, appended.envelope as object);
    } catch (error) { this.options.log?.(`inbox audit heartbeat failed agent=${agent.agentId}: ${boundedInboxAuditDiagnostic(error)}`); }
  }
}
