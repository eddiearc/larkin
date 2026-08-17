import fs from "node:fs";
import path from "node:path";

type TracePathRole = "config-root" | "provider-target";
type ErrorCategory = "missing" | "permission" | "symlink" | "conflict" | "invalid" | "runtime";

interface TracePathObservation {
  role: TracePathRole;
  exists: boolean;
  regularFile?: boolean;
  directory?: boolean;
  symlink?: boolean;
  mode?: number;
}

function inspect(role: TracePathRole, file: string): TracePathObservation {
  try {
    const stat = fs.lstatSync(file);
    return {
      role,
      exists: true,
      regularFile: stat.isFile(),
      directory: stat.isDirectory(),
      symlink: stat.isSymbolicLink(),
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { role, exists: false, ...(code === "ELOOP" ? { symlink: true } : {}) };
  }
}

function errorCategory(error: unknown): ErrorCategory {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "") : "";
  if (code === "ENOENT") return "missing";
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (code === "ELOOP") return "symlink";
  if (code === "EEXIST") return "conflict";
  if (code === "EINVAL" || code === "EBADMSG" || code === "ERR_INVALID_ARG_VALUE") return "invalid";
  return "runtime";
}

function safePhase(value: unknown): string {
  const phase = typeof value === "string" ? value : "unknown";
  return /^[a-z0-9:_-]{1,80}$/i.test(phase) ? phase : "unknown";
}

function safeEpoch(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return null;
  const text = value instanceof Date ? value.toISOString() : String(value);
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * Opt-in, content-free diagnostics for process-boundary startup investigations.
 * The trace intentionally emits roles and metadata only: never a cwd, home,
 * config/profile/target path, or exception text. Diagnostics are inert unless an
 * absolute 0600 destination is explicitly supplied by a test or operator.
 */
export function traceProcessBoundary(
  env: NodeJS.ProcessEnv,
  phase: string,
  fields: { configDir?: string; targetDir?: string; agentId?: string; error?: unknown; epoch?: unknown; [key: string]: unknown } = {},
): void {
  const file = env.LARKIN_PROCESS_BOUNDARY_TRACE_FILE;
  if (!file || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) return;
  try {
    const configRoot = fields.configDir || env.LARKIN_CONFIG_DIR || env.LARKIN_HOME || null;
    const record: Record<string, unknown> = {
      at: new Date().toISOString(),
      epoch: safeEpoch(fields.epoch ?? env.LARKIN_DAEMON_EPOCH ?? new Date().toISOString()),
      pid: process.pid,
      ppid: process.ppid,
      phase: safePhase(phase),
      configuredRoots: {
        configDir: Boolean(env.LARKIN_CONFIG_DIR || fields.configDir),
        larkinHome: Boolean(env.LARKIN_HOME),
        piAgentDir: Boolean(env.PI_CODING_AGENT_DIR),
      },
      pathRoles: [
        ...(configRoot ? [inspect("config-root", configRoot)] : []),
        ...(fields.targetDir ? [inspect("provider-target", fields.targetDir)] : []),
      ],
    };
    if (typeof fields.agentId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(fields.agentId)) record.agentId = fields.agentId;
    if (Number.isInteger(fields.childPid) && Number(fields.childPid) > 0) record.childPid = Number(fields.childPid);
    if (typeof fields.distribution === "string" && /^(builtin|external)$/.test(fields.distribution)) record.distribution = fields.distribution;
    if (typeof fields.requested === "string" && /^(builtin|external|migration|startup)$/.test(fields.requested)) record.requested = fields.requested;
    if (typeof fields.targetDirExisted === "boolean") record.targetDirExisted = fields.targetDirExisted;
    if (fields.error !== undefined) record.errorCategory = errorCategory(fields.error);
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
