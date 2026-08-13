/**
 * 每 Agent 邮件通道生命周期管理（Phase 1）：
 * 入站信封与 Feishu IM 同构（kind:"email"、target `email:<address>`），
 * wake 策略：收件人包含 bot 邮箱地址即唤醒（发信人可配置白名单）。
 */
import { createHash } from "node:crypto";
import { createImapSource, type ImapSource } from "./imap-source.js";
import { sendEmail, type EmailSendRequest, type EmailSendResult } from "./smtp-send.js";
import type { EmailAccountConfig, EmailInboundEvent } from "./email-types.js";
import { validEmailAddress } from "./email-types.js";

export interface EmailAgent {
  agentId: string;
  name: string;
  email: EmailAccountConfig;
  stateDir: string;
}

export interface EmailInboundEnvelope {
  kind: "email";
  target: string;
  message_id: string;
  thread_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  create_time: string;
  email_message_id: string;
  email_references: string[];
  subject: string;
  to_addresses: string[];
}

export interface EmailStateStore {
  readImapState(): { uidValidity: string | null; lastUid: number };
  writeImapState(value: { uidValidity: string | null; lastUid: number }): void;
  readReplyMemo(): Record<string, { digest: string; messageId: string; at: string }>;
  writeReplyMemo(value: Record<string, { digest: string; messageId: string; at: string }>): void;
}

export interface EmailSourceOptions {
  onMessage(agent: EmailAgent, envelope: EmailInboundEnvelope, options: { wake: boolean }): void | Promise<void>;
  onError?(agent: EmailAgent, error: Error): void;
  log?: (...parts: unknown[]) => void;
  now?: () => Date;
  allowlist?: (agentId: string) => string[];
}

export function emailMessageId(messageId: string): string {
  return `em_${createHash("sha256").update(messageId).digest("hex").slice(0, 32)}`;
}

export function emailTarget(address: string): string {
  return `email:${address}`;
}

export function emailAddressesMatch(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US");
}

export interface EmailChannelHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(request: EmailSendRequest): Promise<EmailSendResult>;
  pollOnce(): Promise<number>;
}

export function createEmailChannel(
  agent: EmailAgent,
  stateStore: EmailStateStore,
  options: EmailSourceOptions,
): EmailChannelHandle {
  const log = options.log ?? (() => {});
  if (!validEmailAddress(agent.email.address)) throw new Error(`email channel: 非法 bot 邮箱地址 ${agent.email.address}`);

  let source: ImapSource | null = null;

  const wakeFor = (event: EmailInboundEvent): boolean => {
    const allowlist = options.allowlist?.(agent.agentId) ?? [];
    const recipientMatch = event.toAddresses.some((address) => emailAddressesMatch(address, agent.email.address));
    if (!recipientMatch) return false;
    if (allowlist.length > 0 && !allowlist.some((address) => emailAddressesMatch(address, event.sender.address))) {
      log(`email 白名单未命中，不唤醒 agent=${agent.name} sender=${event.sender.address}`);
      return false;
    }
    return true;
  };

  const envelopeFor = (event: EmailInboundEvent, wake: boolean): EmailInboundEnvelope => ({
    kind: "email",
    target: emailTarget(agent.email.address),
    message_id: emailMessageId(event.messageId),
    thread_id: event.threadId,
    sender_id: event.sender.address,
    sender_name: event.sender.name || event.sender.address,
    content: `${event.subject}\n\n${event.textBody}`,
    create_time: event.receivedAt,
    email_message_id: event.messageId,
    email_references: event.references,
    subject: event.subject,
    to_addresses: event.toAddresses,
  });

  return {
    async start(): Promise<void> {
      source = createImapSource({
        account: agent.email,
        store: {
          read: () => stateStore.readImapState(),
          write: (value) => stateStore.writeImapState(value),
        },
        now: options.now,
        log,
        onError: (error) => options.onError?.(agent, error),
        onMessage: async (event) => {
          const wake = wakeFor(event);
          await options.onMessage(agent, envelopeFor(event, wake), { wake });
        },
      });
      log(`email 通道启动 agent=${agent.name} address=${agent.email.address}`);
      await source.start();
    },

    async stop(): Promise<void> {
      await source?.stop();
      source = null;
    },

    async send(request: EmailSendRequest): Promise<EmailSendResult> {
      return sendEmail(agent.email, request);
    },

    async pollOnce(): Promise<number> {
      return source ? source.pollOnce() : 0;
    },
  };
}
