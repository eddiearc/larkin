import * as ReminderStore from "./reminder-store.js";
import type { ReminderRecord, ReminderStore as ReminderStoreShape, RepeatResult } from "./reminder-store.js";
import { isCanonicalInboxTarget, isUserDeliveryTarget } from "./inbox-projection.js";

type JsonObject = Record<string, unknown>;

export interface ReminderRouteInput {
  path: string;
  pathNoQuery: string;
  method: string;
  body: JsonObject;
}

export interface ReminderRouteResponse {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

export interface ReminderDeliverySource {
  deliveryTarget: string;
  deliveryAnchor: string;
}

interface ReminderRouteOptions {
  stateFile: string;
  agentId: string;
  query(path: string, name: string): string | null;
  log(...parts: unknown[]): void;
  now?(): number;
  timeZone?(): string;
  currentInboxSource?(): ReminderDeliverySource | null;
  resolveMessageTarget?(messageId: string): string | null;
}

function versionOf(reminder: ReminderRecord): number {
  return Number(reminder.version || 0);
}

const VALID_IM_ANCHOR = /^om_[A-Za-z0-9_-]+$/;
const VALID_COMMENT_ANCHOR = /^doc_comment_[A-Za-z0-9_-]+$/;

function userTarget(value: unknown, field: string): string {
  const raw = String(value ?? "").trim();
  // --channel historically accepted an oc_ chat id; retain that unambiguous form.
  const target = /^oc_[A-Za-z0-9_-]+$/.test(raw) ? `chat:${raw}` : raw;
  if (!isCanonicalInboxTarget(target) || !isUserDeliveryTarget(target)) {
    throw new Error(`${field} 必须是可投递的 canonical target（chat:<id>、thread:<chat>:<thread> 或 document-comment:<locator>）`);
  }
  return target;
}

function validAnchor(value: unknown, field = "message-id", target?: string | null): string {
  const anchor = String(value ?? "").trim();
  const valid = VALID_IM_ANCHOR.test(anchor) || (target?.startsWith("document-comment:") === true && VALID_COMMENT_ANCHOR.test(anchor));
  if (!valid) throw new Error(`${field} 必须是有效的 Feishu om_ message_id，或 document-comment source 的 doc_comment_ anchor`);
  return anchor;
}

export function createReminderRoutes(options: ReminderRouteOptions) {
  const now = options.now ?? Date.now;
  const timeZone = options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);

