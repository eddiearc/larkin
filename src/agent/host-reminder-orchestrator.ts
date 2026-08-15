import * as fs from "node:fs";
import type { AgentStatePaths } from "../platform/root-layout.js";
import type { HostAgent, HostEnvelopeProjector, ReminderEnvelope } from "../feishu/host-business-state.js";
import { countWakeEnvelopes } from "../feishu/host-business-state.js";
import * as defaultReminderStore from "./reminder-store.js";
import type { ReminderRecord, ReminderStore } from "./reminder-store.js";
import { targetKeyOfInboxEnvelope, type InboxEnvelope } from "./inbox-projection.js";

interface ReminderAgent extends HostAgent { stateDir?: string | null }
interface ReminderDeliveryTarget {
  deliver(agentId: string, envelope: ReminderEnvelope | object): Promise<unknown> | unknown;
}
interface StateStore {
  paths: AgentStatePaths;
  appendNdjson(key: "inbox", value: unknown): void;
}
function withCanonicalTarget<T extends object>(envelope: T): T & { target: string } {
  const input = envelope as InboxEnvelope;
  const target = targetKeyOfInboxEnvelope(input);
  return input.target === target ? envelope as T & { target: string } : { ...envelope, target };
}

interface ReminderStoreApi {
  load(file: string): ReminderStore;
  mutate<T>(file: string, fn: (store: ReminderStore) => T): T;
  parseRepeat(repeat: unknown, tz?: string | null): ReturnType<typeof defaultReminderStore.parseRepeat>;
  nowIso(ms?: number): string;
  appendEvent: typeof defaultReminderStore.appendEvent;
}

export interface ReminderOrchestratorOptions {
  agents: ReminderAgent[];
  stateStore(agent: ReminderAgent): StateStore;
  envelopeProjector: Pick<HostEnvelopeProjector, "createReminderEnvelope" | "createRedeliveryEnvelope">;
  deliveryTarget?: ReminderDeliveryTarget;
  reminderStore?: ReminderStoreApi;
  log?: (...parts: unknown[]) => void;
  now?: () => number;
  readFile?: typeof fs.readFileSync;
  watch?: typeof fs.watch;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  setInterval?: typeof globalThis.setInterval;
}

export class HostReminderOrchestrator {
  private readonly lastSnapshot = new Map<string, string>();
  private readonly redelivered = new Set<string>();
  private readonly redeliveryInFlight = new Map<string, Promise<void>>();
  private started = false;
  private readonly store: ReminderStoreApi;
  private readonly log: (...parts: unknown[]) => void;
  private readonly now: () => number;
  private readonly fireTimers = new Map<string, NodeJS.Timeout>();
  private readonly watchers: fs.FSWatcher[] = [];
  private syncInterval: NodeJS.Timeout | null = null;

