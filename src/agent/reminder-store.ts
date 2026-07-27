import crypto from "node:crypto";
import fs from "node:fs";

export interface ReminderEvent {
  eventId: string;
  reminderId: string;
  eventType: string;
  actorType: string;
  actorId: unknown;
  occurredAt: string;
  nextFireAt: unknown;
  metadata: null;
}

export interface ReminderRecord {
  reminderId: string;
  ownerAgentId: string;
  title: string;
  fireAt: string;
  firedAt?: string | null;
  createdAt: string;
  status: string;
  msgRef?: unknown;
  msgPermalink?: unknown;
  repeat?: unknown;
  tz?: string | null;
  events?: ReminderEvent[];
  [key: string]: unknown;
}

export interface ReminderStore {
  reminders: ReminderRecord[];
  [key: string]: unknown;
}

export interface RepeatSchedule {
  kind: "interval" | "daily" | "weekly";
  description: string;
  next(afterMs: number, anchorMs?: number): number | null;
  error?: never;
}

export interface RepeatError {
  error: string;
  kind?: never;
  description?: never;
  next?: never;
}

export type RepeatResult = RepeatSchedule | RepeatError;

interface NodeError extends Error { code?: string }

export const nowIso = (ms?: number | null): string => new Date(ms ?? Date.now()).toISOString();
export const newId = (): string => crypto.randomUUID().replace(/-/g, "");

// Host and Agent transport are separate processes. mkdir is the cross-process mutex;
// the timeout and stale-lock ages intentionally preserve the established production contract.
export function withLock<T>(file: string, fn: () => T, timeoutMs = 2_000): T {
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeError).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 10_000) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch { /* another process may be reclaiming the same stale directory */ }
      if (Date.now() > deadline) throw new Error("reminders.json 锁等待超时");
      const until = Date.now() + 15;
      while (Date.now() < until) { /* preserve the existing short synchronous critical section */ }
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(lockDir); } catch { /* best effort: preserve existing crash-recovery semantics */ }
  }
}

export function load(file: string): ReminderStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { reminders?: unknown } | null;
    if (parsed && Array.isArray(parsed.reminders)) return parsed as ReminderStore;
  } catch { /* missing and damaged stores both project to an empty store */ }
  return { reminders: [] };
}

export function save(file: string, store: ReminderStore): void {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export function mutate<T>(file: string, fn: (store: ReminderStore) => T, lockTimeoutMs = 2_000): T {
  return withLock(file, () => {
    const store = load(file);
    const result = fn(store);
    save(file, store);
    return result;
  }, lockTimeoutMs);
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function validTz(tz: string | undefined): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch { return false; }
}

function wallParts(ms: number, tz: string | undefined): { y: number; mo: number; d: number; hh: number; mm: number; ss: number; wd: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(ms)) parts[part.type] = part.value;
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    hh: parts.hour === "24" ? 0 : Number(parts.hour),
    mm: Number(parts.minute),
    ss: Number(parts.second),
    wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
  };
}

function utcOffsetMs(ms: number, tz: string | undefined): number {
  const wall = wallParts(ms, tz);
  return Date.UTC(wall.y, wall.mo - 1, wall.d, wall.hh, wall.mm, wall.ss) - Math.floor(ms / 1_000) * 1_000;
}

function wallToUtc(y: number, mo: number, d: number, hh: number, mm: number, tz: string | undefined): number {
  const firstGuess = Date.UTC(y, mo - 1, d, hh, mm);
  const secondGuess = firstGuess - utcOffsetMs(firstGuess, tz);
  return firstGuess - utcOffsetMs(secondGuess, tz);
}

