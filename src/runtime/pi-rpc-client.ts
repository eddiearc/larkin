interface PiRpcWritable {
  destroyed?: boolean;
  write(data: string, callback?: (error?: Error | null) => void): boolean;
  end?(): void;
}

interface PiRpcReadable extends NodeJS.ReadableStream {}

export interface PiRpcProcess {
  stdin: PiRpcWritable | null;
  stdout: PiRpcReadable | null;
  stderr: PiRpcReadable | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

interface PendingRequest {
  command: string;
  timer?: NodeJS.Timeout;
  startedAt: number;
  absoluteDeadlineAt?: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface PiRpcClientOptions {
  requestTimeoutMs?: number;
  inputTimeoutMs?: number;
  inputProgressTimeoutMs?: number;
  inputMaxTimeoutMs?: number;
  maxFrameBytes?: number;
  maxStderrBytes?: number;
  shutdownGraceMs?: number;
}

type RpcObject = Record<string, any>;

/** A strict, bounded LF-delimited client for Pi's public RPC protocol. */
export class PiRpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: RpcObject) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private readonly requestTimeoutMs: number;
  private readonly inputTimeoutMs: number;
  private readonly inputProgressTimeoutMs: number;
  private readonly inputMaxTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxStderrBytes: number;
  private readonly shutdownGraceMs: number;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrBuffer = Buffer.alloc(0);
  private exited = false;
  private nextId = 0;
  private failed: Error | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly process: PiRpcProcess, options: PiRpcClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.inputTimeoutMs = options.inputTimeoutMs ?? 120_000;
    this.inputProgressTimeoutMs = options.inputProgressTimeoutMs ?? 300_000;
    this.inputMaxTimeoutMs = options.inputMaxTimeoutMs ?? 600_000;
    if (this.requestTimeoutMs <= 0 || this.inputTimeoutMs <= 0 || this.inputProgressTimeoutMs <= 0
      || this.inputMaxTimeoutMs < this.inputTimeoutMs) throw new Error("Pi RPC timeout options are invalid");
    this.maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
    this.maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
    process.stdout?.on("data", (chunk) => this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    process.stdout?.on("end", () => {
      if (this.stdoutBuffer.length) this.protocolFailure("unterminated final frame");
    });
    process.stderr?.on("data", (chunk) => {
      if (this.stderrBuffer.length >= this.maxStderrBytes) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      this.stderrBuffer = Buffer.concat([this.stderrBuffer, value.subarray(0, this.maxStderrBytes - this.stderrBuffer.length)]);
    });
    process.once("error", (error) => this.fail(new Error(`Pi RPC process failed: ${error.message}`), true));
    process.once("exit", (code, signal) => {
      this.exited = true;
      const stderr = this.stderrBuffer.toString("utf8").trim().slice(0, 2_000);
      this.fail(new Error(`Pi RPC process exited (${code ?? signal ?? "unknown"})${stderr ? `: ${stderr}` : ""}`), false);
    });
  }

  subscribe(listener: (event: RpcObject) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  subscribeFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    if (this.failed) queueMicrotask(() => listener(this.failed!));
    return () => this.failureListeners.delete(listener);
  }

