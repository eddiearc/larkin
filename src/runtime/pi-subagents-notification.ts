export interface CanonicalPiSubagentNotificationOptions {
  taskId: string;
  toolUseId?: string;
  outputFile?: string;
  status?: string;
  summary?: string;
  result?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface CanonicalPiSubagentNotificationBlock {
  taskId: string;
  toolUseId?: string;
  outputFile?: string;
  status: string;
  summary: string;
  result: string;
}

export interface CanonicalPiSubagentNotification {
  taskIds: string[];
  notifications: CanonicalPiSubagentNotificationBlock[];
  content: string;
  key: string;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function extractTag(content: string, tagName: string): string | null {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`).exec(content);
  return match ? match[1].trim() : null;
}

/**
 * Pi subagents emit terminal <status> as Done or a display label
 * (Error: ..., Aborted (...), Stopped, Wrapped up (turn limit)).
 * Raw tokens completed/error/aborted/stopped/steered/turn-limit are also accepted.
 */
const TERMINAL_STATUS_TOKENS = new Set([
  "done",
  "completed",
  "error",
  "aborted",
  "stopped",
  "steered",
  "turn-limit",
  "turn_limit",
]);

export function isCanonicalTerminalPiSubagentStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  if (!normalized) return false;
  if (TERMINAL_STATUS_TOKENS.has(normalized)) return true;
  if (normalized.startsWith("error:") || normalized.startsWith("error ")) return true;
  if (normalized.startsWith("aborted")) return true;
  if (normalized.startsWith("stopped")) return true;
  if (normalized.includes("turn limit") || normalized.includes("turn-limit") || normalized.includes("turn_limit")) {
    return true;
  }
  if (normalized.includes("steered")) return true;
  return false;
}

function parseTaskNotificationBlock(block: string): CanonicalPiSubagentNotificationBlock | null {
  const taskId = extractTag(block, "task-id");
  const status = extractTag(block, "status");
  const summary = extractTag(block, "summary");
  const result = extractTag(block, "result");
  if (!taskId || !status || !summary || !result) return null;
  if (!isCanonicalTerminalPiSubagentStatus(status)) return null;
  return {
    taskId,
    toolUseId: extractTag(block, "tool-use-id") ?? undefined,
    outputFile: extractTag(block, "output-file") ?? undefined,
    status,
    summary,
    result,
  };
}

function parseCanonicalNotificationContent(content: string): CanonicalPiSubagentNotification | null {
  const blocks = [...content.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)]
    .map((match) => match[1]);
  if (blocks.length === 0) return null;
  const seen = new Set<string>();
  const notifications: CanonicalPiSubagentNotificationBlock[] = [];
  for (const block of blocks) {
    const parsed = parseTaskNotificationBlock(block);
    if (!parsed || seen.has(parsed.taskId)) continue;
    seen.add(parsed.taskId);
    notifications.push(parsed);
  }
  if (notifications.length === 0) return null;
  const taskIds = notifications.map((notification) => notification.taskId);
  return { taskIds, notifications, content, key: taskIds.join("|") };
}

function collectCandidateContents(node: unknown, found = new Set<string>()): string[] {
  const candidates: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.customType === "subagent-notification" && typeof record.content === "string") {
      if (!found.has(record.content)) { found.add(record.content); candidates.push(record.content); }
    } else if (Array.isArray(record.content)) {
      visit(record.content);
    }
    if (Array.isArray(record.messages)) visit(record.messages);
    if (Array.isArray(record.parts)) visit(record.parts);
  };
  visit(node);
  return candidates;
}

export function buildCanonicalPiSubagentNotificationContent(options: CanonicalPiSubagentNotificationOptions): string {
  const status = options.status ?? "Done";
  const summary = options.summary ?? `Agent ${JSON.stringify("Fixture")} completed`;
  const result = options.result ?? "Fixture result.";
  const totalTokens = options.totalTokens ?? 12;
  const toolUses = options.toolUses ?? 1;
  const durationMs = options.durationMs ?? 34;
  return [
    "<task-notification>",
    `<task-id>${escapeXml(options.taskId)}</task-id>`,
    options.toolUseId ? `<tool-use-id>${escapeXml(options.toolUseId)}</tool-use-id>` : null,
    options.outputFile ? `<output-file>${escapeXml(options.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>${escapeXml(summary)}</summary>`,
    `<result>${escapeXml(result)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${toolUses}</tool_uses><duration_ms>${durationMs}</duration_ms></usage>`,
    "</task-notification>",
  ].filter(Boolean).join("\n");
}

export function buildCanonicalPiSubagentAssistantMessage(options: CanonicalPiSubagentNotificationOptions): {
  role: "assistant";
  content: Array<{ type: "custom"; customType: "subagent-notification"; content: string }>;
} {
  return {
    role: "assistant",
    content: [{
      type: "custom",
      customType: "subagent-notification",
      content: buildCanonicalPiSubagentNotificationContent(options),
    }],
  };
}

export function extractCanonicalPiSubagentNotification(messages: unknown): CanonicalPiSubagentNotification | null {
  const seen = new Set<string>();
  const notifications: CanonicalPiSubagentNotificationBlock[] = [];
  const contents: string[] = [];
  for (const content of collectCandidateContents(messages)) {
    const parsed = parseCanonicalNotificationContent(content);
    if (!parsed) continue;
    contents.push(parsed.content);
    for (const notification of parsed.notifications) {
      if (seen.has(notification.taskId)) continue;
      seen.add(notification.taskId);
      notifications.push(notification);
    }
  }
  if (notifications.length === 0) return null;
  const taskIds = notifications.map((notification) => notification.taskId);
  return { taskIds, notifications, content: contents.join("\n"), key: taskIds.join("|") };
}

export function extractCanonicalPiSubagentCompletionKeyFromMessages(messages: unknown): string | null {
  return extractCanonicalPiSubagentNotification(messages)?.key ?? null;
}
