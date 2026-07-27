import fs from "node:fs";
import path from "node:path";
import { TargetRootLayout } from "../platform/root-layout.js";

export interface DashboardAgentRef {
  agentId: string;
}

export interface DashboardWorkspaceConfig {
  larkinHome: string;
  agents: Record<string, DashboardAgentRef>;
}

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number | null;
  modifiedAt: string;
}

export type WorkspaceProjection = {
  kind: "directory";
  path: string;
  parent: string | null;
  entries: WorkspaceDirectoryEntry[];
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

export interface SafeWorkspacePath {
  root: string;
  resolved: string;
  rel: string;
}

interface StatusError extends Error {
  statusCode: number;
}

function httpError(message: string, statusCode: number): StatusError {
  return Object.assign(new Error(message), { statusCode });
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function workspaceRootForAgent(config: DashboardWorkspaceConfig, agentId: string): string {
  const agent = Object.values(config.agents || {}).find((candidate) => candidate.agentId === agentId);
  if (!agent || !config.larkinHome) throw httpError("agent 不存在", 404);
  const layout = TargetRootLayout.fromConfigDir(config.larkinHome);
  const agentsRoot = path.join(layout.root, "agents");
  const planned = layout.workspaceDir(agent.agentId);
  try {
    if (fs.lstatSync(agentsRoot).isSymbolicLink() || fs.lstatSync(planned).isSymbolicLink()) {
      throw httpError("工作空间路径不能是 symlink", 403);
    }
    const resolved = fs.realpathSync(planned);
    const trustedAgentsRoot = fs.realpathSync(agentsRoot);
    if (!inside(trustedAgentsRoot, resolved)) throw httpError("工作空间越出可信根", 403);
    return resolved;
  } catch (error) {
    if ((error as StatusError).statusCode) throw error;
    throw httpError("工作空间不存在", 404);
  }
}

export function safeWorkspacePath(
  config: DashboardWorkspaceConfig,
  agentId: string,
  requestedPath: unknown,
): SafeWorkspacePath {
  const root = workspaceRootForAgent(config, agentId);
  const rel = String(requestedPath || "").replace(/\\/g, "/");
  if (path.posix.isAbsolute(rel) || rel.split("/").includes("..")) throw httpError("非法工作空间路径", 400);
  const candidate = path.resolve(root, ...rel.split("/").filter(Boolean));
  let resolved: string;
  try { resolved = fs.realpathSync(candidate); }
  catch { throw httpError("文件不存在", 404); }
  if (!inside(root, resolved)) throw httpError("路径越出工作空间", 403);
  return { root, resolved, rel: path.relative(root, resolved).split(path.sep).join("/") };
}

export function collectWorkspaceEntry(
  config: DashboardWorkspaceConfig,
  agentId: string,
  requestedPath: unknown,
  maxFileBytes = 1024 * 1024,
): WorkspaceProjection {
  const { root, resolved, rel } = safeWorkspacePath(config, agentId, requestedPath);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(resolved, { withFileTypes: true }).flatMap<WorkspaceDirectoryEntry>((entry) => {
      const child = path.join(resolved, entry.name);
      let childReal: string;
      let childStat: fs.Stats;
      try {
        childReal = fs.realpathSync(child);
        childStat = fs.statSync(childReal);
      } catch { return []; }
      if (!inside(root, childReal)) return [];
      if (!childStat.isDirectory() && !childStat.isFile()) return [];
      return [{
        name: entry.name,
        path: path.relative(root, childReal).split(path.sep).join("/"),
        kind: childStat.isDirectory() ? "directory" : "file",
        size: childStat.isFile() ? childStat.size : null,
        modifiedAt: childStat.mtime.toISOString(),
      }];
    }).sort((left, right) => left.kind === right.kind
      ? left.name.localeCompare(right.name, "zh-CN")
      : left.kind === "directory" ? -1 : 1);
    const parent = rel ? rel.split("/").slice(0, -1).join("/") : null;
    return { kind: "directory", path: rel, parent, entries };
  }
  if (!stat.isFile()) throw httpError("不支持该文件类型", 415);
  const readBytes = Math.min(stat.size, maxFileBytes);
  const fd = fs.openSync(resolved, "r");
  const buffer = Buffer.alloc(readBytes);
  try { fs.readSync(fd, buffer, 0, readBytes, 0); }
  finally { fs.closeSync(fd); }
  const binary = buffer.includes(0);
  return {
    kind: "file",
    path: rel,
    name: path.basename(resolved),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    binary,
    truncated: stat.size > readBytes,
    content: binary ? null : buffer.toString("utf8"),
  };
}