  const handle = ({ path, pathNoQuery, method, body }: ReminderRouteInput): ReminderRouteResponse => {
    if (!options.stateFile) return { ok: false, status: 500, error: "state dir 未配置，无法持久化 reminder" };
    const match = pathNoQuery.match(/\/reminders\/([^/]+)(\/(snooze|log))?$/);
    const reminderId = match ? decodeURIComponent(match[1]) : null;
    const subroute = match ? match[3] || null : null;
    const find = (store: ReminderStoreShape): ReminderRecord | undefined =>
      store.reminders.find((record) => record.reminderId === reminderId);

    if (method === "POST" && !reminderId) {
      const title = String(body.title || "").trim();
      if (!title) return { ok: false, status: 400, error: "title 不能为空" };
      const current = now();
      const tz = typeof body.tz === "string" && body.tz ? body.tz : timeZone();
      const internal = body.internal === true || body.noDelivery === true;
      let deliveryTarget: string | null = null;
      let deliveryAnchor: string | null = null;
      if (internal) {
        if (body.deliveryTarget !== undefined || body.channel !== undefined || body.msgId !== undefined) {
          return { ok: false, status: 400, error: "internal/no-delivery reminder 不应携带 user-facing delivery target" };
        }
      } else {
        try {
          const explicit = body.deliveryTarget !== undefined ? body.deliveryTarget : body.channel;
          if (explicit !== undefined && explicit !== null && String(explicit).trim()) deliveryTarget = userTarget(explicit, "delivery target");
          if (body.msgId !== undefined && body.msgId !== null && String(body.msgId).trim()) {
            const anchorTarget = options.resolveMessageTarget?.(String(body.msgId).trim()) || null;
            deliveryAnchor = validAnchor(body.msgId, "message-id", anchorTarget || deliveryTarget);
            if (!deliveryTarget && !anchorTarget) {
              return { ok: false, status: 400, error: `message-id ${deliveryAnchor} 没有当前 Inbox 的 canonical delivery target` };
            }
            if (anchorTarget) {
              const normalizedAnchorTarget = userTarget(anchorTarget, "message-id target");
              if (deliveryTarget && deliveryTarget !== normalizedAnchorTarget) {
                return { ok: false, status: 400, error: "delivery target 与 message-id 所属 Inbox target 冲突" };
              }
              deliveryTarget = deliveryTarget || normalizedAnchorTarget;
            }
          }
          if (!deliveryTarget) {
            const source = options.currentInboxSource?.() || null;
            if (!source) return { ok: false, status: 400, error: "user-facing reminder 必须显式指定 delivery target，或从当前 Inbox source 派生" };
            deliveryTarget = userTarget(source.deliveryTarget, "current Inbox target");
            deliveryAnchor = validAnchor(source.deliveryAnchor, "current Inbox anchor", deliveryTarget);
          }
        } catch (error) {
          return { ok: false, status: 400, error: (error as Error).message };
        }
      }
      let recurrence: RepeatResult | null = null;
      if (body.repeat !== undefined) {
        recurrence = ReminderStore.parseRepeat(body.repeat, tz);
        if ("error" in recurrence) return { ok: false, status: 400, error: recurrence.error };
      }
      let fireAtMs: number | null = null;
      let warning: string | null = null;
      if (body.delaySeconds != null) fireAtMs = current + Number(body.delaySeconds) * 1_000;
      else if (body.fireAt !== undefined) {
        fireAtMs = Date.parse(String(body.fireAt));
        if (Number.isNaN(fireAtMs)) return { ok: false, status: 400, error: `fireAt 不是合法时间：${String(body.fireAt)}` };
        if (fireAtMs <= current) warning = "fireAt 已是过去时间，将立即触发";
      } else if (recurrence && !("error" in recurrence)) fireAtMs = recurrence.next(current);
      if (!fireAtMs) return { ok: false, status: 400, error: "无法确定首次触发时间" };
      const reminder: ReminderRecord = {
        reminderId: ReminderStore.newId(), ownerAgentId: options.agentId, title,
        fireAt: ReminderStore.nowIso(fireAtMs), firedAt: null, createdAt: ReminderStore.nowIso(current),
        status: "scheduled", msgRef: deliveryAnchor, msgPermalink: null,
        deliveryTarget, deliveryAnchor, deliveryMode: internal ? "internal" : "user",
        repeat: body.repeat ?? null, tz: body.repeat !== undefined ? tz : null,
        channel: body.channel ?? null, payload: body.payload ?? null,
        version: 1, events: [],
      };
      ReminderStore.appendEvent(reminder, "scheduled", "agent", options.agentId, reminder.fireAt, current, {
        deliveryTarget, deliveryAnchor, deliveryMode: internal ? "internal" : "user",
      });
      ReminderStore.mutate(options.stateFile, (store) => store.reminders.push(reminder));
      options.log(`reminder 已建 #${reminder.reminderId.slice(0, 8)} fireAt=${reminder.fireAt}${reminder.repeat ? ` repeat=${String(reminder.repeat)}` : ""} deliveryTarget=${deliveryTarget || "none"}`);
      return { ok: true, status: 200, data: { reminder: ReminderStore.toSummary(reminder), ...(warning ? { warning } : {}) } };
    }

    if (method === "GET" && !reminderId) {
      const store = ReminderStore.load(options.stateFile);
      const all = options.query(path, "all") === "true";
      const statuses = (options.query(path, "status") || "scheduled,fired").split(",").map((status) => status.trim());
      return { ok: true, status: 200, data: { reminders: store.reminders.filter((record) => all || statuses.includes(record.status)).map(ReminderStore.toSummary) } };
    }

    if (!reminderId) return { ok: false, status: 404, error: "unknown reminders route" };
    if (method === "GET" && subroute === "log") {
      const reminder = find(ReminderStore.load(options.stateFile));
      if (!reminder) return { ok: false, status: 404, error: `reminder 不存在：${reminderId}` };
      return { ok: true, status: 200, data: { events: reminder.events || [] } };
    }
    if (method === "POST" && subroute === "snooze") {
      const delay = Number(body.delaySeconds);
      if (!Number.isFinite(delay) || delay <= 0) return { ok: false, status: 400, error: "delaySeconds 必须为正数" };
      const output = ReminderStore.mutate(options.stateFile, (store) => {
        const reminder = find(store);
        if (!reminder) return null;
        const current = now();
        reminder.fireAt = ReminderStore.nowIso(current + delay * 1_000);
        reminder.status = "scheduled";
        reminder.version = versionOf(reminder) + 1;
        ReminderStore.appendEvent(reminder, "snoozed", "agent", options.agentId, reminder.fireAt, current);
        return ReminderStore.toSummary(reminder);
      });
      return output
        ? { ok: true, status: 200, data: { reminder: output } }
        : { ok: false, status: 404, error: `reminder 不存在：${reminderId}` };
    }
    if (method === "PATCH" && !subroute) {
      let warning: string | null = null;
      if (body.fireAt !== undefined && Number.isNaN(Date.parse(String(body.fireAt)))) {
        return { ok: false, status: 400, error: `fireAt 不是合法时间：${String(body.fireAt)}` };
      }
      const patchTz = typeof body.tz === "string" && body.tz ? body.tz : timeZone();
      if (body.repeat !== undefined) {
        const recurrence = ReminderStore.parseRepeat(body.repeat, patchTz);
        if ("error" in recurrence) return { ok: false, status: 400, error: recurrence.error };
      }
      const output = ReminderStore.mutate(options.stateFile, (store) => {
        const reminder = find(store);
        if (!reminder) return null;
        const current = now();
        if (body.title !== undefined) reminder.title = String(body.title);
        if (body.delaySeconds != null) {
          reminder.fireAt = ReminderStore.nowIso(current + Number(body.delaySeconds) * 1_000);
          reminder.status = "scheduled";
        }
        if (body.fireAt !== undefined) {
          const parsed = Date.parse(String(body.fireAt));
          if (parsed <= current) warning = "fireAt 已是过去时间，将立即触发";
          reminder.fireAt = ReminderStore.nowIso(parsed);
          reminder.status = "scheduled";
        }
        if (body.repeat !== undefined) {
          const tz = (typeof body.tz === "string" && body.tz) || reminder.tz || patchTz;
          reminder.repeat = body.repeat;
          reminder.tz = tz;
          reminder.status = "scheduled";
          const recurrence = ReminderStore.parseRepeat(body.repeat, tz);
          if (!("error" in recurrence) && Date.parse(reminder.fireAt) <= current) {
            const next = recurrence.next(current, Date.parse(reminder.fireAt));
            if (next) reminder.fireAt = ReminderStore.nowIso(next);
          }
        }
        reminder.version = versionOf(reminder) + 1;
        ReminderStore.appendEvent(reminder, "updated", "agent", options.agentId, reminder.status === "scheduled" ? reminder.fireAt : null, current);
        return ReminderStore.toSummary(reminder);
      });
      return output
        ? { ok: true, status: 200, data: { reminder: output, ...(warning ? { warning } : {}) } }
        : { ok: false, status: 404, error: `reminder 不存在：${reminderId}` };
    }
    if (method === "DELETE" && !subroute) {
      const output = ReminderStore.mutate(options.stateFile, (store) => {
        const reminder = find(store);
        if (!reminder) return null;
        const current = now();
        reminder.status = "canceled";
        reminder.version = versionOf(reminder) + 1;
        ReminderStore.appendEvent(reminder, "canceled", "agent", options.agentId, null, current);
        return ReminderStore.toSummary(reminder);
      });
      if (!output) return { ok: false, status: 404, error: `reminder 不存在：${reminderId}` };
      options.log(`reminder 已取消 #${reminderId.slice(0, 8)}`);
      return { ok: true, status: 200, data: { reminder: output } };
    }
    return { ok: false, status: 404, error: `unknown reminders route: ${method} ${pathNoQuery}` };
  };

  return { handle };
}
