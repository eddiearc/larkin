import fs from "node:fs";
import path from "node:path";

interface TracePath {
  path: string;
  exists: boolean;
  regularFile?: boolean;
  directory?: boolean;
  symlink?: boolean;
  mode?: number;
}

function inspect(file: string): TracePath {
  try {
    const stat = fs.lstatSync(file);
    return { path: file, exists: true, regularFile: stat.isFile(), directory: stat.isDirectory(), symlink: stat.isSymbolicLink(), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, exists: false };
    return { path: file, exists: false };
  }
}

/**
 * Opt-in, content-free diagnostics for process-boundary startup investigations.
 * The trace is inert unless an absolute file is explicitly supplied by a test or
 * operator; it records only roots, target metadata, and bounded error labels.
 */
export function traceProcessBoundary(
  env: NodeJS.ProcessEnv,
  phase: string,
  fields: { configDir?: string; targetDir?: string; agentId?: string; error?: unknown; [key: string]: unknown } = {},
): void {
  const file = env.LARKIN_PROCESS_BOUNDARY_TRACE_FILE;
  if (!file || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) return;
  try {
    const root = fields.configDir || env.LARKIN_CONFIG_DIR || env.LARKIN_HOME || null;
    const error = fields.error instanceof Error ? fields.error : null;
    const record = {
      at: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      phase,
      cwd: process.cwd(),
      configDir: root,
      larkinHome: env.LARKIN_HOME || null,
      larkinConfigDir: env.LARKIN_CONFIG_DIR || null,
      piAgentDir: env.PI_CODING_AGENT_DIR || null,
      ...(fields.targetDir ? { target: inspect(fields.targetDir) } : {}),
      ...(fields.error ? {
        errorName: error?.name || "unknown",
        errorCode: typeof fields.error === "object" && fields.error && "code" in fields.error ? String((fields.error as { code?: unknown }).code || "") : "",
        errorMessage: String(error?.message || fields.error).replace(/[\r\n]+/g, " ").slice(0, 500),
      } : {}),
      ...Object.fromEntries(Object.entries(fields).filter(([key]) => !["configDir", "targetDir", "error"].includes(key))),
    };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) return;
      fs.writeSync(fd, bytes);
      fs.fchmodSync(fd, 0o600);
    } finally { fs.closeSync(fd); }
  } catch {
    // Diagnostics must never alter startup behavior.
  }
}
