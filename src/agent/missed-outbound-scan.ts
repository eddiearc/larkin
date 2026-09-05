import * as fs from "node:fs";
import * as path from "node:path";

/**
 * #169's host-owned heartbeat no longer creates per-target missed-outbound loops.
 * Pre-v0.4.21 records have no unique ownership marker and can collide exactly
 * with user reminders, so existing indistinguishable loops are never migrated
 * or deleted automatically.
 */
export const INBOX_AUDIT_LEGACY_MIGRATION_NON_GOAL = "New versions no longer create missed-outbound loops; existing indistinguishable historical loops are not migrated or deleted automatically.";
// Audits return every retained target. Storage remains bounded so a heartbeat
// cannot accumulate an unbounded work list.
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

interface StoredTarget extends InboxAuditTarget { agent_id: string }
interface AuditRegistry { version: 1; targets: StoredTarget[] }

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

function load(file: string): AuditRegistry {
  let value: Partial<AuditRegistry>;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AuditRegistry>; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, targets: [] };
    throw error;
  }
  if (value?.version !== 1 || !Array.isArray(value.targets)) return { version: 1, targets: [] };
  return { version: 1, targets: value.targets.flatMap((row): StoredTarget[] => {
    if (!row || typeof row !== "object") return [];
    const candidate = row as Partial<StoredTarget>;
    if (typeof candidate.target !== "string" || typeof candidate.anchor !== "string") return [];
    const parsed = parseTarget({
      chat_id: candidate.target.startsWith("chat:") ? candidate.target.slice(5) : candidate.target.split(":")[1],
      thread_id: candidate.target.startsWith("thread:") ? candidate.target.split(":")[2] : null,
      message_id: candidate.anchor,
    });
    return typeof candidate.agent_id === "string" && candidate.agent_id && parsed && candidate.target === parsed.target
      && typeof candidate.observed_at === "string" && Number.isFinite(Date.parse(candidate.observed_at))
      ? [{ agent_id: candidate.agent_id, ...parsed, observed_at: candidate.observed_at }] : [];
  }) };
}

function save(file: string, registry: AuditRegistry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

/** Record only an originally wake-eligible authoritative human group/topic source. */
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
  const observed_at = now.toISOString();
  registry.targets = registry.targets.filter((row) => row.agent_id !== agentId || row.target !== parsed.target);
  registry.targets.unshift({ agent_id: agentId, ...parsed, observed_at });
  registry.targets = registry.targets.slice(0, MAX_STORED_TARGETS);
  save(file, registry);
  return true;
}

export function hasInboxAuditTargets(file: string, agentId: string): boolean {
  return load(file).targets.some((row) => row.agent_id === agentId);
}

function instruction(target: InboxAuditTarget): string {
  const history = target.target.startsWith("thread:")
    ? "Use larkin im +threads-messages-list for this exact thread."
    : "Use larkin im +chat-messages-list for this exact chat.";
  return `${history} If a real missed outbound finding requires a response, use the existing guarded larkin im reply path anchored at ${target.anchor}; otherwise stay silent.`;
}

/** Content-free, bounded audit work list consumed by the Agent CLI. */
export function readInboxAuditTargets(file: string, agentId: string): {
  version: 1;
  targets: Array<InboxAuditTarget & { instruction: string }>;
  has_more: boolean;
  no_finding: "stay_silent";
} {
  const rows = load(file).targets.filter((row) => row.agent_id === agentId)
    .sort((left, right) => right.observed_at.localeCompare(left.observed_at));
  return {
    version: 1,
    targets: rows.slice(0, MAX_INBOX_AUDIT_TARGETS).map(({ agent_id: _agentId, ...target }) => ({ ...target, instruction: instruction(target) })),
    has_more: rows.length > MAX_INBOX_AUDIT_TARGETS,
    no_finding: "stay_silent",
  };
}
