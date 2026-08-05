import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  documentCommentMessageId,
  documentCommentTarget,
  extractDocumentCommentContent,
  parseDocumentCommentTarget,
  projectDocumentCommentEnvelope,
  resolveDocumentCommentContext,
} from "../../../dist/feishu/document-comment.mjs";

const event = (overrides = {}) => ({
  fileToken: "doc_tokenA1", fileType: "docx", commentId: "comment_A1", replyId: "reply_A1",
  operator: { openId: "ou_human" }, mentionedBot: true, timestamp: 1_786_000_000_000,
  raw: { event_id: "evt_comment_A1", notice_type: "add_reply" },
  ...overrides,
});

const fetched = (overrides = {}) => ({
  commentId: "comment_A1", quote: "selected text", isWhole: false,
  replies: [
    { reply_id: "reply_old", content: { elements: [{ type: "text_run", text_run: { text: "old" } }] } },
    { reply_id: "reply_A1", content: { elements: [
      { type: "text_run", text_run: { text: "please inspect " } },
      { type: "docs_link", docs_link: { url: "https://example.test/source" } },
      { type: "person", person: { user_id: "ou_bot" } },
    ] } },
  ],
  ...overrides,
});

test("comment content uses the exact triggering reply and fails closed when it is absent", () => {
  assert.deepEqual(extractDocumentCommentContent(fetched(), "reply_A1"), {
    content: "please inspect https://example.test/source", targetReplyId: "reply_A1",
  });
  assert.equal(extractDocumentCommentContent(fetched(), "reply_missing"), null);
  assert.deepEqual(extractDocumentCommentContent(fetched()), {
    content: "please inspect https://example.test/source", targetReplyId: "reply_A1",
  });
});

test("comment resolution delegates wiki/support decisions to the locked Channel surface", async () => {
  const calls = [];
  const comments = {
    async resolveTarget(token, type) { calls.push(["resolve", token, type]); return { fileToken: "resolved_token", fileType: "docx" }; },
    async fetch(target, id) { calls.push(["fetch", target, id]); return fetched(); },
  };
  const context = await resolveDocumentCommentContext(comments, event());
  assert.deepEqual(calls, [
    ["resolve", "doc_tokenA1", "docx"],
    ["fetch", { fileToken: "resolved_token", fileType: "docx" }, "comment_A1"],
  ]);
  assert.deepEqual(context, {
    target: { fileToken: "resolved_token", fileType: "docx" },
    content: "please inspect https://example.test/source", quote: "selected text", isWhole: false,
    targetReplyId: "reply_A1", noticeType: "add_reply",
  });
  assert.equal(await resolveDocumentCommentContext({ ...comments, async resolveTarget() { return null; } }, event()), null);
});

test("document comment envelope is semantic, stable, wakeable, and carries an exact bound reply recipe", () => {
  const context = {
    target: { fileToken: "resolved_token", fileType: "docx" }, content: "question", quote: "quote",
    isWhole: false, targetReplyId: "reply_A1", noticeType: "add_reply",
  };
  const envelope = projectDocumentCommentEnvelope({
    agentId: "cli_docAgentA1", event: event(), context,
    mentionPolicy: { effective: "require", source: "agent", mentionedBot: true },
  });
  assert.equal(envelope.kind, "document_comment");
  assert.equal(envelope.event_type, "drive.notice.comment_add_v1");
  assert.equal(envelope.wake, true);
  assert.equal(envelope.sender_type, "human");
  assert.deepEqual([envelope.mention_policy, envelope.mention_policy_source, envelope.mentioned_bot], ["require", "agent", true]);
  assert.equal(envelope.target, "document-comment:docx:resolved_token:comment_A1:in-thread");
  assert.deepEqual(envelope.reply.argv, ["comment", "reply", "--message-id", envelope.message_id, "--text", "<reply_text>"]);
  assert.equal(documentCommentMessageId("cli_docAgentA1", event()), envelope.message_id);
  assert.notEqual(documentCommentMessageId("cli_otherAgentA1", event()), envelope.message_id);
  const fallback = projectDocumentCommentEnvelope({
    agentId: "cli_docAgentA1", event: event({ mentionedBot: false }), context: { ...context, isWhole: true },
    mentionPolicy: { effective: "free", source: "global", mentionedBot: false },
  });
  assert.equal(fallback.target, "document-comment:docx:resolved_token:comment_A1:top-level");
  assert.equal(fallback.reply.mode, "top-level-fallback");
  assert.deepEqual([fallback.mention_policy, fallback.mention_policy_source, fallback.mentioned_bot], ["free", "global", false]);
});

test("document comment target parser rejects unsupported types and locator injection", () => {
  const value = documentCommentTarget({ fileToken: "file_token-1", fileType: "sheet" }, "comment_1", true);
  assert.deepEqual(parseDocumentCommentTarget(value), {
    fileToken: "file_token-1", fileType: "sheet", commentId: "comment_1", topLevel: true,
  });
  assert.equal(parseDocumentCommentTarget("document-comment:slide:token:id:in-thread"), null);
  assert.equal(parseDocumentCommentTarget("document-comment:docx:../../token:id:in-thread"), null);
});
