import * as path from "node:path";

export interface RootLayoutPlan {
  root: string;
  workspaceDir: string;
  stateDir: string;
}

export interface AgentStatePaths {
  root: string;
  agentState: string;
  status: string;
  map: string;
  replyctx: string;
  botIdentity: string;
  senderProfiles: string;
  readReceipts: string;
  pendingReact: string;
  runtimeDeliveries: string;
  inboxState: string;
  freshnessState: string;
  documentComments: string;
  interactions: string;
  conversation: string;
  inbox: string;
  reminders: string;
}

const APP_ID = /^cli_[A-Za-z0-9]+$/;

function requireConfigDir(configDir: string): string {
  if (typeof configDir !== "string" || !configDir.trim()) throw new Error("config dir must be non-empty");
  return path.resolve(configDir);
}

function validateAgentId(agentId: string): void {
  if (typeof agentId !== "string" || !APP_ID.test(agentId)) {
    throw new Error(`invalid App ID agent id: ${JSON.stringify(agentId)}`);
  }
}

export function resolveConfigDir(env: Record<string, string | undefined>, home: string): string {
  const explicit = env?.LARKIN_CONFIG_DIR;
  if (!explicit && (typeof home !== "string" || !home.trim())) throw new Error("home must be non-empty");
  return path.resolve(explicit || path.join(home, ".larkin"));
}

export class TargetRootLayout {
  readonly root: string;
  readonly configDir: string;
  readonly larkinHome: string;
  readonly configFile: string;
  readonly daemonStatusFile: string;
  readonly dashboardStatusFile: string;

  private constructor(configDir: string) {
    this.root = requireConfigDir(configDir);
    this.configDir = this.root;
    this.larkinHome = this.root;
    this.configFile = path.join(this.root, "config.json");
    this.daemonStatusFile = path.join(this.root, "daemon-status.json");
    this.dashboardStatusFile = path.join(this.root, "dashboard-status.json");
    Object.freeze(this);
  }

  static fromConfigDir(configDir: string): TargetRootLayout {
    return new TargetRootLayout(configDir);
  }

  workspaceDir(agentId: string): string {
    validateAgentId(agentId);
    return path.join(this.root, "agents", agentId);
  }

  agentStateDir(agentId: string): string {
    validateAgentId(agentId);
    return path.join(this.root, "state", "agents", agentId);
  }

  agentStatePaths(agentId: string): AgentStatePaths {
    const root = this.agentStateDir(agentId);
    return Object.freeze({
      root,
      agentState: path.join(root, "agent-state.json"),
      status: path.join(root, "status.json"),
      map: path.join(root, "feishu-map.json"),
      replyctx: path.join(root, "feishu-replyctx.json"),
      botIdentity: path.join(root, "bot-identity.json"),
      senderProfiles: path.join(root, "sender-profiles.json"),
      readReceipts: path.join(root, "feishu-read.json"),
      pendingReact: path.join(root, "feishu-pending-react.json"),
      runtimeDeliveries: path.join(root, "runtime-deliveries.json"),
      inboxState: path.join(root, "inbox-state.json"),
      freshnessState: path.join(root, "freshness-state.json"),
      documentComments: path.join(root, "document-comments.json"),
      interactions: path.join(root, "interactions.json"),
      conversation: path.join(root, "conversation.ndjson"),
      inbox: path.join(root, "feishu-inbox.ndjson"),
      reminders: path.join(root, "reminders.json"),
    });
  }
}

export function planRootLayout({ root, agentId }: { root: string; agentId: string }): RootLayoutPlan {
  const target = TargetRootLayout.fromConfigDir(root);
  return { root: target.root, workspaceDir: target.workspaceDir(agentId), stateDir: target.agentStateDir(agentId) };
}
