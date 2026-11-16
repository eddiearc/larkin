import crypto from "node:crypto";
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
  /** Hash of the whole file when it is fully previewed text; the edit precondition. */
  sha256: string | null;
};

export const MAX_WORKSPACE_EDIT_BYTES = 1024 * 1024;

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
  const truncated = stat.size > readBytes;
  return {
    kind: "file",
    path: rel,
    name: path.basename(resolved),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    binary,
    truncated,
    content: binary ? null : buffer.toString("utf8"),
    sha256: binary || truncated ? null : sha256(buffer),
  };
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Replace an existing text file in the Agent workspace. The write is optimistic:
 * it only lands when the file still hashes to what the editor loaded, so a
 * concurrent Agent edit is reported as a conflict instead of being overwritten.
 * The hash is checked again after the new content is on disk and just before the
 * replace, which narrows the race to the rename itself; a rename cannot compare and
 * swap, so a write landing in that last instant still needs the writer's cooperation.
 * `beforeReplace` lets tests act as that concurrent writer.
 */
export function writeWorkspaceFile(
  config: DashboardWorkspaceConfig,
  agentId: string,
  requestedPath: unknown,
  content: unknown,
  expectedSha256: unknown,
  maxFileBytes = MAX_WORKSPACE_EDIT_BYTES,
  beforeReplace?: () => void,
): WorkspaceProjection {
  if (typeof content !== "string" || typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw httpError("需要 content 和 expectedSha256", 400);
  }
  const { resolved } = safeWorkspacePath(config, agentId, requestedPath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw httpError("只能编辑文件", 415);
  if (stat.size > maxFileBytes) throw httpError("文件超过 1 MB，不能在线编辑", 413);
  const current = fs.readFileSync(resolved);
  if (current.includes(0)) throw httpError("二进制文件不能在线编辑", 415);
  const conflict = () => httpError("文件已被修改，请重新加载后再编辑", 409);
  if (sha256(current) !== expectedSha256) throw conflict();
  const next = Buffer.from(content, "utf8");
  if (next.byteLength > maxFileBytes) throw httpError("内容超过 1 MB", 413);
  if (next.includes(0)) throw httpError("内容不能包含 NUL 字符", 400);
  const temp = path.join(path.dirname(resolved), `.${path.basename(resolved)}.larkin-${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(temp, "wx", stat.mode & 0o777);
  try {
    try {
      fs.writeFileSync(fd, next);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    beforeReplace?.();
    if (sha256(fs.readFileSync(resolved)) !== expectedSha256) throw conflict();
    fs.renameSync(temp, resolved);
  } catch (error) { fs.rmSync(temp, { force: true }); throw error; }
  return collectWorkspaceEntry(config, agentId, requestedPath, maxFileBytes);
}

/** Root-level rule files the runtimes read on every new session (Codex/Pi: AGENTS.md, Claude: CLAUDE.md). */
export const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
type InstructionFileName = typeof INSTRUCTION_FILE_NAMES[number];

export interface InstructionFileView {
  name: InstructionFileName;
  /** Workspace-relative target when the file is a symlink to another workspace file (e.g. CLAUDE.md -> AGENTS.md). */
  linkedTo: string | null;
  file: Extract<WorkspaceProjection, { kind: "file" }> | null;
  error: string | null;
}

export function collectInstructionFiles(config: DashboardWorkspaceConfig, agentId: string): { files: InstructionFileView[] } {
  const root = workspaceRootForAgent(config, agentId);
  return {
    files: INSTRUCTION_FILE_NAMES.map((name) => {
      let linkedTo: string | null = null;
      try {
        if (fs.lstatSync(path.join(root, name)).isSymbolicLink()) {
          const target = fs.realpathSync(path.join(root, name));
          linkedTo = inside(root, target) ? path.relative(root, target).split(path.sep).join("/") : null;
        }
      } catch { /* missing or dangling: reported below */ }
      try {
        const entry = collectWorkspaceEntry(config, agentId, name);
        if (entry.kind !== "file") return { name, linkedTo, file: null, error: `${name} 是目录，不是文件` };
        return { name, linkedTo, file: entry, error: null };
      } catch (error) {
        if ((error as StatusError).statusCode === 404) return { name, linkedTo, file: null, error: null };
        return { name, linkedTo, file: null, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  };
}

/** Create a missing AGENTS.md / CLAUDE.md at the workspace root; never overwrites an existing file or link. */
export function createInstructionFile(
  config: DashboardWorkspaceConfig,
  agentId: string,
  name: unknown,
  content: unknown,
  maxFileBytes = MAX_WORKSPACE_EDIT_BYTES,
): WorkspaceProjection {
  if (!INSTRUCTION_FILE_NAMES.includes(name as InstructionFileName)) throw httpError("只能新建 AGENTS.md 或 CLAUDE.md", 400);
  if (typeof content !== "string") throw httpError("需要 content", 400);
  const next = Buffer.from(content, "utf8");
  if (next.byteLength > maxFileBytes) throw httpError("内容超过 1 MB", 413);
  if (next.includes(0)) throw httpError("内容不能包含 NUL 字符", 400);
  const root = workspaceRootForAgent(config, agentId);
  let fd: number;
  try { fd = fs.openSync(path.join(root, name as string), "wx", 0o644); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw httpError("文件已存在，请重新加载", 409);
    throw error;
  }
  try {
    fs.writeFileSync(fd, next);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return collectWorkspaceEntry(config, agentId, name, maxFileBytes);
}
