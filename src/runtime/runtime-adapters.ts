import { spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type {
  NormalizedRuntimeEvent,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeId,
  RuntimeInput,
  RuntimeInputResult,
  RuntimeSession,
  RuntimeSessionCreate,
  StandingPrompt,
  UpstreamProviderError,
} from "./runtime-contracts.js";
import { isPiThinkingLevel } from "./pi-model-catalog.js";
import { PiRpcClient, type PiRpcClientOptions } from "./pi-rpc-client.js";
import { internalCommandSpec } from "../app/internal-command.js";
import { piAgentDirectory } from "./pi-provider-config.js";
import {
  classifyRuntimePrerequisite,
  probeNativeRuntimeReadiness,
  providerAuthenticationFailureReadiness,
  RuntimePrerequisiteError,
} from "./runtime-readiness.js";

interface WritableLike {
  destroyed?: boolean;
  write(data: string, callback?: (error?: Error | null) => void): boolean;
  end?(): void;
}

interface ReadableLike extends NodeJS.ReadableStream {}

interface ProcessLike {
  stdin: WritableLike | null;
  stdout: ReadableLike | null;
  stderr: ReadableLike | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface PiSessionProcessLike {
  readonly sessionId?: string | null;
  readonly model?: { provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> };
  readonly thinkingLevel?: string;
  prompt(text: string): Promise<unknown>;
  steer(text: string): Promise<unknown> | unknown;
  abort(): Promise<unknown> | unknown;
  dispose?(): Promise<unknown> | unknown;
  subscribe?(listener: (event: unknown) => void): (() => void) | void;
}

export interface NativeRuntimeAdapterDependencies {
  spawn?: (command: string, args: readonly string[], options: Record<string, unknown>) => ProcessLike;
  createPiSession?: (input: RuntimeSessionCreate) => Promise<PiSessionProcessLike>;
  piRpcClientOptions?: PiRpcClientOptions;
  piCommand?: string;
  codexCommand?: string;
  codexModelOverride?: string;
  spawnCodexUpdate?: (command: string, args: readonly string[], options: Record<string, unknown>) => ProcessLike;
  codexUpdateTimeoutMs?: number;
  codexUpdateKillGraceMs?: number;
  claudeCommand?: string;
  writeFile?: typeof fs.writeFileSync;
  mkdir?: typeof fs.mkdirSync;
  env?: NodeJS.ProcessEnv;
}

type Listener = (event: NormalizedRuntimeEvent) => void;

interface CodexTurnOwnership {
  inputIds: Set<string>;
  terminalInputIds: Set<string>;
  transientKeys: Set<string>;
  configurationTerminal: boolean;
  completedAt: number | null;
  outcome?: { message: string; retryable: boolean; configuration: boolean };
}

abstract class EventSession implements RuntimeSession {
  protected listeners = new Set<Listener>();
  abstract get sessionId(): string | null;
  abstract prompt(input: RuntimeInput): Promise<RuntimeInputResult>;
  abstract busyInput(input: RuntimeInput): Promise<RuntimeInputResult>;
  abstract cancel(reason: string): Promise<void>;
  abstract close(reason: string): Promise<void>;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(event: NormalizedRuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function textInput(input: RuntimeInput): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: input.text }];
}

function writeLine(stdin: WritableLike | null, payload: unknown, inputId: string): Promise<RuntimeInputResult> {
  if (!stdin || stdin.destroyed) return Promise.resolve({ status: "rejected", inputId, retryable: true, reason: "runtime stdin is unavailable" });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RuntimeInputResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      stdin.write(`${JSON.stringify(payload)}\n`, (error) => finish(error
        ? { status: "rejected", inputId, retryable: true, reason: error.message }
        : { status: "accepted", inputId }));
    } catch (error) {
      finish({ status: "rejected", inputId, retryable: true, reason: (error as Error).message });
    }
  });
}

function parseJson(line: string): Record<string, any> | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

function attachLines(stream: ReadableLike | null, listener: (message: Record<string, any>) => void): void {
  if (!stream) return;
  const lines = createInterface({ input: stream });
  lines.on("line", (line) => {
    const message = parseJson(line);
    if (message) listener(message);
  });
}

class CodexSession extends EventSession {
  private requestId = 0;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private readonly turnOwnership = new Map<string, CodexTurnOwnership>();
  private readonly unassignedTurnInputs: string[] = [];
  private readonly recentTurnIds: string[] = [];
  private initialized = false;
  private freshThreadParams: Record<string, unknown> | null = null;
  private resumeFallbackStarted = false;
  private readonly pending = new Map<number, { method: string; inputId?: string; turnId?: string;
    resolve?: (result: RuntimeInputResult) => void }>();

  constructor(private readonly process: ProcessLike, private readonly config: RuntimeSessionCreate) {
    super();
    attachLines(process.stdout, (message) => this.onMessage(message));
    attachLines(process.stderr, (message) => this.onMessage(message));
    process.once("exit", (code, signal) => this.emit({ type: "closed", code, signal }));
    process.once("error", (error) => this.emit({ type: "error", message: `Codex process failed: ${error.message}` }));
    this.request("initialize", { clientInfo: { name: "larkin-runtime", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  }

  get sessionId(): string | null { return this.threadId; }

  async prompt(input: RuntimeInput): Promise<RuntimeInputResult> {
    if (!this.threadId) return { status: "deferred", inputId: input.inputId, reason: "Codex thread is not initialized" };
    return this.sendInput("turn/start", { threadId: this.threadId, input: textInput(input) }, input);
  }

  async busyInput(input: RuntimeInput): Promise<RuntimeInputResult> {
    if (!this.threadId || !this.activeTurnId) return { status: "deferred", inputId: input.inputId, reason: "Codex has no steerable active turn" };
    return this.sendInput("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.activeTurnId,
      input: textInput(input),
    }, input);
  }

  async cancel(_reason: string): Promise<void> {
    if (this.threadId && this.activeTurnId) this.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId });
  }

  async close(_reason: string): Promise<void> { this.process.kill("SIGTERM"); }

