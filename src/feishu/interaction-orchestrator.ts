import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { InteractionStateMachine, type InteractionEffect, type InteractionRun } from "../agent/interaction-state-machine.js";
import type { AgentStateStore } from "../agent/agent-state-store.js";
import * as ReminderStore from "../agent/reminder-store.js";

interface InteractionAgent { agentId: string; name: string; stateDir?: string }
interface CardActionEvent {
  messageId: string;
  chatId: string;
  operator: { openId: string; name?: string };
  action: { value: unknown; tag: string; name?: string; option?: string; formValue?: Record<string, unknown> };
  raw?: unknown;
}
interface DeliveryTarget { deliver(agentId: string, envelope: object): Promise<{ status?: string; reason?: string }> | { status?: string; reason?: string } }
interface CardChannel { updateCard(messageId: string, card: object): Promise<void> }

export interface InteractionOrchestratorOptions {
  agents: InteractionAgent[];
  stateStore(agent: InteractionAgent): AgentStateStore;
  deliveryTarget: DeliveryTarget;
  channelFor(agent: InteractionAgent): CardChannel | undefined;
  log?: (...parts: unknown[]) => void;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  watch?: typeof fs.watch;
  /** Test-only crash seam after Runtime acceptance and before outbox acknowledgement. */
  afterRuntimeDelivery?(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function rawEventId(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const header = isRecord(raw.header) ? raw.header : null;
  const event = isRecord(raw.event) ? raw.event : null;
  for (const value of [raw.event_id, header?.event_id, event?.event_id]) if (typeof value === "string" && value) return value;
  return null;
}

function interactionRef(event: CardActionEvent): string {
  if (!isRecord(event.action.value) || typeof event.action.value.interaction_ref !== "string") throw new Error("card action is not a Larkin interaction");
  return event.action.value.interaction_ref;
}

function interactionVersion(event: CardActionEvent): number {
  if (!isRecord(event.action.value) || !Number.isSafeInteger(event.action.value.interaction_version)) throw new Error("card action interaction_version is missing");
  return Number(event.action.value.interaction_version);
}

export class HostInteractionOrchestrator {
  private readonly log: (...parts: unknown[]) => void;
  private readonly now: () => number;
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly syncAgents = new Map<string, InteractionAgent>();
  private readonly flushInFlight = new Map<string, Promise<void>>();
  private syncTimer: NodeJS.Timeout | null = null;
  private syncActive = false;

  constructor(private readonly options: InteractionOrchestratorOptions) {
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  private machine(agent: InteractionAgent): InteractionStateMachine {
    return new InteractionStateMachine({ stateStore: this.options.stateStore(agent), agentId: agent.agentId, now: this.now });
  }

  private callbackId(event: CardActionEvent): string {
    const eventId = rawEventId(event.raw);
    if (!eventId) throw new Error("card callback event_id is missing; enable includeRawEvent and retry");
    return `card:${eventId}`;
  }

  private runReminderEffect(agent: InteractionAgent, run: InteractionRun, effect: InteractionEffect, deadline: number): { status: "succeeded" | "failed" | "uncertain" | "timed_out"; summary: string; data: Record<string, unknown> } {
    if (deadline - this.now() < 500) return { status: "timed_out", summary: "reminder.schedule skipped because the Reflex deadline was exhausted", data: { category: "reflex_deadline" } };
    try {
      const file = this.options.stateStore(agent).paths.reminders;
      const reminderId = `int_${createHash("sha256").update(run.run_id).digest("hex").slice(0, 24)}`;
      const current = this.now();
      const fireAt = effect.args.fire_at ? Date.parse(effect.args.fire_at) : current + Number(effect.args.delay_seconds) * 1_000;
      const deliveryTarget = typeof run.chat_id === "string" && run.chat_id ? `chat:${run.chat_id}` : null;
      const deliveryAnchor = typeof run.message_id === "string" && /^om_[A-Za-z0-9_-]+$/.test(run.message_id) ? run.message_id : null;
      const reminder = ReminderStore.mutate(file, (store) => {
        const existing = store.reminders.find((candidate) => candidate.reminderId === reminderId);
        if (existing) return existing;
        const created: ReminderStore.ReminderRecord = {
          reminderId,
          ownerAgentId: agent.agentId,
          title: effect.args.title,
          fireAt: ReminderStore.nowIso(fireAt),
          firedAt: null,
          createdAt: ReminderStore.nowIso(current),
          status: "scheduled",
          msgRef: run.message_id,
          msgPermalink: null,
          deliveryTarget,
          deliveryAnchor,
          deliveryMode: "user",
          repeat: null,
          tz: null,
          channel: run.chat_id,
          payload: { source: "interaction", run_id: run.run_id },
          version: 1,
          events: [],
        };
        ReminderStore.appendEvent(created, "scheduled", "interaction", run.run_id, created.fireAt, current, {
          deliveryTarget, deliveryAnchor, deliveryMode: "user",
        });
        store.reminders.push(created);
        return created;
      }, Math.max(1, Math.min(350, deadline - this.now() - 100)));
      return { status: "succeeded", summary: "reminder.schedule completed", data: { reminder_id: reminder.reminderId, fire_at: reminder.fireAt } };
    } catch (error) {
      const timedOut = this.now() >= deadline || /锁等待超时/.test(errorMessage(error));
      return timedOut
        ? { status: "timed_out", summary: "reminder.schedule did not complete within the Reflex deadline", data: { category: "reflex_deadline" } }
        : { status: "uncertain", summary: "reminder.schedule could not confirm its durable result; inspect before retrying", data: { category: "reminder_schedule_uncertain" } };
    }
  }

  async handleCardAction(agent: InteractionAgent, event: CardActionEvent): Promise<Record<string, unknown>> {
    const deadline = this.now() + 2_700;
    const machine = this.machine(agent);
    try {
      const claimed = machine.claim({
        interaction_ref: interactionRef(event),
        expected_version: interactionVersion(event),
        callback_id: this.callbackId(event),
        operator_open_id: event.operator.openId,
        chat_id: event.chatId,
        message_id: event.messageId,
      });
      let run = claimed.run;
      if (run.reflex.status === "pending") {
        const effect = claimed.definition.actions[run.action_id].reflex.effect;
        const result = effect
          ? this.runReminderEffect(agent, run, effect, deadline)
          : { status: "succeeded" as const, summary: "default Reflex accepted the action", data: {} };
        run = machine.recordReflex(run.run_id, result);
      }
      void this.flushPending(agent).catch((error) => this.log(`interaction 异步投递失败 agent=${agent.name}: ${errorMessage(error)}`));
      const latest = machine.get({ run_id: run.run_id });
      const effectFailed = ["failed", "uncertain", "timed_out"].includes(run.reflex.status);
      return {
        toast: {
          type: effectFailed ? "warning" : "info",
          content: effectFailed ? "快速操作结果尚未确认，Agent 已接管；当前不代表业务完成。" : "已受理，Agent 正在处理，完成后会更新卡片。",
        },
        card: { type: "raw", data: latest.card },
      };
    } catch (error) {
      this.log(`interaction callback 拒绝 agent=${agent.name}: ${errorMessage(error)}`);
      const reason = errorMessage(error);
      const safeReason = /expired|not allowed|already has an active run|transition limit|reference is invalid|event_id is missing|version is stale|interaction_version is missing/.test(reason)
        ? reason : "interaction service is temporarily unavailable";
      return { toast: { type: "error", content: `无法受理：${safeReason}` } };
    }
  }

  async flushPending(agent: InteractionAgent): Promise<void> {
    const existing = this.flushInFlight.get(agent.agentId);
    if (existing) return existing;
    const attempt = this.performFlush(agent);
    this.flushInFlight.set(agent.agentId, attempt);
    try { await attempt; }
    finally { if (this.flushInFlight.get(agent.agentId) === attempt) this.flushInFlight.delete(agent.agentId); }
  }

  private async performFlush(agent: InteractionAgent): Promise<void> {
    const machine = this.machine(agent);
    const maintenance = machine.pendingMaintenance();
    if (maintenance.interrupted_reflex) machine.recoverInterruptedReflexes();
    if (maintenance.timed_out_run) machine.expireTimedOutRuns();
    for (let pass = 0; pass < 4; pass += 1) {
      const pending = machine.pendingOutbox();
      if (!pending.length) break;
      let hadFailure = false;
      for (const item of pending) {
        try {
          if (item.kind === "agent_wake") {
            const envelope = item.payload;
            const preparation = this.options.stateStore(agent).prepareInboxDelivery(envelope);
            if (preparation !== "consumed") {
              const receipt = await this.options.deliveryTarget.deliver(agent.agentId, envelope);
              if (!receipt || !["accepted", "duplicate", "deferred"].includes(String(receipt.status))) {
                throw new Error(`Runtime delivery returned ${String(receipt?.status || "unknown")}: ${String(receipt?.reason || "no reason")}`);
              }
              this.options.afterRuntimeDelivery?.();
            }
            machine.markOutbox(item.outbox_id, { delivered: true });
          } else {
            const channel = this.options.channelFor(agent);
            if (!channel) throw new Error("card channel is not connected");
            const projection = machine.prepareProjection(item.outbox_id);
            if (!projection) continue;
            try {
              await channel.updateCard(projection.message_id, projection.card);
              machine.completeProjection(item.outbox_id, projection.desired_version, { delivered: true });
            } catch (error) {
              machine.completeProjection(item.outbox_id, projection.desired_version, { delivered: false, error: errorMessage(error) });
              throw error;
            }
          }
        } catch (error) {
          hadFailure = true;
          if (item.kind === "agent_wake") machine.markOutbox(item.outbox_id, { delivered: false, error: errorMessage(error) });
          this.log(`interaction outbox 保留重试 agent=${agent.name} kind=${item.kind}: ${errorMessage(error)}`);
        }
      }
      if (hadFailure) break;
    }
  }

  startSync(): void {
    if (this.syncTimer) return;
    this.syncActive = true;
    for (const agent of this.options.agents) this.syncAgent(agent);
    this.syncTimer = (this.options.setInterval ?? setInterval)(() => {
      for (const agent of this.syncAgents.values()) void this.flushPending(agent);
    }, 30_000);
    this.syncTimer.unref?.();
  }

  syncAgent(agent: InteractionAgent): void {
    this.syncAgents.set(agent.agentId, agent);
    if (!this.syncActive) return;
    if (agent.stateDir && !this.watchers.has(agent.agentId)) {
      try {
        const watcher = (this.options.watch ?? fs.watch)(agent.stateDir, (_event, filename) => {
          const current = this.syncAgents.get(agent.agentId);
          if (filename === "interactions.json" && current) void this.flushPending(current);
        });
        this.watchers.set(agent.agentId, watcher);
      } catch (error) { this.log(`interaction watch 失败 agent=${agent.name}: ${errorMessage(error)}`); }
    }
    void this.flushPending(agent);
  }

  stopSync(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.syncActive = false;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.syncAgents.clear();
  }
}
