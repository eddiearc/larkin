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

function parseTaskNotificationBlock(block: string): CanonicalPiSubagentNotificationBlock | null {
  const taskId = extractTag(block, "task-id");
  const status = extractTag(block, "status");
  const summary = extractTag(block, "summary");
  const result = extractTag(block, "result");
  if (!taskId || !status || !summary || !result) return null;
  if (status !== "Done") return null;
  if (!/completed\b/i.test(summary)) return null;
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
  const notifications = blocks.map((block) => parseTaskNotificationBlock(block));
  if (notifications.some((notification) => notification === null)) return null;
  const canonical = notifications as CanonicalPiSubagentNotificationBlock[];
  const taskIds = canonical.map((notification) => notification.taskId);
  if (taskIds.some((taskId) => !taskId)) return null;
  return { taskIds, notifications: canonical, content, key: taskIds.join("|") };
}

function collectCandidateContents(node: unknown, found = new Set<string>()): string[] {
  const candidates: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      if (!found.has(value)) { found.add(value); candidates.push(value); }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.customType === "string" && typeof record.content === "string") visit(record.content);
    if (typeof record.content === "string") visit(record.content);
    else if (Array.isArray(record.content)) visit(record.content);
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
  for (const content of collectCandidateContents(messages)) {
    const parsed = parseCanonicalNotificationContent(content);
    if (parsed) return parsed;
  }
  return null;
}

export function extractCanonicalPiSubagentCompletionKeyFromMessages(messages: unknown): string | null {
  return extractCanonicalPiSubagentNotification(messages)?.key ?? null;
}
