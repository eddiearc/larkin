import { createHash } from "node:crypto";
import type { CommentEvent, CommentTarget, FetchedComment } from "@larksuite/channel";

export const DOCUMENT_COMMENT_EVENT = "drive.notice.comment_add_v1";

export interface DocumentCommentSurface {
  resolveTarget(fileToken: string, fileType: string): Promise<CommentTarget | null>;
  fetch(target: CommentTarget, commentId: string): Promise<FetchedComment | null>;
}

export interface DocumentCommentContext {
  target: CommentTarget;
  content: string;
  quote: string | null;
  isWhole: boolean;
  targetReplyId: string;
  noticeType: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rawEvent(event: CommentEvent): Record<string, unknown> | null {
  return record(event.raw);
}

export function documentCommentEventId(event: CommentEvent): string | null {
  const raw = rawEvent(event);
  const header = record(raw?.header);
  const value = raw?.event_id ?? header?.event_id;
  return typeof value === "string" && value ? value : null;
}

export function documentCommentNoticeType(event: CommentEvent): string {
  const raw = rawEvent(event);
  const meta = record(raw?.notice_meta);
  const value = raw?.notice_type ?? meta?.notice_type;
  return typeof value === "string" && value ? value : event.replyId ? "add_reply" : "add_comment";
}

export function documentCommentMessageId(agentId: string, event: CommentEvent): string {
  // Feishu may redeliver the same semantic notice under a different event_id.
  // The comment locator is the durable identity; event_id remains transport metadata only.
  const stable = [agentId, event.fileType, event.fileToken, event.commentId, event.replyId || "", documentCommentNoticeType(event)];
  return `doc_comment_${createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 32)}`;
}

export function documentCommentTarget(target: CommentTarget, commentId: string, topLevel = false): string {
  return `document-comment:${target.fileType}:${target.fileToken}:${commentId}:${topLevel ? "top-level" : "in-thread"}`;
}

export function parseDocumentCommentTarget(value: string): (CommentTarget & { commentId: string; topLevel: boolean }) | null {
  const match = /^document-comment:(doc|docx|sheet|file):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+):(in-thread|top-level)$/.exec(value);
  return match ? {
    fileType: match[1] as CommentTarget["fileType"], fileToken: match[2], commentId: match[3], topLevel: match[4] === "top-level",
  } : null;
}

export function extractDocumentCommentContent(fetched: FetchedComment, replyId?: string): { content: string; targetReplyId: string } | null {
  const reply = replyId
    ? fetched.replies.find((candidate) => candidate.reply_id === replyId)
    : fetched.replies.at(-1);
  if (!reply?.reply_id) return null;
  const content = (reply.content?.elements ?? []).map((element) => {
    if (element.type === "text_run") return element.text_run?.text ?? "";
    if (element.type === "docs_link") return element.docs_link?.url ?? "";
    return "";
  }).join("").trim();
  return content ? { content, targetReplyId: reply.reply_id } : null;
}

export async function resolveDocumentCommentContext(
  comments: DocumentCommentSurface,
  event: CommentEvent,
): Promise<DocumentCommentContext | null> {
  const target = await comments.resolveTarget(event.fileToken, event.fileType);
  if (!target) return null;
  const fetched = await comments.fetch(target, event.commentId);
  if (!fetched) return null;
  const extracted = extractDocumentCommentContent(fetched, event.replyId);
  if (!extracted) return null;
  return {
    target,
    content: extracted.content,
    quote: fetched.quote?.trim() || null,
    isWhole: fetched.isWhole,
    targetReplyId: extracted.targetReplyId,
    noticeType: documentCommentNoticeType(event),
  };
}

export function projectDocumentCommentEnvelope(input: {
  agentId: string;
  event: CommentEvent;
  context: DocumentCommentContext;
}): Record<string, unknown> {
  const { agentId, event, context } = input;
  const messageId = documentCommentMessageId(agentId, event);
  const timestamp = Number.isFinite(event.timestamp) ? new Date(event.timestamp).toISOString() : new Date().toISOString();
  const target = documentCommentTarget(context.target, event.commentId, context.isWhole);
  return {
    kind: "document_comment",
    event_type: DOCUMENT_COMMENT_EVENT,
    message_id: messageId,
    seq: Number.isSafeInteger(event.timestamp) && event.timestamp > 0 ? event.timestamp : 1,
    target,
    wake: true,
    timestamp,
    sender_id: event.operator.openId,
    sender_name: event.operator.openId,
    sender_type: "human",
    content: context.content,
    quote: context.quote,
    notice_type: context.noticeType,
    file_type: context.target.fileType,
    file_token: context.target.fileToken,
    source_file_type: event.fileType,
    source_file_token: event.fileToken,
    comment_id: event.commentId,
    reply_id: event.replyId ?? null,
    target_reply_id: context.targetReplyId,
    is_whole: context.isWhole,
    reply: {
      command: "comment reply",
      argv: ["comment", "reply", "--message-id", messageId, "--text", "<reply_text>"],
      mode: context.isWhole ? "top-level-fallback" : "in-thread",
      target,
    },
  };
}
