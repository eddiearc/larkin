export interface FeedItem {
  at?: string;
  kind?: "deliver" | "activity" | "error";
  from?: string;
  target?: string;
  state?: string;
  detail?: string;
  tool?: string | null;
  text?: string;
}

export interface ConversationItem {
  direction: "in" | "out";
  from?: string;
  senderType?: string;
  target?: string;
  wake: boolean;
  text?: string;
  messageId?: string;
  at?: string;
}

export interface ReminderItem {
  title?: string;
  status?: string;
  fireAt?: string;
  repeat?: unknown;
}

export interface DashboardAgent {
  agentId: string;
  name: string;
  displayName: string;
  runtime: string;
  model: string;
  effort: string | null;
  runtimeReadiness: RuntimeReadinessView | null;
  running: boolean;
  issue: boolean;
  credentialReady: boolean;
  bot: { name?: string; openId?: string; hasAvatar?: boolean } | null;
  connection: { state: string; reason: string };
  inbound: { state: string; reason: string };
  lastActivity: { state?: string; detail?: string; at?: string; ageSec?: number } | null;
  lastDeliver: { from?: string; target?: string; at?: string; ageSec?: number } | null;
  eyeIndicator: { pendingCount: number; oldestAgeSec: number | null; stuck: boolean };
  activeReminders: number;
  remindersList: ReminderItem[];
  session: {
    id: string;
    runtime: string;
    ageSec: number | null;
    lastTurnAt: string | null;
    turns: number;
    usage: {
      available?: boolean;
      cumulativeTokens?: number;
      latestTokens?: number;
      contextWindow?: number | null;
      contextPercent?: number | null;
      reason?: string;
    };
    compaction: {
      active?: boolean;
      count?: number;
      countSource?: "runtime" | "status";
      lastFinishedAt?: string | null;
    };
  } | null;
  conversation: ConversationItem[];
  feed: FeedItem[];
  recentErrors: Array<{ at?: string; text?: string; message?: string }>;
  knownChats: number;
}

export interface RuntimeReadinessView {
  runtime?: "codex" | "claude" | "pi";
  state: "missing" | "unauthenticated" | "incompatible" | "ready";
  executable?: string;
  version?: string;
  reason?: string;
  nextAction?: string;
}

export interface StatusResponse {
  version: string;
  packageVersion: string;
  buildFingerprint: string;
  generatedAt: string;
  daemon: { running: boolean; state: string; reason: string | null; uptimeSec: number | null; agents: string[] };
  agents: DashboardAgent[];
}

export interface KnownChat {
  chatId: string;
  displayName: string | null;
  kind: "group" | "direct";
  override: "inherit" | "require" | "free";
  effective: "require" | "free";
  source: "global" | "agent" | "chat";
}

export interface ConfigAgent {
  agentId: string;
  runtime: string;
  model: string;
  effort: string | null;
  mention: { override: "inherit" | "require" | "free"; effective: "require" | "free"; source: "global" | "agent" };
  knownChats: KnownChat[];
  apply: { applyState?: "unknown" | "pending" | "applied" };
}

export interface RuntimeModel {
  id: string;
  label?: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export interface ConfigResponse {
  version: 4;
  mentionPolicy: "require" | "free";
  persistedRevision: string;
  agents: ConfigAgent[];
  runtimeModels: Record<string, RuntimeModel[]>;
}

export type WorkspaceProjection = {
  kind: "directory";
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string; kind: "directory" | "file"; size: number | null; modifiedAt: string }>;
} | {
  kind: "file";
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  binary: boolean;
  truncated: boolean;
  content: string | null;
};

declare global {
  interface Window {
    __LARKIN_DASHBOARD__: {
      packageVersion: string;
      dashboardVersion: string;
      buildFingerprint: string;
      csrfCapability: string;
    };
  }
}
