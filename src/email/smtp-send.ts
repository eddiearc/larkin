/**
 * SMTP 发信（Phase 1：nodemailer + 标准 SMTP）。
 * Message-ID 由幂等 key 确定性生成：同一意图重试产生同一 Message-ID，
 * 配合本地发送备忘实现重复发送防护（SMTP 协议本身无服务端去重）。
 */
import { createHash } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import type { EmailAccountConfig } from "./email-types.js";
import { validEmailAddress } from "./email-types.js";

export interface EmailSendRequest {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** 回复的上一封邮件 Message-ID（无尖括号） */
  inReplyTo?: string;
  references?: readonly string[];
  /** 调用方提供的幂等 key；为空时按内容派生 */
  idempotencyKey?: string;
  attachments?: { filename: string; content: Buffer | string; contentType?: string }[];
}

export interface EmailSendResult {
  ok: true;
  messageId: string;
  duplicate: boolean;
}

export interface SmtpSendDependencies {
  createTransport?: typeof nodemailer.createTransport;
  now?: () => Date;
}

function mimeMessageId(intentDigest: string, domain: string): string {
  const safeDomain = domain.replace(/[^a-zA-Z0-9.-]/g, "") || "larkin.local";
  return `${intentDigest}@${safeDomain}`;
}

function headerId(messageId: string): string {
  return `<${messageId}>`;
}

/** 从发件地址提取用于 Message-ID 的域名部分 */
export function emailDomainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) : "larkin.local";
}

/**
 * 发送邮件并返回最终 Message-ID。
 * duplicate 由调用方备忘判断传入（duplicate: true 时跳过真实发送）。
 */
export async function sendEmail(
  account: EmailAccountConfig,
  request: EmailSendRequest,
  dependencies: SmtpSendDependencies = {},
): Promise<EmailSendResult> {
  if (!validEmailAddress(account.address)) throw new Error("email send: 发件地址不合法");
  if (!validEmailAddress(request.to)) throw new Error("email send: 收件地址不合法");
  if (!request.subject.trim()) throw new Error("email send: 主题不能为空");
  if (!request.text.trim() && !(request.html || "").trim()) throw new Error("email send: 正文不能为空");

  const intent = request.idempotencyKey
    ?? createHash("sha256").update(JSON.stringify([account.address, request.to, request.inReplyTo ?? "", request.subject, request.text])).digest("hex").slice(0, 32);
  const digest = createHash("sha256").update(intent).digest("hex").slice(0, 24);
  const messageId = mimeMessageId(digest, emailDomainOf(account.address));
  const references = [...new Set([...(request.references ?? []), ...(request.inReplyTo ? [request.inReplyTo] : [])])];

  const createTransport = dependencies.createTransport ?? nodemailer.createTransport;
  const transport: Transporter = createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.tls && account.smtp.port === 465,
    requireTLS: account.smtp.tls && account.smtp.port !== 465,
    auth: { user: account.smtp.user, pass: account.smtp.password },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({
      from: account.address,
      to: request.to,
      subject: request.subject,
      text: request.text,
      ...(request.html ? { html: request.html } : {}),
      ...(request.attachments?.length ? {
        attachments: request.attachments.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
        })),
      } : {}),
      headers: {
        "Message-ID": headerId(messageId),
        "X-Larkin-Agent": "1",
        ...(request.inReplyTo ? { "In-Reply-To": headerId(request.inReplyTo) } : {}),
        ...(references.length ? { References: references.map(headerId).join(" ") } : {}),
      },
    });
    return { ok: true, messageId, duplicate: false };
  } finally {
    transport.close();
  }
}
