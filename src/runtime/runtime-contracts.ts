export type RuntimeId = "codex" | "claude" | "pi";

export type RuntimeInputKind =
  | "initial"
  | "wake"
  | "resume"
  | "inbox-update"
  | "inbox_update"
  | "reminder"
  | "user";

export interface RuntimeInput {
  inputId: string;
  kind: RuntimeInputKind;
  text: string;
  deliveryId?: string;
  attempt: number;
}

export type RuntimeInputResult =
  | { status: "accepted"; inputId: string }
  | { status: "deferred"; inputId: string; reason: string }
  | { status: "rejected"; inputId: string; retryable: boolean; reason: string };

export interface RuntimeCapabilities {
  standingPrompt: "append";
  sessionResume: boolean;
  busyInput: "direct" | "boundary" | "gated";
  cancel: boolean;
}

export interface UpstreamProviderError {
  provider?: string;
  code?: string | number;
  status?: number;
  message: string;
}

export type NormalizedRuntimeEvent =
  | { type: "session-init"; sessionId: string; model?: string; reasoningEffort?: string }
  | { type: "runtime-observation"; runtime: "pi"; distribution: "builtin" | "external";
      phase: "rpc_submit" | "rpc_accepted" | "compaction_start" | "compaction_end" | "retry_progress"
        | "rpc_timeout" | "rpc_error" | "turn_start" | "first_output" | "tool_call" | "tool_result" | "agent_end" | "completed" | "settled"
        | "background_dispatched";
      reason?: "manual" | "threshold" | "overflow"; willRetry?: boolean; success?: boolean; inputId?: string; sessionId?: string; completionKey?: string;
      completionStatuses?: Record<string, "completed" | "failed" | "cancelled" | "timed_out">;
      handledInTurn?: boolean;
      taskId?: string; outputFile?: string }
  | { type: "turn-start"; turnId?: string }
  | { type: "activity"; activity: "thinking" | "text" | "tool" | "internal"; text?: string; name?: string }
  | { type: "turn-end"; sessionId?: string; turnId?: string }
  | { type: "input-error"; inputId?: string; retryable: boolean; willRetry?: boolean; message: string;
      errorCategory?: "billing" | "quota" | "rate_limit" | "auth" | "context_window" | "provider"; nextAction?: string;
      upstream?: UpstreamProviderError }
  | { type: "configuration-error"; message: string }
  | { type: "error"; message: string }
  | { type: "closed"; code: number | null; signal: string | null };

export interface StandingPrompt {
  version: string;
  content: string;
  hash: string;
}

export interface RuntimeSessionCreate {
  agentId: string;
  workspaceDir: string;
  stateDir?: string;
  standingPrompt: StandingPrompt;
  model?: string;
  reasoningEffort?: string | null;
  resumeSessionId?: string | null;
  env?: NodeJS.ProcessEnv;
}

export interface RuntimeSession {
  readonly sessionId: string | null;
  readonly effectiveModel?: string | null;
  readonly effectiveReasoningEffort?: string | null;
  prompt(input: RuntimeInput): Promise<RuntimeInputResult>;
  busyInput(input: RuntimeInput): Promise<RuntimeInputResult>;
  cancel(reason: string): Promise<void>;
  compact?(customInstructions?: string): Promise<unknown>;
  getContextUsage?(): Promise<{ tokens: number; contextWindow: number } | null>;
  close(reason: string): Promise<void>;
  subscribe(listener: (event: NormalizedRuntimeEvent) => void): () => void;
}

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  readonly capabilities: RuntimeCapabilities;
  probe?(input: Pick<RuntimeSessionCreate, "agentId" | "workspaceDir" | "stateDir" | "env">): Promise<import("./runtime-readiness.js").RuntimeReadiness>;
  createSession(input: RuntimeSessionCreate): Promise<RuntimeSession>;
  recoverConfigurationError?(message: string): Promise<{ recovered: boolean; reason: string }>;
}

export type AgentCliCommand =
  | { command: "inbox check" | "inbox poll"; purpose: string }
  | { command: `reminder ${"schedule" | "list" | "snooze" | "update" | "cancel" | "log"}`; purpose: string }
  | { command: `interaction ${"callback-status" | "callback-probe" | "create" | "get" | "resolve"}`; purpose: string }
  | { command: "profile show"; purpose: string }
  | { command: `config ${"show" | "runtime" | "model" | "effort" | "mention" | "apply"}`; purpose: string };

export interface AgentCliCapabilities {
  executable: string;
  commands: readonly AgentCliCommand[];
}
