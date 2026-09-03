import * as fs from "node:fs";
import * as path from "node:path";

/**
 * #169's host-owned heartbeat no longer creates per-target missed-outbound loops.
 * Pre-v0.4.21 records have no unique ownership marker and can collide exactly
 * with user reminders, so existing indistinguishable loops are never migrated
 * or deleted automatically.
 */
export const INBOX_AUDIT_LEGACY_MIGRATION_NON_GOAL = "New versions no longer create missed-outbound loops; existing indistinguishable historical loops are not migrated or deleted automatically.";
// Pending audits are bounded so a heartbeat cannot accumulate an unbounded work list.
export const MAX_INBOX_AUDIT_TARGETS = 96;
const MAX_STORED_TARGETS = MAX_INBOX_AUDIT_TARGETS;
const CHAT = /^oc_[A-Za-z0-9]+$/;
const THREAD = /^omt_[A-Za-z0-9]+$/;
const ANCHOR = /^om_[A-Za-z0-9_-]+$/;

export interface InboxAuditTarget {
  target: string;
  anchor: string;
  observed_at: string;
}

type AuditStatus = "pending" | "completed";
interface StoredTarget extends InboxAuditTarget {
  agent_id: string;
  status: AuditStatus;
  completed_at?: string;
  completed_anchor?: string;
}
interface AuditRegistry { version: 2; targets: StoredTarget[] }

export function inboxAuditRegistryFile(larkinHome: string): string {
  return path.join(larkinHome, "inbox-audit.json");
}

function parseTarget(event: { chat_id?: string; thread_id?: string | null; message_id?: string }): { target: string; anchor: string } | null {
  const chatId = String(event.chat_id || "");
  const threadId = event.thread_id ? String(event.thread_id) : "";
  const anchor = String(event.message_id || "");
  if (!CHAT.test(chatId) || !ANCHOR.test(anchor) || (threadId && !THREAD.test(threadId))) return null;
  return { target: threadId ? `thread:${chatId}:${threadId}` : `chat:${chatId}`, anchor };
}

function emptyRegistry(): AuditRegistry {
  return { version: 2, targets: [] };
}

function load(file: string): AuditRegistry {
  let value: { version?: unknown; targets?: unknown };
  try { value = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown; targets?: unknown }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw error;
  }
  // v1 rows were recorded without wake eligibility, so they cannot prove a
  // missed originally-wake=true outbound. Discard rather than re-scan them.
  if (value?.version === 1) return emptyRegistry();
  if (value?.version !== 2 || !Array.isArray(value.targets)) return emptyRegistry();
  return { version: 2, targets: value.targets.flatMap((row): StoredTarget[] => {
    if (!row || typeof row !== "object") return [];
    const candidate = row as Partial<StoredTarget>;
    if (typeof candidate.target !== "string" || typeof candidate.anchor !== "string") return [];
    const parsed = parseTarget({
      chat_id: candidate.target.startsWith("chat:") ? candidate.target.slice(5) : candidate.target.split(":")[1],
      thread_id: candidate.target.startsWith("thread:") ? candidate.target.split(":")[2] : null,
      message_id: candidate.anchor,
    });
    const status = candidate.status === "completed" ? "completed" : candidate.status === "pending" ? "pending" : null;
    if (!status || typeof candidate.agent_id !== "string" || !candidate.agent_id || !parsed || candidate.target !== parsed.target) return [];
    if (typeof candidate.observed_at !== "string" || !Number.isFinite(Date.parse(candidate.observed_at))) return [];
    const completed_at = typeof candidate.completed_at === "string" && Number.isFinite(Date.parse(candidate.completed_at))
      ? candidate.completed_at : undefined;
    const completed_anchor = typeof candidate.completed_anchor === "string" && ANCHOR.test(candidate.completed_anchor)
      ? candidate.completed_anchor : undefined;
    return [{
      agent_id: candidate.agent_id, ...parsed, observed_at: candidate.observed_at, status,
      ...(completed_at ? { completed_at } : {}),
      ...(completed_anchor ? { completed_anchor } : {}),
    }];
  }) };
}

function save(file: string, registry: AuditRegistry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

/**
 * Record only an originally wake=true human group/topic source.
 * Unmentioned require-policy traffic, DMs, and bots stay out of the audit work list.
 */
export function observeInboxAuditTarget(file: string, agentId: string, event: {
  chat_id?: string;
  chat_type?: string;
  thread_id?: string | null;
  message_id?: string;
  wake?: boolean;
  _sender_is_bot?: boolean;
  _scan_authority?: boolean;
}, now = new Date()): boolean {
  if (event.wake !== true || event._scan_authority !== true || event._sender_is_bot !== false || event.chat_type !== "group") return false;
  const parsed = parseTarget(event);
  if (!parsed) return false;
  const registry = load(file);
  const existing = registry.targets.find((row) => row.agent_id === agentId && row.target === parsed.target);
  if (existing?.status === "completed" && existing.anchor === parsed.anchor) return false;
  const observed_at = now.toISOString();
  registry.targets = registry.targets.filter((row) => row.agent_id !== agentId || row.target !== parsed.target);
  registry.targets.unshift({ agent_id: agentId, ...parsed, observed_at, status: "pending" });
  registry.targets = registry.targets.slice(0, MAX_STORED_TARGETS);
  save(file, registry);
  return true;
}

function instruction(target: InboxAuditTarget): string {
  const history = target.target.startsWith("thread:")
    ? "Use larkin im +threads-messages-list for this exact thread."
    : "Use larkin im +chat-messages-list for this exact chat.";
  return `${history} If a real missed outbound finding requires a response, use the existing guarded larkin im reply path anchored at ${target.anchor}; otherwise stay silent.`;
}

function pendingRows(file: string, agentId: string): StoredTarget[] {
  return load(file).targets.filter((row) => row.agent_id === agentId && row.status === "pending")
    .sort((left, right) => right.observed_at.localeCompare(left.observed_at));
}

export function hasPendingInboxAuditTargets(file: string, agentId: string): boolean {
  return pendingRows(file, agentId).length > 0;
}

/** Content-free, bounded pending audit work list. Completed/reported targets are omitted. */
export function readInboxAuditTargets(file: string, agentId: string): {
  version: 1;
  targets: Array<InboxAuditTarget & { instruction: string }>;
  has_more: boolean;
  no_finding: "stay_silent";
} {
  const rows = pendingRows(file, agentId);
  return {
    version: 1,
    targets: rows.slice(0, MAX_INBOX_AUDIT_TARGETS).map(({
      agent_id: _agentId, status: _status, completed_at: _completedAt, completed_anchor: _completedAnchor, ...target
    }) => ({ ...target, instruction: instruction(target) })),
    has_more: rows.length > MAX_INBOX_AUDIT_TARGETS,
    no_finding: "stay_silent",
  };
}

/** Mark currently pending targets for this Agent as completed so later audits do not repeat them. */
export function completeInboxAuditTargets(file: string, agentId: string, now = new Date()): number {
  const registry = load(file);
  const completed_at = now.toISOString();
  let count = 0;
  for (const row of registry.targets) {
    if (row.agent_id !== agentId || row.status !== "pending") continue;
    row.status = "completed";
    row.completed_at = completed_at;
    row.completed_anchor = row.anchor;
    count += 1;
  }
  if (count) save(file, registry);
  return count;
}