  constructor(private readonly options: ReminderOrchestratorOptions) {
    this.store = options.reminderStore ?? defaultReminderStore;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  pushSnapshot(agent: ReminderAgent, why?: string, force = false): void {
    let jobs: Array<{ reminderId: string; version: number; ownerAgentId: string; fireAt: string }> = [];
    try {
      jobs = this.store.load(this.options.stateStore(agent).paths.reminders).reminders
        .filter((record) => record.status === "scheduled")
        .map((record) => ({
          reminderId: record.reminderId,
          version: Number(record.version),
          ownerAgentId: record.ownerAgentId,
          fireAt: record.fireAt,
        }));
    } catch (error) {
      this.log(`reminder 快照读取失败 agent=${agent.name}: ${(error as Error).message}`);
      return;
    }
    const key = JSON.stringify(jobs);
    if (!force && this.lastSnapshot.get(agent.agentId) === key) return;
    this.lastSnapshot.set(agent.agentId, key);
    const wanted = new Set(jobs.map((job) => `${agent.agentId}:${job.reminderId}`));
    for (const [timerKey, timer] of this.fireTimers) {
      if (timerKey.startsWith(`${agent.agentId}:`) && !wanted.has(timerKey)) {
        (this.options.clearTimer ?? clearTimeout)(timer);
        this.fireTimers.delete(timerKey);
      }
    }
    for (const job of jobs) {
      const timerKey = `${agent.agentId}:${job.reminderId}`;
      const previous = this.fireTimers.get(timerKey);
      if (previous) (this.options.clearTimer ?? clearTimeout)(previous);
      const delay = Math.max(0, Math.min(2_147_000_000, Date.parse(job.fireAt) - this.now()));
      const timer = (this.options.setTimer ?? setTimeout)(() => {
        this.fireTimers.delete(timerKey);
        this.handleFire({ agentId: agent.agentId, reminderId: job.reminderId });
      }, delay);
      timer.unref?.();
      this.fireTimers.set(timerKey, timer);
    }
    this.log(`reminder 本地排程 agent=${agent.name} n=${jobs.length}${why ? ` (${why})` : ""}`);
  }

  private deliver(agent: ReminderAgent, reminder: ReminderRecord, overdueMs: number): void {
    const recurrence = reminder.repeat ? this.store.parseRepeat(reminder.repeat, reminder.tz) : null;
    const envelope = withCanonicalTarget(this.options.envelopeProjector.createReminderEnvelope(
      agent.agentId,
      {
        reminderId: reminder.reminderId,
        title: reminder.title,
        repeat: reminder.repeat ? String(reminder.repeat) : null,
        fireAt: reminder.fireAt,
        msgRef: reminder.msgRef,
        channel: reminder.channel ? String(reminder.channel) : null,
      },
      overdueMs,
      reminder.repeat && recurrence && !("error" in recurrence) ? (recurrence.description || null) : null,
    ));
    try { this.options.stateStore(agent).appendNdjson("inbox", envelope); }
    catch (error) { this.log("reminder inbox 写失败", (error as Error).message); return; }
    if (this.options.deliveryTarget) void this.options.deliveryTarget.deliver(agent.agentId, envelope);
    else this.log(`reminder 触发但 Runtime Host 未就绪 id=#${reminder.reminderId.slice(0, 8)}（仅入 inbox）`);
  }

  handleFire(message: { agentId?: string; reminderId?: string }): void {
    const agent = this.options.agents.find((candidate) => candidate.agentId === message.agentId);
    if (!agent) { this.log(`reminder fire_attempt 未知 agent=${message.agentId}`); return; }
    const file = this.options.stateStore(agent).paths.reminders;
    const now = this.now();
    let action: "deliver" | "rearm" | null = null;
    let fired: ReminderRecord | null = null;
    let overdueMs = 0;
    try {
      this.store.mutate(file, (store) => {
        const reminder = store.reminders.find((candidate) => candidate.reminderId === message.reminderId);
        if (!reminder || reminder.status !== "scheduled") {
          this.log(`reminder fire 忽略（不存在或非 scheduled）id=${String(message.reminderId).slice(0, 8)}`);
          return;
        }
        const due = Date.parse(reminder.fireAt);
        if (Number.isFinite(due) && due - now > 60_000) { action = "rearm"; return; }
        overdueMs = Math.max(0, now - due);
        const recurrence = reminder.repeat ? this.store.parseRepeat(reminder.repeat, reminder.tz) : null;
        if (recurrence && !("error" in recurrence)) {
          const next = recurrence.next(now, due);
          reminder.firedAt = this.store.nowIso(now);
          if (next) reminder.fireAt = this.store.nowIso(next);
          else reminder.status = "fired";
        } else {
          reminder.status = "fired";
          reminder.firedAt = this.store.nowIso(now);
        }
        reminder.version = Number(reminder.version) + 1;
        this.store.appendEvent(reminder, "fired", "system", null, reminder.status === "scheduled" ? reminder.fireAt : null, now);
        store.reminders = store.reminders.filter((candidate) =>
          candidate.status === "scheduled" || now - Date.parse(candidate.firedAt || candidate.createdAt || "") < 30 * 86_400_000);
        action = "deliver";
        fired = { ...reminder };
      });
    } catch (error) {
      this.log(`reminder fire 处理失败 agent=${agent.name}: ${(error as Error).message}`);
      return;
    }
    if (action === "deliver" && fired) {
      const record = fired as ReminderRecord;
      this.log(`reminder 触发 agent=${agent.name} id=#${record.reminderId.slice(0, 8)} "${record.title.slice(0, 40)}"${overdueMs > 120_000 ? ` 逾期${Math.round(overdueMs / 60_000)}min` : ""}`);
      this.deliver(agent, record, overdueMs);
    } else if (action === "rearm") {
      this.log(`reminder 未到期（daemon 24h 截断），续排 id=${String(message.reminderId).slice(0, 8)}`);
    }
    this.pushSnapshot(agent, action === "rearm" ? "续排" : "fire 后同步", true);
  }

  startSync(): void {
    if (this.started) return;
    this.started = true;
    const setTimer = this.options.setTimer ?? setTimeout;
    const clearTimer = this.options.clearTimer ?? clearTimeout;
    for (const agent of this.options.agents) {
      this.pushSnapshot(agent, "启动");
      if (!agent.stateDir) continue;
      const timers = new Map<string, NodeJS.Timeout>();
      try {
        const watcher = (this.options.watch ?? fs.watch)(agent.stateDir, (_event, filename) => {
          if (filename !== "reminders.json") return;
          const timer = timers.get(agent.agentId);
          if (timer) clearTimer(timer);
          timers.set(agent.agentId, setTimer(() => this.pushSnapshot(agent, "文件变更"), 300));
        });
        this.watchers.push(watcher);
      } catch (error) { this.log(`reminder watch 失败 agent=${agent.name}: ${(error as Error).message}`); }
    }
    const interval = (this.options.setInterval ?? setInterval)(() => {
      for (const agent of this.options.agents) this.pushSnapshot(agent, "定期兜底");
    }, 60_000);
    interval.unref();
    this.syncInterval = interval;
  }

  stopSync(): void {
    for (const timer of this.fireTimers.values()) (this.options.clearTimer ?? clearTimeout)(timer);
    this.fireTimers.clear();
    if (this.syncInterval) clearInterval(this.syncInterval);
    this.syncInterval = null;
    for (const watcher of this.watchers.splice(0)) watcher.close();
    this.started = false;
  }

  async redeliverUnread(agent: ReminderAgent): Promise<void> {
    if (this.redelivered.has(agent.agentId)) return;
    const existingAttempt = this.redeliveryInFlight.get(agent.agentId);
    if (existingAttempt) return existingAttempt;
    const attempt = this.performRedelivery(agent);
    this.redeliveryInFlight.set(agent.agentId, attempt);
    try { await attempt; }
    finally { if (this.redeliveryInFlight.get(agent.agentId) === attempt) this.redeliveryInFlight.delete(agent.agentId); }
  }

  private async performRedelivery(agent: ReminderAgent): Promise<void> {
    let lines: string[] = [];
    try {
      lines = String((this.options.readFile ?? fs.readFileSync)(this.options.stateStore(agent).paths.inbox, "utf8"))
        .split("\n").filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && this.options.deliveryTarget) {
        this.redelivered.add(agent.agentId);
      }
      return;
    }
    const parsed = lines.map((line) => {
      try {
        return { line, value: JSON.parse(line) as Record<string, unknown> };
      } catch { return { line, value: null }; }
    });
    if (parsed.some(({ value }) => value === null)) return;
    const existing = parsed.find(({ value }) => typeof value?.message_id === "string" && value.message_id.startsWith("redeliver_"))?.value;
    const wakeCount = countWakeEnvelopes(parsed
      .filter(({ value }) => !(typeof value?.message_id === "string" && value.message_id.startsWith("redeliver_")))
      .map(({ line }) => line));
    if (!wakeCount && !existing) {
      if (this.options.deliveryTarget) this.redelivered.add(agent.agentId);
      return;
    }
    const envelope = withCanonicalTarget(existing ?? this.options.envelopeProjector.createRedeliveryEnvelope(agent.agentId, wakeCount));
    if (!existing) {
      try { this.options.stateStore(agent).appendNdjson("inbox", envelope); }
      catch (error) { this.log("启动补投 inbox 写失败", (error as Error).message); return; }
    }
    this.log(`启动补投 agent=${agent.name} 滞留 wake 消息 ${wakeCount} 条`);
    if (this.options.deliveryTarget) await this.options.deliveryTarget.deliver(agent.agentId, envelope);
    else return;
    this.redelivered.add(agent.agentId);
  }
}