export function parseRepeat(rule: unknown, tz?: string | null): RepeatResult {
  const normalized = String(rule || "").trim();
  const normalizedTz = tz || undefined;
  const zone = validTz(normalizedTz) ? normalizedTz : Intl.DateTimeFormat().resolvedOptions().timeZone;

  let match = normalized.match(/^every:(\d+)(s|m|h|d)$/);
  if (match) {
    const multipliers: Record<"s" | "m" | "h" | "d", number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    const unit = match[2] as keyof typeof multipliers;
    const period = Number(match[1]) * multipliers[unit];
    if (period < 60_000) return { error: "间隔太短：every 至少 1 分钟（如 every:15m）" };
    return {
      kind: "interval",
      description: `every ${match[1]}${unit}`,
      next: (afterMs, anchorMs) => {
        const base = Number.isFinite(anchorMs) ? Number(anchorMs) : afterMs;
        const count = Math.max(1, Math.floor((afterMs - base) / period) + 1);
        return base + count * period;
      },
    };
  }

  match = normalized.match(/^daily@(\d{1,2}):(\d{2})$/);
  if (match) {
    const [hours, minutes] = [Number(match[1]), Number(match[2])];
    if (hours > 23 || minutes > 59) return { error: `无效时间 ${match[1]}:${match[2]}` };
    return {
      kind: "daily",
      description: `daily@${String(hours).padStart(2, "0")}:${match[2]} (${zone})`,
      next: (afterMs) => {
        const wall = wallParts(afterMs, zone);
        for (let offset = 0; offset <= 2; offset += 1) {
          const candidate = wallToUtc(wall.y, wall.mo, wall.d + offset, hours, minutes, zone);
          if (candidate > afterMs) return candidate;
        }
        return null;
      },
    };
  }

  match = normalized.match(/^weekly:([a-z,]+)@(\d{1,2}):(\d{2})$/);
  if (match) {
    const days = match[1].split(",").map((day) => WEEKDAYS.indexOf(day.trim() as typeof WEEKDAYS[number]));
    const [hours, minutes] = [Number(match[2]), Number(match[3])];
    if (days.some((day) => day < 0)) return { error: `无效星期（可用: ${WEEKDAYS.join(",")}）：${match[1]}` };
    if (hours > 23 || minutes > 59) return { error: `无效时间 ${match[2]}:${match[3]}` };
    return {
      kind: "weekly",
      description: `weekly:${match[1]}@${String(hours).padStart(2, "0")}:${match[3]} (${zone})`,
      next: (afterMs) => {
        const wall = wallParts(afterMs, zone);
        for (let offset = 0; offset <= 8; offset += 1) {
          const candidate = wallToUtc(wall.y, wall.mo, wall.d + offset, hours, minutes, zone);
          if (candidate > afterMs && days.includes(wallParts(candidate, zone).wd)) return candidate;
        }
        return null;
      },
    };
  }

  return { error: `无法识别的 repeat 规则：${JSON.stringify(normalized)}。支持 every:<N><s|m|h|d>、daily@HH:MM、weekly:mon,fri@HH:MM` };
}

export function toSummary(reminder: ReminderRecord): {
  reminderId: string; ownerAgentId: string; title: string; fireAt: string; firedAt: string | null;
  createdAt: string; status: string; msgRef: unknown; msgPermalink: unknown;
  recurrence: { kind: string; description: string } | null;
} {
  let recurrence: { kind: string; description: string } | null = null;
  if (reminder.repeat) {
    const parsed = parseRepeat(reminder.repeat, reminder.tz || undefined);
    recurrence = "error" in parsed
      ? { kind: "unsupported", description: String(reminder.repeat) }
      : { kind: parsed.kind, description: parsed.description };
  }
  return {
    reminderId: reminder.reminderId,
    ownerAgentId: reminder.ownerAgentId,
    title: reminder.title,
    fireAt: reminder.fireAt,
    firedAt: reminder.firedAt ?? null,
    createdAt: reminder.createdAt,
    status: reminder.status,
    msgRef: reminder.msgRef ?? null,
    msgPermalink: reminder.msgPermalink ?? null,
    recurrence,
  };
}

export function appendEvent(
  reminder: ReminderRecord,
  eventType: string,
  actorType: string,
  actorId: unknown,
  nextFireAt: unknown,
  ms?: number | null,
): void {
  if (!Array.isArray(reminder.events)) reminder.events = [];
  reminder.events.push({
    eventId: newId(),
    reminderId: reminder.reminderId,
    eventType,
    actorType,
    actorId: actorId ?? null,
    occurredAt: nowIso(ms),
    nextFireAt: nextFireAt ?? null,
    metadata: null,
  });
}