  request<T = unknown>(command: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (this.failed) return Promise.reject(this.failed);
    const id = `larkin-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const startedAt = Date.now();
      const input = isInputCommand(command);
      const pending: PendingRequest = {
        command, startedAt,
        ...(input ? { absoluteDeadlineAt: startedAt + this.inputMaxTimeoutMs } : {}),
        resolve: resolve as (value: unknown) => void, reject,
      };
      this.pending.set(id, pending);
      this.armTimeout(id, pending, input ? this.inputTimeoutMs : this.requestTimeoutMs);
      try {
        if (!this.process.stdin || this.process.stdin.destroyed) throw new Error("stdin is unavailable");
        this.process.stdin.write(`${JSON.stringify({ id, type: command, ...fields })}\n`, (error) => {
          if (error) this.fail(new Error(`Pi RPC ${command} write failed: ${error.message}`), true);
        });
      } catch (error) {
        this.fail(new Error(`Pi RPC ${command} write failed: ${error instanceof Error ? error.message : String(error)}`), true);
      }
    });
  }

  notify(command: string, fields: Record<string, unknown> = {}): void {
    if (this.failed || !this.process.stdin || this.process.stdin.destroyed) return;
    this.process.stdin.write(`${JSON.stringify({ type: command, ...fields })}\n`);
  }

  close(): Promise<void> {
    if (!this.failed) this.fail(new Error("Pi RPC client closed"), true);
    return this.beginShutdown();
  }

  private consume(chunk: Buffer): void {
    if (this.failed) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.stdoutBuffer.length > this.maxFrameBytes) this.protocolFailure(`frame exceeds ${this.maxFrameBytes} bytes`);
        return;
      }
      if (newline > this.maxFrameBytes) {
        this.protocolFailure(`frame exceeds ${this.maxFrameBytes} bytes`);
        return;
      }
      let frame = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
      if (!frame.length) { this.protocolFailure("empty frame"); return; }
      let message: RpcObject;
      try {
        const parsed = JSON.parse(frame.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("frame is not an object");
        message = parsed;
      } catch (error) {
        this.protocolFailure(`malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      this.dispatch(message);
      if (this.failed) return;
    }
  }

  private dispatch(message: RpcObject): void {
    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) { this.protocolFailure(`unexpected response id ${message.id}`); return; }
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.command !== pending.command) {
        pending.reject(new Error(`Pi RPC protocol error: response command ${String(message.command)} does not match ${pending.command}`));
        this.fail(new Error("Pi RPC protocol error: mismatched response command"), true);
      } else if (message.success === true) pending.resolve(message.data);
      else pending.reject(new Error(`Pi RPC ${pending.command} failed: ${String(message.error || "unknown error")}`));
      return;
    }
    if (isInputProgress(message)) this.refreshInputDeadlines(message.type);
    for (const listener of this.eventListeners) listener(message);
  }

  private refreshInputDeadlines(eventType: string): void {
    const graceMs = eventType === "compaction_start" || eventType.startsWith("summarization_retry_")
      || eventType === "auto_retry_start" ? this.inputProgressTimeoutMs : this.inputTimeoutMs;
    for (const [id, pending] of this.pending) {
      if (!isInputCommand(pending.command)) continue;
      this.armTimeout(id, pending, graceMs);
    }
  }

  private armTimeout(id: string, pending: PendingRequest, requestedMs: number): void {
    if (pending.timer) clearTimeout(pending.timer);
    const now = Date.now();
    const absoluteRemaining = pending.absoluteDeadlineAt === undefined ? requestedMs : pending.absoluteDeadlineAt - now;
    const delay = Math.max(0, Math.min(requestedMs, absoluteRemaining));
    pending.timer = setTimeout(() => {
      if (!this.pending.has(id)) return;
      const elapsed = Date.now() - pending.startedAt;
      const absolute = pending.absoluteDeadlineAt !== undefined && Date.now() >= pending.absoluteDeadlineAt;
      const error = isInputCommand(pending.command)
        ? new Error(absolute
          ? `Pi RPC ${pending.command} preflight timed out at absolute ${this.inputMaxTimeoutMs}ms limit`
          : `Pi RPC ${pending.command} preflight timed out after ${elapsed}ms without progress`)
        : new Error(`Pi RPC ${pending.command} timed out after ${this.requestTimeoutMs}ms`);
      this.fail(error, true);
    }, delay);
    pending.timer.unref?.();
  }

  private protocolFailure(detail: string): void {
    this.fail(new Error(`Pi RPC protocol error: ${detail}`), true);
  }

  private fail(error: Error, terminate: boolean): void {
    if (this.failed) return;
    this.failed = error;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.failureListeners) listener(error);
    if (terminate) void this.beginShutdown();
  }

  private beginShutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.exited) return Promise.resolve();
    this.shutdownPromise = new Promise<void>((resolve) => {
      let settled = false;
      let forceTimer: NodeJS.Timeout | null = null;
      let hardTimer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (hardTimer) clearTimeout(hardTimer);
        resolve();
      };
      this.process.once("exit", finish);
      this.process.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        if (this.exited) { finish(); return; }
        this.process.kill("SIGKILL");
        // A real child emits exit after SIGKILL. Keep a final bound for broken
        // process doubles/platform failures without creating a second shutdown path.
        hardTimer = setTimeout(finish, this.shutdownGraceMs);
        hardTimer.unref?.();
      }, this.shutdownGraceMs);
      forceTimer.unref?.();
    });
    return this.shutdownPromise;
  }
}

const INPUT_COMMANDS = new Set(["prompt", "steer", "follow_up"]);
const INPUT_PROGRESS_EVENTS = new Set([
  "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end",
  "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
]);
const isInputCommand = (command: string): boolean => INPUT_COMMANDS.has(command);
const isInputProgress = (message: RpcObject): boolean => typeof message.type === "string" && INPUT_PROGRESS_EVENTS.has(message.type);