  private request(method: string, params: unknown, inputId?: string): number {
    const id = ++this.requestId;
    this.pending.set(id, { method, ...(inputId ? { inputId } : {}) });
    void writeLine(this.process.stdin, { jsonrpc: "2.0", id, method, params }, inputId ?? `request:${id}`);
    return id;
  }

  private sendInput(method: string, params: unknown, input: RuntimeInput): Promise<RuntimeInputResult> {
    if (method === "turn/start") this.unassignedTurnInputs.push(input.inputId);
    const turnId = method === "turn/steer" ? String((params as Record<string, unknown>).expectedTurnId || "") || undefined : undefined;
    return new Promise((resolve) => {
      const id = ++this.requestId;
      this.pending.set(id, { method, inputId: input.inputId, ...(turnId ? { turnId } : {}), resolve });
      void writeLine(this.process.stdin, { jsonrpc: "2.0", id, method, params }, input.inputId).then((result) => {
        if (result.status !== "accepted") {
          this.pending.delete(id);
          if (method === "turn/start") this.removeUnassignedInput(input.inputId);
          resolve(result);
        }
      });
    });
  }

  private onMessage(message: Record<string, any>): void {
    if (message.id != null && typeof message.method === "string" && !Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) {
      void writeLine(this.process.stdin, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported Codex app-server request: ${message.method}` },
      }, `server-request:${message.id}`);
      return;
    }
    if (message.id != null && this.pending.has(Number(message.id))) {
      const pending = this.pending.get(Number(message.id))!;
      this.pending.delete(Number(message.id));
      if (message.error) {
        const errorMessage = String(message.error.message || `${pending.method} failed`);
        const replaceableResumeFailure = pending.method === "thread/resume"
          && /(?:not found|missing|stale|does not exist|unknown (?:session|thread)|rollout)/i.test(errorMessage);
        if (replaceableResumeFailure && this.freshThreadParams && !this.resumeFallbackStarted) {
          this.resumeFallbackStarted = true;
          this.request("thread/start", this.freshThreadParams);
          return;
        }
        if (pending.method === "turn/steer") this.activeTurnId = null;
        if (pending.method === "turn/start" && pending.inputId) this.removeUnassignedInput(pending.inputId);
        pending.resolve?.({ status: "deferred", inputId: pending.inputId || `request:${message.id}`, reason: errorMessage });
        if (pending.inputId) this.emit({ type: "input-error", inputId: pending.inputId, retryable: true, message: errorMessage });
        else this.emit({ type: "error", message: errorMessage });
        return;
      }
      let responseTurnId = pending.turnId;
      if (pending.method === "turn/start" && pending.inputId) {
        responseTurnId = String(message.result?.turn?.id || message.result?.turnId || "") || undefined;
        if (responseTurnId) this.assignTurnInput(responseTurnId, pending.inputId);
      }
      if (pending.method === "turn/steer" && pending.inputId && pending.turnId) {
        this.assignTurnInput(pending.turnId, pending.inputId);
      }
      const responseOwnership = responseTurnId ? this.turnOwnership.get(responseTurnId) : undefined;
      const completedOutcome = responseOwnership?.outcome;
      const lateNormalSteer = pending.method === "turn/steer" && Boolean(responseOwnership?.completedAt) && !completedOutcome;
      const lateSteerReason = "Codex turn ended before steer acceptance";
      if (lateNormalSteer && pending.inputId && responseOwnership) {
        responseOwnership.terminalInputIds.add(pending.inputId);
        this.emit({ type: "input-error", inputId: pending.inputId, retryable: true,
          willRetry: false, message: lateSteerReason });
      }
      if (pending.resolve) pending.resolve(completedOutcome
        ? { status: "rejected", inputId: pending.inputId!, retryable: completedOutcome.retryable, reason: completedOutcome.message }
        : lateNormalSteer
          ? { status: "rejected", inputId: pending.inputId!, retryable: true, reason: lateSteerReason }
          : { status: "accepted", inputId: pending.inputId! });
      if (pending.method === "initialize" && !this.initialized) {
        this.initialized = true;
        void writeLine(this.process.stdin, { jsonrpc: "2.0", method: "initialized", params: {} }, "initialized");
        const threadParams: Record<string, unknown> = {
          cwd: this.config.workspaceDir,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          developerInstructions: this.config.standingPrompt.content,
          experimentalRawEvents: true,
          ...(configuredModel(this.config.model) ? { model: configuredModel(this.config.model) } : {}),
          ...(this.config.reasoningEffort ? { config: { model_reasoning_effort: this.config.reasoningEffort } } : {}),
        };
        this.freshThreadParams = threadParams;
        this.request(this.config.resumeSessionId ? "thread/resume" : "thread/start", this.config.resumeSessionId
          ? { threadId: this.config.resumeSessionId, ...threadParams }
          : threadParams);
      }
      const thread = message.result?.thread;
      if (thread?.id) this.adoptThread(String(thread.id));
      return;
    }
    if (message.method === "thread/started" && message.params?.thread?.id) this.adoptThread(String(message.params.thread.id));
    if (message.method === "turn/started") {
      this.activeTurnId = String(message.params?.turn?.id || "") || null;
      if (this.activeTurnId && !this.turnOwnership.has(this.activeTurnId)) {
        const inputId = this.unassignedTurnInputs.shift();
        if (inputId) this.assignTurnInput(this.activeTurnId, inputId);
      }
      this.emit({ type: "turn-start", ...(this.activeTurnId ? { turnId: this.activeTurnId } : {}) });
    } else if (message.method === "turn/completed") {
      const turnId = String(message.params?.turn?.id || this.activeTurnId || "") || undefined;
      const status = String(message.params?.turn?.status || "completed").toLowerCase();
      const turnError = message.params?.turn?.error;
      const errorMessage = String(turnError?.message || turnError || `Codex turn ${status}`);
      if (turnId && (status === "failed" || status === "interrupted")) {
        this.finishTurnInputs(turnId, errorMessage, status === "interrupted");
      }
      this.activeTurnId = null;
      if (turnId) this.completeTurn(turnId);
      this.emit({ type: "turn-end", ...(this.threadId ? { sessionId: this.threadId } : {}), ...(turnId ? { turnId } : {}) });
    } else if (message.method === "item/agentMessage/delta" && message.params?.delta) {
      this.emit({ type: "activity", activity: "text", text: String(message.params.delta) });
    } else if (message.method === "item/reasoning/summaryTextDelta" && message.params?.delta) {
      this.emit({ type: "activity", activity: "thinking", text: String(message.params.delta) });
    } else if (message.method === "error" || message.method === "codex/event/error") {
      const params = message.params ?? {};
      const detail = params.error ?? {};
      const errorMessage = String(detail.message || params.message || "Codex runtime error");
      const willRetry = params.willRetry === true;
      const errorTurnId = String(params.turnId || params.turn?.id || detail.turnId || this.activeTurnId || "") || null;
      const fatal = params.fatal === true || detail.fatal === true
        || /^(?:transport|process|protocol)(?:_|-)error$/i.test(String(detail.type || detail.kind || ""));
      if (fatal) {
        this.emit({ type: "error", message: errorMessage });
      } else if (errorTurnId) {
        if (willRetry) this.emitTurnInputErrors(errorTurnId, errorMessage, true, true);
        else this.finishTurnInputs(errorTurnId, errorMessage, false);
      } else if (/model requires a newer version of Codex/i.test(errorMessage)) {
        this.activeTurnId = null;
        this.emit({ type: "configuration-error", message: errorMessage });
      } else {
        this.emit({ type: "input-error", retryable: willRetry, willRetry, message: errorMessage });
      }
      this.pruneTurnOwnership();
    }
  }

  private adoptThread(id: string): void {
    if (this.threadId === id) return;
    this.threadId = id;
    this.emit({ type: "session-init", sessionId: id });
  }

  private assignTurnInput(turnId: string, inputId: string): void {
    const ownership = this.ownershipFor(turnId);
    ownership.inputIds.add(inputId);
    this.removeUnassignedInput(inputId);
    if (ownership.outcome && !ownership.terminalInputIds.has(inputId)) {
      if (ownership.outcome.configuration) {
        ownership.terminalInputIds.add(inputId);
      } else {
        ownership.terminalInputIds.add(inputId);
        this.emit({ type: "input-error", inputId, retryable: ownership.outcome.retryable,
          willRetry: false, message: ownership.outcome.message });
      }
    }
  }

  private removeUnassignedInput(inputId: string): void {
    const queued = this.unassignedTurnInputs.indexOf(inputId);
    if (queued >= 0) this.unassignedTurnInputs.splice(queued, 1);
  }

  private ownershipFor(turnId: string): CodexTurnOwnership {
    let ownership = this.turnOwnership.get(turnId);
    if (!ownership) {
      ownership = { inputIds: new Set(), terminalInputIds: new Set(), transientKeys: new Set(),
        configurationTerminal: false, completedAt: null };
      this.turnOwnership.set(turnId, ownership);
    }
    return ownership;
  }

  private emitTurnInputErrors(turnId: string, message: string, retryable: boolean, willRetry: boolean): void {
    const ownership = this.turnOwnership.get(turnId);
    if (!ownership) return;
    for (const inputId of ownership.inputIds) {
      if (ownership.terminalInputIds.has(inputId)) continue;
      const transientKey = `${inputId}\u0000${message}`;
      if (willRetry && ownership.transientKeys.has(transientKey)) continue;
      if (willRetry) ownership.transientKeys.add(transientKey);
      if (!willRetry) ownership.terminalInputIds.add(inputId);
      this.emit({ type: "input-error", inputId, retryable, willRetry, message });
    }
  }

  private finishTurnInputs(turnId: string, message: string, retryable: boolean): void {
    const ownership = this.ownershipFor(turnId);
    const configuration = /model requires a newer version of Codex/i.test(message);
    ownership.outcome = { message, retryable, configuration };
    if (configuration) {
      for (const inputId of ownership.inputIds) ownership.terminalInputIds.add(inputId);
      if (!ownership.configurationTerminal) {
        ownership.configurationTerminal = true;
        this.activeTurnId = null;
        this.emit({ type: "configuration-error", message });
      }
      return;
    }
    this.emitTurnInputErrors(turnId, message, retryable, false);
  }

  private completeTurn(turnId: string): void {
    const ownership = this.ownershipFor(turnId);
    ownership.completedAt = Date.now();
    if (!this.recentTurnIds.includes(turnId)) this.recentTurnIds.push(turnId);
    this.pruneTurnOwnership();
  }

  private pruneTurnOwnership(): void {
    const cutoff = Date.now() - 5 * 60_000;
    while (this.recentTurnIds.length > 64) {
      const oldest = this.recentTurnIds.shift();
      if (oldest) this.turnOwnership.delete(oldest);
    }
    while (this.recentTurnIds.length) {
      const oldest = this.recentTurnIds[0];
      const ownership = this.turnOwnership.get(oldest);
      if (!ownership?.completedAt || ownership.completedAt >= cutoff) break;
      this.recentTurnIds.shift();
      this.turnOwnership.delete(oldest);
    }
  }
}

class ClaudeSession extends EventSession {
  private currentSessionId: string | null;
  private busy = false;
  private safeBoundary = true;
  private readonly gated: Array<{ input: RuntimeInput; resolve: (result: RuntimeInputResult) => void }> = [];

  constructor(private readonly process: ProcessLike, resumeSessionId?: string) {
    super();
    this.currentSessionId = resumeSessionId ?? null;
    attachLines(process.stdout, (message) => this.onMessage(message));
    process.once("exit", (code, signal) => this.emit({ type: "closed", code, signal }));
    process.once("error", (error) => this.emit({ type: "error", message: `Claude process failed: ${error.message}` }));
  }

  get sessionId(): string | null { return this.currentSessionId; }

  async prompt(input: RuntimeInput): Promise<RuntimeInputResult> {
    this.busy = true;
    this.safeBoundary = false;
    return this.writeUser(input);
  }

  async busyInput(input: RuntimeInput): Promise<RuntimeInputResult> {
    if (!this.busy || this.safeBoundary) {
      this.safeBoundary = false;
      return this.writeUser(input);
    }
    return new Promise((resolve) => this.gated.push({ input, resolve }));
  }

  async cancel(_reason: string): Promise<void> { this.process.kill("SIGINT"); }
  async close(_reason: string): Promise<void> { this.process.stdin?.end?.(); this.process.kill("SIGTERM"); }

  private writeUser(input: RuntimeInput): Promise<RuntimeInputResult> {
    return writeLine(this.process.stdin, {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: input.text }] },
      ...(this.currentSessionId ? { session_id: this.currentSessionId } : {}),
    }, input.inputId);
  }

  private onMessage(message: Record<string, any>): void {
    const sessionId = typeof message.session_id === "string" ? message.session_id : null;
    if (sessionId && sessionId !== this.currentSessionId) {
      this.currentSessionId = sessionId;
      this.emit({ type: "session-init", sessionId });
    }
    if (message.type === "assistant") {
      this.safeBoundary = true;
      for (const block of message.message?.content ?? []) {
        if (block.type === "text" && block.text) this.emit({ type: "activity", activity: "text", text: String(block.text) });
        if (block.type === "thinking" && block.thinking) this.emit({ type: "activity", activity: "thinking", text: String(block.thinking) });
        if (block.type === "tool_use") this.emit({ type: "activity", activity: "tool", name: String(block.name || "tool") });
      }
      const next = this.gated.shift();
      if (next) {
        this.safeBoundary = false;
        void this.writeUser(next.input).then(next.resolve);
      }
    } else if (message.type === "stream_event") {
      this.safeBoundary = false;
    } else if (message.type === "result") {
      this.busy = false;
      this.safeBoundary = true;
      if (message.is_error) this.emit({ type: "error", message: String(message.result || message.subtype || "Claude runtime error") });
      this.emit({ type: "turn-end", ...(this.currentSessionId ? { sessionId: this.currentSessionId } : {}) });
      for (const next of this.gated.splice(0)) void this.writeUser(next.input).then(next.resolve);
    } else if (message.type === "system" && message.subtype === "init") {
      this.emit({ type: "turn-start" });
    }
  }
}

class PiSession extends EventSession {
  private readonly unsubscribe?: () => void;
  private readonly ownedInputIds = new Set<string>();
  private readonly awaitingAcknowledgement = new Set<string>();
  private finalAssistantError: PiProviderErrorDetails | null = null;
  private finalAssistantStopReason: string | null = null;
  private requestEpoch = 0;
  private activeEpoch: number | null = null;
  private settleArmedEpoch: number | null = null;
  private readonly inputEpochs = new Map<string, number>();
  private readonly observedSubmitEpochs = new Set<number>();
  private readonly observedAcceptedEpochs = new Set<number>();
  private readonly observedCompletedEpochs = new Set<number>();
  private firstOutputObserved = false;
  private toolCallOpen = false;
  constructor(private readonly sdk: PiSessionProcessLike, private readonly distribution: "builtin" | "external") {
    super();
    const result = sdk.subscribe?.((event) => this.onEvent(event));
    if (typeof result === "function") this.unsubscribe = result;
    if (sdk.sessionId) setImmediate(() => this.emit({
      type: "session-init",
      sessionId: sdk.sessionId!,
      ...(sdk.model ? { model: `${sdk.model.provider}/${sdk.model.id}` } : {}),
      ...(sdk.thinkingLevel ? { reasoningEffort: sdk.thinkingLevel } : {}),
    }));
  }
  get sessionId(): string | null { return this.sdk.sessionId ?? null; }
  get effectiveModel(): string | null { return this.sdk.model ? `${this.sdk.model.provider}/${this.sdk.model.id}` : null; }
  get effectiveReasoningEffort(): string | null { return this.sdk.thinkingLevel ?? null; }
  async prompt(input: RuntimeInput): Promise<RuntimeInputResult> { return this.enqueue(input, () => this.sdk.prompt(input.text)); }
  async busyInput(input: RuntimeInput): Promise<RuntimeInputResult> { return this.enqueue(input, () => this.sdk.steer(input.text)); }
  async cancel(_reason: string): Promise<void> { await this.sdk.abort(); }
  async close(_reason: string): Promise<void> { this.unsubscribe?.(); await this.sdk.dispose?.(); }

  private async enqueue(input: RuntimeInput, operation: () => Promise<unknown> | unknown): Promise<RuntimeInputResult> {
    if (this.ownedInputIds.size === 0) this.requestEpoch += 1;
    const epoch = this.requestEpoch;
    this.ownedInputIds.add(input.inputId);
    this.inputEpochs.set(input.inputId, epoch);
    this.awaitingAcknowledgement.add(input.inputId);
    const ownsRpcObservation = !this.observedSubmitEpochs.has(epoch);
    if (ownsRpcObservation) {
      this.observedSubmitEpochs.add(epoch);
      this.emit({ type: "runtime-observation", runtime: "pi", distribution: this.distribution, phase: "rpc_submit" });
    }
    try {
      await operation();
      this.awaitingAcknowledgement.delete(input.inputId);
      if (ownsRpcObservation && !this.observedAcceptedEpochs.has(epoch)) {
        this.observedAcceptedEpochs.add(epoch);
        this.emit({ type: "runtime-observation", runtime: "pi", distribution: this.distribution, phase: "rpc_accepted" });
      }
      return { status: "accepted", inputId: input.inputId };
    } catch (error) {
      const wasAwaiting = this.awaitingAcknowledgement.has(input.inputId);
      if (ownsRpcObservation && wasAwaiting) this.emit({
        type: "runtime-observation", runtime: "pi", distribution: this.distribution,
        phase: /preflight timed out/i.test((error as Error).message) ? "rpc_timeout" : "rpc_error",
      });
      this.awaitingAcknowledgement.delete(input.inputId);
      this.ownedInputIds.delete(input.inputId);
      this.inputEpochs.delete(input.inputId);
      return { status: "rejected", inputId: input.inputId, retryable: true, reason: (error as Error).message };
    }
  }

  private onEvent(raw: unknown): void {
    const event = raw as Record<string, any>;
    if (event?.type === "larkin_rpc_failure") {
      const message = String(event.message || "Pi RPC process failed");
      if (this.awaitingAcknowledgement.size > 0) this.emit({
        type: "runtime-observation", runtime: "pi", distribution: this.distribution,
        phase: /preflight timed out/i.test(message) ? "rpc_timeout" : "rpc_error",
      });
      for (const inputId of this.ownedInputIds) {
        if (!this.awaitingAcknowledgement.has(inputId)) this.emit({ type: "input-error", inputId, retryable: true, willRetry: true, message });
      }
      this.awaitingAcknowledgement.clear();
      this.ownedInputIds.clear();
      this.inputEpochs.clear();
      this.observedSubmitEpochs.clear();
      this.observedAcceptedEpochs.clear();
      this.observedCompletedEpochs.clear();
      this.activeEpoch = null;
      this.settleArmedEpoch = null;
      this.emit({ type: "error", message });
    } else if (event?.type === "compaction_start" && this.awaitingAcknowledgement.size > 0) {
      this.emit({ type: "runtime-observation", runtime: "pi", distribution: this.distribution, phase: "compaction_start" });
    } else if (event?.type === "compaction_end" && this.awaitingAcknowledgement.size > 0) {
      this.emit({ type: "runtime-observation", runtime: "pi", distribution: this.distribution, phase: "compaction_end" });
    } else if ((event?.type === "auto_retry_start" || event?.type === "auto_retry_end"
      || String(event?.type || "").startsWith("summarization_retry_")) && this.awaitingAcknowledgement.size > 0) {
      this.emit({ type: "runtime-observation", runtime: "pi", distribution: this.distribution, phase: "retry_progress" });
    } else if (event?.type === "turn_start") {
      const epoch = this.oldestOwnedEpoch();
      if (epoch === null || this.activeEpoch !== null) return;
      this.activeEpoch = epoch;
      this.settleArmedEpoch = null;
      this.firstOutputObserved = false;
      this.toolCallOpen = false;
      this.emit({ type: "runtime-observation", runtime: "pi", distribution: this.distribution, phase: "turn_start" });
      this.emit({ type: "turn-start", ...(Number.isInteger(event.turnIndex) ? { turnId: `pi-${event.turnIndex}` } : {}) });
    }
    else if (event?.type === "agent_end") {
      const assistant = [...(Array.isArray(event.messages) ? event.messages : [])]
        .reverse().find((message) => message?.role === "assistant");
      this.finalAssistantStopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : null;
      this.finalAssistantError = assistant?.stopReason === "error"
        ? piAssistantProviderError(assistant)
        : null;
      this.settleArmedEpoch = this.activeEpoch;
      if (event.willRetry !== true && this.activeEpoch !== null && !this.observedCompletedEpochs.has(this.activeEpoch)) {
        this.observedCompletedEpochs.add(this.activeEpoch);
        this.emit({ type: "runtime-observation", runtime: "pi", distribution: this.distribution, phase: "completed" });
      }
    } else if (event?.type === "agent_settled") {
      const epoch = this.activeEpoch;
      if (epoch === null || this.settleArmedEpoch !== epoch) return;
      this.activeEpoch = null;
      this.settleArmedEpoch = null;
      const error = this.finalAssistantError;
      const stopReason = this.finalAssistantStopReason;
      this.finalAssistantError = null;
      this.finalAssistantStopReason = null;
      if (this.toolCallOpen) {
        this.toolCallOpen = false;
        this.emit({ type: "runtime-observation", runtime: "pi", distribution: this.distribution, phase: "tool_result" });
      }
      this.emit({ type: "runtime-observation", runtime: "pi", distribution: this.distribution, phase: "settled" });
      const owned = [...this.ownedInputIds].filter((inputId) => this.inputEpochs.get(inputId) === epoch);
      if (error) {
        const classified = classifyPiProviderError(error);
        const retryable = classified.category === "rate_limit" || isRetryablePiProviderError(error.upstream.message);
        for (const inputId of owned) this.emit({
          type: "input-error", inputId, retryable, willRetry: false, message: classified.reason,
          errorCategory: classified.category, nextAction: classified.nextAction, upstream: error.upstream,
        });
        this.emit({ type: "turn-end", ...(this.sessionId ? { sessionId: this.sessionId } : {}) });
      } else if (stopReason === "aborted") {
        for (const inputId of owned) this.emit({
          type: "input-error", inputId, retryable: true, willRetry: false, message: "Pi assistant turn aborted",
        });
        this.emit({ type: "turn-end", ...(this.sessionId ? { sessionId: this.sessionId } : {}) });
      } else {
        this.emit({ type: "turn-end", ...(this.sessionId ? { sessionId: this.sessionId } : {}) });
      }
      for (const inputId of owned) { this.ownedInputIds.delete(inputId); this.inputEpochs.delete(inputId); }
      this.observedSubmitEpochs.delete(epoch);
      this.observedAcceptedEpochs.delete(epoch);
      this.observedCompletedEpochs.delete(epoch);
    }
    else if (event?.type === "tool_execution_start") {
      if (!this.firstOutputObserved) {
        this.firstOutputObserved = true;
        this.emit({ type: "runtime-observation", runtime: "pi", distribution: this.distribution, phase: "first_output" });
      }
      if (!this.toolCallOpen) {
        this.toolCallOpen = true;
        this.emit({ type: "runtime-observation", runtime: "pi", distribution: this.distribution, phase: "tool_call" });
      }
      this.emit({ type: "activity", activity: "tool", name: String(event.toolName || "tool") });
    }
    else if (event?.type === "tool_execution_end") {
      if (this.toolCallOpen) {
        this.toolCallOpen = false;
        this.emit({ type: "runtime-observation", runtime: "pi", distribution: this.distribution, phase: "tool_result" });
      }
    }
    else if (event?.type === "message_update" && event.assistantMessageEvent?.delta) {
      if (!this.firstOutputObserved) {
        this.firstOutputObserved = true;
        this.emit({ type: "runtime-observation", runtime: "pi", distribution: this.distribution, phase: "first_output" });
      }
      const kind = event.assistantMessageEvent.type?.startsWith("thinking") ? "thinking" : "text";
      this.emit({ type: "activity", activity: kind, text: String(event.assistantMessageEvent.delta) });
    }
  }

  private oldestOwnedEpoch(): number | null {
    for (const inputId of this.ownedInputIds) {
      const epoch = this.inputEpochs.get(inputId);
      if (epoch !== undefined) return epoch;
    }
    return null;
  }
}

interface PiProviderErrorDetails {
  upstream: UpstreamProviderError;
  type?: string;
}

function safeProviderText(value: unknown, fallback: string): string {
  const source = typeof value === "string" ? value : fallback;
  return source
    .replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[redacted]`)
    .replace(/\b(?:cookie|set-cookie|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[redacted]`)
    .replace(/(["'](?:authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)["']\s*:\s*)["'][^"']*["']/gi, "$1\"[redacted]\"")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 2_000) || fallback;
}

function piAssistantProviderError(message: Record<string, any>): PiProviderErrorDetails {
  const diagnostic = [...(Array.isArray(message.diagnostics) ? message.diagnostics : [])]
    .reverse().find((item: unknown) => item && typeof item === "object") as Record<string, any> | undefined;
  const details = diagnostic?.details && typeof diagnostic.details === "object" ? diagnostic.details : {};
  const bodyError = details.error && typeof details.error === "object" ? details.error : {};
  const primary = bodyError.message ?? diagnostic?.error?.message ?? message.errorMessage;
  const rawCode = bodyError.code ?? diagnostic?.error?.code;
  const provider = typeof details.provider === "string" ? details.provider : typeof message.provider === "string" ? message.provider : undefined;
  return {
    upstream: {
      ...(provider ? { provider: safeProviderText(provider, "provider") } : {}),
      ...(typeof rawCode === "string" || typeof rawCode === "number"
        ? { code: typeof rawCode === "string" ? safeProviderText(rawCode, "unknown") : rawCode } : {}),
      ...(Number.isInteger(details.status) ? { status: Number(details.status) } : {}),
      message: safeProviderText(primary, "Pi assistant turn failed"),
    },
    ...(typeof bodyError.type === "string" ? { type: bodyError.type } : {}),
  };
}

export function classifyPiProviderError(error: PiProviderErrorDetails | UpstreamProviderError): {
  category: "billing" | "quota" | "rate_limit" | "auth" | "provider"; reason: string; nextAction: string;
} {
  const upstream = "upstream" in error ? error.upstream : error;
  const errorType = "type" in error ? error.type : undefined;
  const reason = safeProviderText(upstream.message, "Pi provider request failed");
  const signal = new Set([String(upstream.code ?? "").trim().toLowerCase(), String(errorType ?? "").trim().toLowerCase()].filter(Boolean));
  if (upstream.status === 402 || [...signal].some((value) => ["payment_required", "billing_hard_limit_reached", "insufficient_balance"].includes(value))) return {
    category: "billing", reason, nextAction: "Update the provider billing method or balance, then retry.",
  };
  if ([...signal].some((value) => ["insufficient_quota", "quota_exceeded", "usage_limit_exceeded"].includes(value))) return {
    category: "quota", reason, nextAction: "Increase or reset the provider quota, then retry.",
  };
  if (upstream.status === 429 || [...signal].some((value) => ["rate_limit", "rate_limit_exceeded", "too_many_requests"].includes(value))) return {
    category: "rate_limit", reason, nextAction: "Wait for the provider rate-limit window, then retry.",
  };
  if (upstream.status === 401
      || [...signal].some((value) => ["authentication_error", "invalid_api_key", "invalid_token", "token_expired", "unauthorized", "provider_auth_error"].includes(value))
      || /\bAPI key auth failed\b|\bFailed to resolve API key\b/i.test(reason)) {
    const readiness = providerAuthenticationFailureReadiness("pi", upstream.provider);
    return { category: "auth", reason: readiness.reason!, nextAction: readiness.nextAction! };
  }
  return { category: "provider", reason, nextAction: "Inspect the provider status and request settings, then retry." };
}

function isRetryablePiProviderError(message: string): boolean {
  return /fetch failed|network|non-101|transport|timed? ?out|timeout|socket|connection|\b429\b|\b5\d\d\b|rate.?limit|temporar|overload|unavailable/i.test(message);
}

const CAPABILITIES: Record<RuntimeId, RuntimeCapabilities> = {
  codex: { standingPrompt: "append", sessionResume: true, busyInput: "direct", cancel: true },
  claude: { standingPrompt: "append", sessionResume: true, busyInput: "gated", cancel: true },
  pi: { standingPrompt: "append", sessionResume: true, busyInput: "boundary", cancel: true },
};

function configuredModel(model: string | undefined): string | undefined {
  const value = model?.trim();
  return value && value !== "default" ? value : undefined;
}

export function requirePiResumeSessionFile(sessionDir: string, sessionId: string): string {
  const sessionFile = fs.readdirSync(sessionDir).map((name) => path.join(sessionDir, name)).find((file) => {
    try {
      const first = fs.readFileSync(file, "utf8").split("\n", 1)[0];
      return JSON.parse(first).id === sessionId;
    } catch { return false; }
  });
  if (!sessionFile) throw new Error(`Pi resume session not found: ${sessionId}; refusing to silently create a fresh session`);
  return sessionFile;
}

function isRecordedZeroTurnPiSession(stateDir: string, sessionId: string): boolean {
  try {
    const status = JSON.parse(fs.readFileSync(path.join(stateDir, "status.json"), "utf8"));
    return status?.session?.runtime === "pi" && status.session.id === sessionId && status.session.turns === 0;
  } catch { return false; }
}

export function createPiSessionManager(input: { workspaceDir: string; stateDir: string; resumeSessionId?: string | null }): {
  sessionDir: string; sessionFile: string | null; getSessionId(): string | null;
} {
  const sessionDir = path.join(input.stateDir, "runtime", "pi-sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  if (!input.resumeSessionId) return { sessionDir, sessionFile: null, getSessionId: () => null };
  try {
    const sessionFile = requirePiResumeSessionFile(sessionDir, input.resumeSessionId);
    return { sessionDir, sessionFile, getSessionId: () => input.resumeSessionId! };
  } catch (error) {
    if (isRecordedZeroTurnPiSession(input.stateDir, input.resumeSessionId)) {
      return { sessionDir, sessionFile: null, getSessionId: () => null };
    }
    throw error;
  }
}

interface PiRpcState {
  sessionId?: string;
  sessionFile?: string;
  model?: { provider?: string; id?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> } | null;
  thinkingLevel?: string;
}

function writePrivateAtomic(file: string, content: string): void {
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error("standing prompt must not be a symlink"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally { try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ } }
}

class PiRpcBackend implements PiSessionProcessLike {
  sessionId: string | null;
  model?: { provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> };
  thinkingLevel?: string;
  constructor(private readonly client: PiRpcClient, state: PiRpcState) {
    this.sessionId = state.sessionId ?? null;
    if (state.model?.provider && state.model.id) this.model = {
      provider: state.model.provider, id: state.model.id,
      ...(state.model.reasoning !== undefined ? { reasoning: state.model.reasoning } : {}),
      ...(state.model.thinkingLevelMap ? { thinkingLevelMap: state.model.thinkingLevelMap } : {}),
    };
    this.thinkingLevel = state.thinkingLevel;
  }
  prompt(text: string): Promise<unknown> { return this.client.request("prompt", { message: text }); }
  steer(text: string): Promise<unknown> { return this.client.request("steer", { message: text }); }
  abort(): Promise<unknown> { return this.client.request("abort"); }
  dispose(): Promise<void> { return this.client.close(); }
  subscribe(listener: (event: unknown) => void): () => void {
    const offEvent = this.client.subscribe(listener as (event: Record<string, any>) => void);
    const offFailure = this.client.subscribeFailure((error) => listener({ type: "larkin_rpc_failure", message: error.message }));
    return () => { offEvent(); offFailure(); };
  }
}

async function createPiRpcBackend(input: RuntimeSessionCreate, dependencies: NativeRuntimeAdapterDependencies,
  spawn: (command: string, args: readonly string[], options: Record<string, unknown>) => ProcessLike): Promise<PiSessionProcessLike> {
  const stateRoot = input.stateDir ?? path.join(input.workspaceDir, ".larkin");
  const runtimeDir = path.join(stateRoot, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const promptFile = path.join(runtimeDir, "pi-standing-prompt.md");
  writePrivateAtomic(promptFile, input.standingPrompt.content);
  const session = createPiSessionManager({ workspaceDir: input.workspaceDir, stateDir: stateRoot, resumeSessionId: input.resumeSessionId });
  const requestedModel = configuredModel(input.model);
  const requestedEffort = input.reasoningEffort?.trim() || undefined;
  if (requestedEffort && !isPiThinkingLevel(requestedEffort)) throw new Error(`Unknown Pi thinking level: ${requestedEffort}`);
  const args = ["--mode", "rpc", "--session-dir", session.sessionDir, "--append-system-prompt", promptFile,
    ...(session.sessionFile ? ["--session", session.sessionFile] : []),
    ...(requestedModel ? ["--model", requestedModel] : []),
    ...(requestedEffort ? ["--thinking", requestedEffort] : [])];
  const mergedEnv: NodeJS.ProcessEnv = { ...globalThis.process.env, ...dependencies.env, ...input.env, NO_COLOR: "1" };
  const builtin = mergedEnv.LARKIN_PI_DISTRIBUTION === "builtin";
  const builtinSpec = builtin ? internalCommandSpec("pi-rpc", [], mergedEnv) : null;
  const command = builtinSpec?.command ?? dependencies.piCommand ?? dependencies.env?.LARKIN_PI_COMMAND ?? process.env.LARKIN_PI_COMMAND ?? "pi";
  const commandArgs = [...(builtinSpec?.args ?? []), ...args];
  if (builtin) {
    if (!mergedEnv.LARKIN_CONFIG_DIR) throw new Error("内置 Pi 缺少 LARKIN_CONFIG_DIR");
    mergedEnv.PI_CODING_AGENT_DIR = piAgentDirectory(mergedEnv.LARKIN_CONFIG_DIR, input.agentId);
    mergedEnv.PI_TELEMETRY = "0";
  }
  const child = spawn(command, commandArgs, {
    cwd: input.workspaceDir,
    env: mergedEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new PiRpcClient(child, dependencies.piRpcClientOptions);
  try {
    const [state, available] = await Promise.all([
      client.request<PiRpcState>("get_state"),
      client.request<{ models?: Array<{ provider?: string; id?: string }> }>("get_available_models"),
    ]);
    if (!available?.models?.length) throw new Error("Pi has no authenticated available models. Run the official `pi` login flow or configure provider credentials; Larkin will not create a fallback session.");
    const effectiveModel = state.model?.provider && state.model.id ? `${state.model.provider}/${state.model.id}` : null;
    if (requestedModel && effectiveModel !== requestedModel) throw new Error(`Pi model fallback refused: requested ${requestedModel}, effective ${effectiveModel || "none"}`);
    if (requestedEffort && state.thinkingLevel !== requestedEffort) throw new Error(`Pi thinking level ${requestedEffort} was not accepted by effective model ${effectiveModel || "unknown"}`);
    return new PiRpcBackend(client, state);
  } catch (error) {
    await client.close();
    if (error instanceof RuntimePrerequisiteError) throw error;
    throw new RuntimePrerequisiteError(classifyRuntimePrerequisite("pi", error, command));
  }
}

export function createNativeRuntimeAdapter(id: RuntimeId | string, dependencies: NativeRuntimeAdapterDependencies = {}): RuntimeAdapter {
  if (id !== "codex" && id !== "claude" && id !== "pi") throw new Error(`Unsupported native runtime: ${id}`);
  const spawn = dependencies.spawn ?? ((command, args, options) => nodeSpawn(command, args, options as any) as unknown as ProcessLike);
  let resolvedExecutable: string | null = null;
  const configuredCommand = id === "pi"
    ? dependencies.piCommand ?? dependencies.env?.LARKIN_PI_COMMAND ?? process.env.LARKIN_PI_COMMAND ?? "pi"
    : id === "codex"
      ? dependencies.codexCommand ?? dependencies.env?.LARKIN_CODEX_COMMAND ?? "codex"
      : dependencies.claudeCommand ?? dependencies.env?.LARKIN_CLAUDE_COMMAND ?? "claude";
  const codexCommand = dependencies.codexCommand ?? dependencies.env?.LARKIN_CODEX_COMMAND ?? "codex";
  let codexUpdateAttempt: Promise<{ recovered: boolean; reason: string }> | null = null;
  let codexUpdateAttempted = false;
  const runCodexUpdate = (): Promise<{ recovered: boolean; reason: string }> => new Promise((resolve) => {
    const spawnUpdate = dependencies.spawnCodexUpdate
      ?? ((command: string, args: readonly string[], options: Record<string, unknown>) =>
        nodeSpawn(command, [...args], options as any) as unknown as ProcessLike);
    let child: ProcessLike;
    try {
      child = spawnUpdate(codexCommand, ["update"], {
        env: { ...globalThis.process.env, ...dependencies.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ recovered: false, reason: `Codex update failed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const output: string[] = [];
    let outputBytes = 0;
    const capture = (chunk: unknown): void => {
      const text = String(chunk);
      if (outputBytes >= 4 * 1024 * 1024) return;
      output.push(text.slice(0, 4 * 1024 * 1024 - outputBytes));
      outputBytes += Buffer.byteLength(text);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const finish = (result: { recovered: boolean; reason: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ recovered: false, reason: `Codex update timed out after ${dependencies.codexUpdateTimeoutMs ?? 180_000}ms` });
      }, dependencies.codexUpdateKillGraceMs ?? 2_000);
    }, dependencies.codexUpdateTimeoutMs ?? 180_000);
    child.once("error", (error) => finish({ recovered: false, reason: `Codex update failed: ${error.message}` }));
    child.once("exit", (code, signal) => {
      const detail = output.join("").trim();
      if (timedOut) {
        finish({ recovered: false, reason: `Codex update timed out${detail ? `: ${detail}` : ""}` });
      } else if (code === 0) {
        finish({ recovered: true, reason: `Codex update succeeded${detail ? `: ${detail}` : ""}` });
      } else {
        finish({ recovered: false, reason: `Codex update failed (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}` });
      }
    });
  });
  const recoverCodexConfiguration = async (message: string): Promise<{ recovered: boolean; reason: string }> => {
    if (!/model requires a newer version of Codex/i.test(message)) {
      return { recovered: false, reason: `Codex configuration recovery is not applicable: ${message}` };
    }
    if (codexUpdateAttempt) return codexUpdateAttempt;
    if (codexUpdateAttempted) return { recovered: false, reason: "Codex update was already attempted during this runtime startup" };
    codexUpdateAttempted = true;
    codexUpdateAttempt = runCodexUpdate().then((result) => result.recovered
      ? result
      : { recovered: false, reason: `${message}\n${result.reason}` });
    try {
      return await codexUpdateAttempt;
    } finally {
      codexUpdateAttempt = null;
    }
  };
  const adapter: RuntimeAdapter = {
    id,
    capabilities: CAPABILITIES[id],
    async probe(input) {
      const readiness = await probeNativeRuntimeReadiness({ runtime: id, agentId: input.agentId, cwd: input.workspaceDir,
        env: { ...dependencies.env, ...input.env }, command: configuredCommand });
      resolvedExecutable = readiness.state === "ready" ? readiness.executable ?? null : null;
      return readiness;
    },
    async createSession(input): Promise<RuntimeSession> {
      const productionSpawn = !dependencies.spawn && !(id === "pi" && dependencies.createPiSession);
      if (productionSpawn && !resolvedExecutable) {
        const readiness = await adapter.probe!(input);
        if (readiness.state !== "ready") throw new RuntimePrerequisiteError(readiness);
      }
      if (id === "pi") {
        const distribution = ({ ...globalThis.process.env, ...dependencies.env, ...input.env }).LARKIN_PI_DISTRIBUTION === "builtin"
          ? "builtin" : "external";
        return new PiSession(await (dependencies.createPiSession
        ? dependencies.createPiSession(input)
        : createPiRpcBackend(input, { ...dependencies, piCommand: resolvedExecutable! }, spawn)), distribution);
      }
      if (id === "codex") {
        const codexInput = dependencies.codexModelOverride?.trim()
          ? { ...input, model: dependencies.codexModelOverride.trim() }
          : input;
        const process = spawn(resolvedExecutable || codexCommand, ["app-server", "--listen", "stdio://"], {
          cwd: input.workspaceDir,
          env: { ...globalThis.process.env, ...dependencies.env, ...input.env, NO_COLOR: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        return new CodexSession(process, codexInput);
      }
      const runtimeDir = path.join(input.stateDir ?? path.join(input.workspaceDir, ".larkin"), "runtime");
      (dependencies.mkdir ?? fs.mkdirSync)(runtimeDir, { recursive: true });
      const promptFile = path.join(runtimeDir, "claude-system-prompt.md");
      if (dependencies.writeFile) dependencies.writeFile(promptFile, input.standingPrompt.content, { mode: 0o600 });
      else writePrivateAtomic(promptFile, input.standingPrompt.content);
      const args = [
        "--dangerously-skip-permissions", "--verbose",
        "--permission-mode", "bypassPermissions",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--include-partial-messages",
        "--append-system-prompt-file", promptFile,
        ...(configuredModel(input.model) ? ["--model", configuredModel(input.model)!] : []),
        ...(input.reasoningEffort ? ["--effort", input.reasoningEffort] : []),
        ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
      ];
      const process = spawn(resolvedExecutable || dependencies.claudeCommand || "claude", args, {
        cwd: input.workspaceDir,
        env: { ...globalThis.process.env, ...dependencies.env, ...input.env, CLAUDECODE: undefined },
        stdio: ["pipe", "pipe", "pipe"],
      });
      return new ClaudeSession(process, input.resumeSessionId ?? undefined);
    },
  };
  if (id === "codex") adapter.recoverConfigurationError = recoverCodexConfiguration;
  return adapter;
}
