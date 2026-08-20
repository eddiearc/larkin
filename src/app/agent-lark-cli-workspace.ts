import fs from "node:fs";
import path from "node:path";
import { exactMode } from "../platform/secure-metadata.js";
import { resolveOfficialLarkCli, type OfficialLarkCliCommand } from "./official-lark-cli.js";

export interface AgentLarkCliWorkspace {
  agentId: string;
  feishuAppId?: string;
  credentialRevision?: string;
  stateDir?: string;
  larkConfigDir?: string;
}

export interface ManagedOfficialLarkCli {
  command: OfficialLarkCliCommand;
  env: NodeJS.ProcessEnv;
}

export function larkChannelSourceConfigPath(agent: AgentLarkCliWorkspace): string {
  if (!agent.stateDir) throw new Error(`Agent ${agent.agentId} 缺少 stateDir，无法建立 lark-channel binding`);
  return path.join(path.resolve(agent.stateDir), "lark-channel-source", "config.json");
}

export function larkChannelWorkspaceConfigPath(agent: AgentLarkCliWorkspace): string {
  if (!agent.larkConfigDir) throw new Error(`Agent ${agent.agentId} 缺少 larkConfigDir，无法建立 lark-channel binding`);
  return path.join(path.resolve(agent.larkConfigDir), "lark-channel", "config.json");
}

export function managedLarkCliEnv(agent: AgentLarkCliWorkspace, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!agent.larkConfigDir) throw new Error(`Agent ${agent.agentId} 缺少 larkConfigDir，拒绝回退 local workspace`);
  const isolated = { ...env };
  for (const key of ["OPENCLAW_CLI", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_SERVICE_MARKER",
    "OPENCLAW_SERVICE_VERSION", "OPENCLAW_GATEWAY_PORT", "OPENCLAW_SHELL", "HERMES_HOME", "HERMES_QUIET", "HERMES_EXEC_ASK",
    "HERMES_GATEWAY_TOKEN", "HERMES_SESSION_KEY"]) delete isolated[key];
  return {
    ...isolated,
    LARK_CHANNEL: "1",
    LARK_CHANNEL_CONFIG: larkChannelSourceConfigPath(agent),
    LARKSUITE_CLI_CONFIG_DIR: path.resolve(agent.larkConfigDir),
  };
}

export function managedOfficialLarkCli(
  agent: AgentLarkCliWorkspace,
  env: NodeJS.ProcessEnv,
  resolve: (input: { env: NodeJS.ProcessEnv }) => OfficialLarkCliCommand = resolveOfficialLarkCli,
): ManagedOfficialLarkCli {
  assertAgentWorkspaceBound(agent);
  const managedEnv = managedLarkCliEnv(agent, env);
  return { command: resolve({ env: managedEnv }), env: managedEnv };
}

function readPrivateJson(file: string, label: string): Record<string, any> {
  const directory = fs.lstatSync(path.dirname(file));
  if (!directory.isDirectory() || directory.isSymbolicLink()
      || (!exactMode(directory, 0o700) && !exactMode(directory, 0o500))
      || (typeof process.getuid === "function" && directory.uid !== process.getuid())) throw new Error(`${label} 目录不安全`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (!exactMode(stat, 0o600) && !exactMode(stat, 0o400))
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error(`${label} 文件不安全`);
    return JSON.parse(fs.readFileSync(fd, "utf8")) as Record<string, any>;
  } finally { fs.closeSync(fd); }
}

export function assertAgentWorkspaceBound(agent: AgentLarkCliWorkspace & { feishuAppId?: string }): void {
  if (!agent.feishuAppId) throw new Error(`Agent ${agent.agentId} 缺少 feishuAppId，拒绝回退 local workspace`);
  let source: Record<string, any>;
  let workspace: Record<string, any>;
  try {
    source = readPrivateJson(larkChannelSourceConfigPath(agent), "lark-channel source projection");
    workspace = readPrivateJson(larkChannelWorkspaceConfigPath(agent), "lark-channel workspace");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Agent ${agent.agentId} lark-channel workspace 未绑定；运行 larkin setup`);
    throw error;
  }
  const sourceApp = source.accounts?.app;
  const provider = source.secrets?.providers?.["larkin-bot-credential"];
  if (sourceApp?.id !== agent.feishuAppId || sourceApp?.secret?.source !== "exec"
      || sourceApp?.secret?.provider !== "larkin-bot-credential" || sourceApp?.secret?.id !== agent.feishuAppId
      || provider?.source !== "exec" || typeof provider.command !== "string" || !path.isAbsolute(provider.command)
      || !Array.isArray(provider.args) || provider.env?.LARKIN_AGENT_ID !== agent.agentId
      || provider.env?.LARKIN_SECRET_PROVIDER_CONTEXT !== "bind") {
    throw new Error(`Agent ${agent.agentId} lark-channel source projection 错配`);
  }
  if (agent.credentialRevision && source.credentialRevision !== agent.credentialRevision) {
    throw new Error(`Agent ${agent.agentId} lark-channel credential revision 已过期；运行 larkin setup`);
  }
  const apps = workspace.apps;
  const app = Array.isArray(apps) && apps.length === 1 ? apps[0] : null;
  if (!app || app.appId !== agent.feishuAppId || app.defaultAs !== "bot" || app.strictMode !== "bot"
      || app.appSecret?.source !== "keychain" || app.appSecret?.id !== `appsecret:${agent.feishuAppId}`
      || (Array.isArray(app.users) ? app.users.length !== 0
        : app.users && typeof app.users === "object" ? Object.keys(app.users).length !== 0 : app.users !== undefined && app.users !== null)) {
    throw new Error(`Agent ${agent.agentId} lark-channel workspace identity/bot-only policy 错配；运行 larkin setup`);
  }
}
