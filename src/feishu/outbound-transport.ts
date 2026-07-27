import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface LarkResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ReplyContext {
  in_topic?: boolean;
  reply_to?: string;
  [key: string]: unknown;
}

export interface StagedAttachment {
  file: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

interface UploadFile {
  name?: string;
  type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface MultipartForm {
  get(name: string): unknown;
}

interface NodeError extends Error { code?: string }

interface OutboundOptions {
  attachmentDir: string;
  attachmentIndexFile: string;
  resolveChatId(target: unknown): string;
  replyContextFor(key: string): ReplyContext | null;
  sendText(chatId: string, content: string, idempotencyKey: unknown): LarkResult;
  replyText(messageId: string, content: string, idempotencyKey: unknown, chatId: string): LarkResult;
  sendMedia(chatId: string, replyContext: ReplyContext | null, attachment: StagedAttachment, idempotencyKey: string): LarkResult;
  appendConversation(item: Record<string, unknown>): void;
  botDisplayName(): string | null | undefined;
  agentName: string;
  dryRun: boolean;
  log(...args: unknown[]): void;
}

export function createOutboundTransport(options: OutboundOptions) {
  const stateRoot = path.resolve(path.dirname(options.attachmentIndexFile));
  const attachmentDir = path.resolve(options.attachmentDir);
  if (path.dirname(attachmentDir) !== stateRoot) throw new Error("attachment directory must be an Agent-state child");

  const rejectSymlink = (target: string): void => {
    try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`attachment path must not be a symlink: ${target}`); }
    catch (error) { if ((error as NodeError).code !== "ENOENT") throw error; }
  };
  const ensureAttachmentDirectory = (): void => {
    rejectSymlink(stateRoot);
    rejectSymlink(attachmentDir);
    fs.mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(attachmentDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("attachment directory security attributes are invalid");
    }
    fs.chmodSync(attachmentDir, 0o700);
  };
  const withIndexLock = <T>(operation: () => T): T => {
    const lock = `${options.attachmentIndexFile}.lock`;
    const deadline = Date.now() + 2_000;
    for (;;) {
      try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeError).code !== "EEXIST") throw error;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmdirSync(lock); continue; }
        } catch { /* another process may be reclaiming the stale lock */ }
        if (Date.now() > deadline) throw new Error("attachment index lock timeout");
        const until = Date.now() + 15;
        while (Date.now() < until) { /* bounded synchronous cross-process lock */ }
      }
    }
    try { return operation(); }
    finally { try { fs.rmdirSync(lock); } catch { /* crash recovery reclaims stale locks */ } }
  };
  const loadAttachmentIndex = (): Record<string, StagedAttachment> => {
    try {
      rejectSymlink(options.attachmentIndexFile);
      return JSON.parse(fs.readFileSync(options.attachmentIndexFile, "utf8")) as Record<string, StagedAttachment>;
    }
    catch { return {}; }
  };
  const saveAttachmentIndex = (index: Record<string, StagedAttachment>): void => {
    if (!options.attachmentIndexFile) return;
    rejectSymlink(options.attachmentIndexFile);
    const temporary = `${options.attachmentIndexFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(index)}\n`);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, options.attachmentIndexFile);
      fs.chmodSync(options.attachmentIndexFile, 0o600);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeError).code !== "ENOENT") throw error; }
    }
  };

  const stageUpload = async (form: MultipartForm | null | undefined) => {
    const candidate = form && typeof form.get === "function" ? form.get("file") : null;
    const file = candidate as UploadFile | null;
    if (!file || typeof file.arrayBuffer !== "function") return { ok: false, status: 400, error: "multipart 缺少 file 字段" };
    const buffer = Buffer.from(await file.arrayBuffer());
    const filename = String(file.name || form?.get("filename") || "upload.bin");
    const mimeType = String(form?.get("mimeType") || file.type || "application/octet-stream");
    const id = `att_${crypto.createHash("sha256").update(buffer).update(filename).digest("hex").slice(0, 20)}`;
    try { ensureAttachmentDirectory(); }
    catch (error) { return { ok: false, status: 500, error: `附件目录不安全: ${(error as Error).message}` }; }
    const safe = filename.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "file.bin";
    const stored = `${id}__${safe}`;
    const destination = path.join(attachmentDir, stored);
    const temporary = path.join(attachmentDir, `.${id}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      rejectSymlink(destination);
      fs.writeFileSync(temporary, buffer, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, destination);
      fs.chmodSync(destination, 0o600);
    }
    catch (error) { return { ok: false, status: 500, error: `附件落盘失败: ${(error as Error).message}` };
    }
    finally { try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeError).code !== "ENOENT") throw error; } }
    try {
      withIndexLock(() => {
        const index = loadAttachmentIndex();
        index[id] = { file: stored, filename, mimeType, sizeBytes: buffer.length };
        saveAttachmentIndex(index);
      });
    } catch (error) {
      return { ok: false, status: 500, error: `附件索引写入失败: ${(error as Error).message}` };
    }
    options.log(`attachment staged id=${id} name=${filename} bytes=${buffer.length}`);
    return { ok: true, status: 200, data: { id, filename, mimeType, sizeBytes: buffer.length, thumbnailUrl: null } };
  };

  const handleSend = (body: Record<string, unknown>) => {
    const target = body.target || "";
    const content = String(body.content ?? "").replace(/\n+$/, "");
    const chatId = options.resolveChatId(target);
    if (!chatId) {
      return { ok: false, status: 400, error: `该 target 没有已知 chat_id：${JSON.stringify(target)}。只能回复 canonical Inbox 给出的确切会话；不会兜底发往默认群。` };
    }
    const idempotencyKey = body.idempotencyKey
      || crypto.createHash("sha256").update(`${String(target)}\0${content}`).digest("hex").slice(0, 32);
    const replyContext = options.replyContextFor(String(target)) || options.replyContextFor(chatId);
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter(Boolean) : [];
    let messageId = "sent";

    if (content !== "" || attachmentIds.length === 0) {
      const replyInThread = Boolean(replyContext?.in_topic && replyContext.reply_to);
      const result = replyInThread
        ? options.replyText(replyContext!.reply_to!, content, idempotencyKey, chatId)
        : options.sendText(chatId, content, idempotencyKey);
      if (result.code !== 0) {
        options.log("send 失败 FULL:", `${result.stdout || ""} || ${result.stderr || ""}`);
        return { ok: false, status: 502, error: `lark-cli send failed: ${(result.stdout || result.stderr || "").trim().split("\n")[0]}` };
      }
      try {
        const parsed = JSON.parse(result.stdout) as { data?: { message_id?: string }; message_id?: string };
        messageId = parsed?.data?.message_id || parsed?.message_id || (options.dryRun ? "dryrun" : "sent");
      } catch { messageId = options.dryRun ? "dryrun" : "sent"; }
      options.log(`${replyInThread ? "reply-in-thread" : "send"} → chat=${chatId} len=${content.length} id=${messageId}${options.dryRun ? " (dry-run)" : ""}`);
    }

    if (attachmentIds.length) {
      const index = loadAttachmentIndex();
      for (let position = 0; position < attachmentIds.length; position += 1) {
        const attachmentId = String(attachmentIds[position]);
        const attachment = index[attachmentId];
        if (!attachment) {
          options.log(`attachment 未找到 id=${attachmentId}（跳过）`);
          continue;
        }
        const result = options.sendMedia(chatId, replyContext, attachment, `${idempotencyKey}:a${position}`);
        if (result.code !== 0) {
          options.log("attachment 发送失败 FULL:", `${result.stdout || ""} || ${result.stderr || ""}`);
          return { ok: false, status: 502, error: `lark-cli 发送附件失败: ${(result.stdout || result.stderr || "").trim().split("\n")[0]}` };
        }
        try {
          const parsed = JSON.parse(result.stdout) as { data?: { message_id?: string } };
          messageId = parsed?.data?.message_id || messageId;
        } catch { /* retain prior message id */ }
        options.log(`attach → chat=${chatId} name=${attachment.filename} id=${messageId}${options.dryRun ? " (dry-run)" : ""}`);
      }
    }

    options.appendConversation({
      direction: "out",
      from: options.botDisplayName() || options.agentName,
      senderType: "agent",
      target,
      wake: false,
      text: content || `[发送了 ${attachmentIds.length} 个附件]`,
      messageId,
      at: new Date().toISOString(),
    });
    return { ok: true, status: 200, data: { ok: true, state: "sent", messageId, messageSeq: 1 } };
  };

  return { handleSend, stageUpload };
}
