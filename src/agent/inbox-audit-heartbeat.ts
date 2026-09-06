import { RUNTIME_REMINDER_TARGET } from "./inbox-projection.js";

export const INBOX_AUDIT_CADENCE_MS = 15 * 60_000;
export const MAX_INBOX_AUDIT_DIAGNOSTIC_CHARS = 120;

export function boundedInboxAuditDiagnostic(error: unknown): string {
  const max = MAX_INBOX_AUDIT_DIAGNOSTIC_CHARS;
  const code = error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code.slice(0, max)
    : "";
  const raw = error instanceof Error ? error.message : String(error);
  const text = String(raw).slice(0, max).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return [code, text].filter(Boolean).join(" ").slice(0, max);
}

interface AuditAgent { agentId: string }
interface AuditStateStore {
  appendCanonicalInboxOnce(value: unknown): { status: "appended" | "duplicate_pending" | "duplicate_consumed"; envelope: unknown };
}
interface AuditRuntime { deliver(agentId: string, envelope: object): Promise<unknown> | unknown }
type Timer = ReturnType<typeof setTimeout>;

/** One Host-owned timer fans a targetless internal wake to each active Agent. */
export class InboxAuditHeartbeat {
  private timer: Timer | null = null;
  private running = false;
  private sequence = 0;
  private readonly cadenceMs: number;

  constructor(private readonly options: {
    agents: readonly AuditAgent[];
    stateStore(agent: AuditAgent): AuditStateStore;
    runtimeHost: AuditRuntime;
    shouldDispatch(agent: AuditAgent): boolean;
    log?: (...parts: unknown[]) => void;
    cadenceMs?: number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    now?: () => number;
  }) {
    this.cadenceMs = options.cadenceMs ?? INBOX_AUDIT_CADENCE_MS;
    if (!Number.isSafeInteger(this.cadenceMs) || this.cadenceMs < 1) throw new Error("inbox audit cadence must be a positive integer");
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) (this.options.clearTimer ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.running || this.timer) return;
    this.timer = (this.options.setTimer ?? setTimeout)(() => {
      this.timer = null;
      return this.fire().finally(() => { if (this.running) this.schedule(); });
    }, this.cadenceMs);
    this.timer.unref?.();
  }

  private async fire(): Promise<void> {
    const now = this.options.now ?? Date.now;
    for (const agent of this.options.agents) {
      try {
        if (!this.options.shouldDispatch(agent)) continue;
        const message_id = `rem_inbox_audit_${now()}_${++this.sequence}_${agent.agentId}`;
        const envelope = {
          kind: "reminder",
          message_id,
          target: RUNTIME_REMINDER_TARGET,
          wake: true,
          content: "Internal inbox audit wake. Poll runtime:reminder, then run larkin inbox audit --json. No finding stays silent.",
        };
        const appended = this.options.stateStore(agent).appendCanonicalInboxOnce(envelope);
        if (appended.status === "appended") await this.options.runtimeHost.deliver(agent.agentId, appended.envelope as object);
      } catch (error) {
        this.options.log?.(`inbox audit heartbeat failed agent=${agent.agentId}: ${boundedInboxAuditDiagnostic(error)}`);
      }
    }
  }
}
