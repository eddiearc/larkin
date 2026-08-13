import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { RuntimePrerequisiteError, type RuntimeReadiness } from "../runtime/runtime-readiness.js";
import os from "node:os";
import path from "node:path";
import { readProcessState } from "../platform/process-state.js";
import { currentProcessMetadata } from "../platform/process-inspect.cjs";
import { processCommandToken } from "./internal-command.js";
import { isWindows, notGroupOrWorldAccessible, secureWindowsDirectoryAcl } from "../platform/secure-metadata.js";

export interface AgentUpsertRequest { operationId: string; agentId: string; authorization: string }
export type AgentUpsertOperation = Pick<AgentUpsertRequest, "operationId" | "agentId">;
export interface AgentUpsertResponse { ok: boolean; operationId: string; agentId: string; code?: string; error?: string; readiness?: RuntimeReadiness }
export interface DashboardRecoveryResponse { ok: boolean; operationId: string; state?: string; error?: string }
export interface SessionResetResponse {
  ok: boolean; agentId: string; code?: string; error?: string;
  resetCommitted: boolean; generationChanged: boolean; sessionChanged: boolean; turns: number;
  runtimeReady: boolean; channelConnected: boolean; reconnecting: boolean; pendingCount: number;
  readyForFreshScenario: boolean; inboundObserved: false; readiness?: RuntimeReadiness;
}
interface SessionResetControlRequest { operation: "session-reset"; agentId: string; authorization: string; waitReadyMs?: number }
type AgentControlRequest = AgentUpsertRequest | SessionResetControlRequest;
type AgentControlPayload = Omit<AgentUpsertRequest, "authorization"> | Omit<SessionResetControlRequest, "authorization">;

interface ProcessBinding { pid: number; processStartToken: string }
interface SocketBinding { device: string; inode: string; owner: string; changeTimeNs: string }
// Windows 上 socket 无法 lstat（EACCES），用全数字占位 binding 使 authority 校验通过；
// 该平台的安全边界是 socket root 目录的 ACL，而非 inode 身份比对。
const WINDOWS_SOCKET_BINDING: SocketBinding = { device: "0", inode: "0", owner: "0", changeTimeNs: "0" };
interface ControlAuthority {
  version: 2;
  token: string;
  socketRoot: string;
  supervisorSocketPath: string;
  daemonSocketPath: string;
  supervisor: ProcessBinding;
  supervisorSocket?: SocketBinding;
  daemon?: ProcessBinding;
  daemonSocket?: SocketBinding;
}

const AGENT_ID = /^cli_[A-Za-z0-9]+$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{8,128}$/;
const AUTHORIZATION = /^[A-Za-z0-9_-]{43,128}$/;
const UNIX_SOCKET_PATH_MAX_BYTES = process.platform === "darwin" ? 103 : 107;

function socketPathsFit(root: string): boolean {
  if (isWindows) return true; // Windows named-pipe socket paths use a much larger limit
  return ["supervisor.sock", "daemon.sock"].every((name) =>
    Buffer.byteLength(path.join(root, name)) <= UNIX_SOCKET_PATH_MAX_BYTES);
}

function controlSocketRoot(larkinHome: string): string {
  const owner = typeof process.getuid === "function" ? process.getuid() : "user";
  const identity = crypto.createHash("sha256").update(path.resolve(larkinHome)).digest("hex").slice(0, 16);
  const leaf = `lk-${owner}-${identity}`;
  const preferred = path.join(path.resolve(os.tmpdir()), leaf);
  if (socketPathsFit(preferred)) return preferred;
  if (isWindows) throw new Error("无法生成满足 Windows socket 路径限制的 control root");
  const fallback = path.join("/tmp", leaf);
  if (socketPathsFit(fallback)) return fallback;
  throw new Error("无法生成满足 Unix socket 长度限制的 control root");
}

function assertSecureSocketDirectory(root: string): string {
  if (isWindows) {
    // Windows：socket 本身无法 lstat（EACCES），安全边界是目录 ACL。
    // 每次启动重新收紧为「当前用户 + SYSTEM」并回读校验。
    secureWindowsDirectoryAcl(root, { label: "control socket root" });
    return root;
  }
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || !notGroupOrWorldAccessible(stat)) throw new Error("control socket root 不安全");
  return root;
}

function ensureSecureSocketRoot(larkinHome: string): string {
  const root = controlSocketRoot(larkinHome);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return assertSecureSocketDirectory(root);
}

export function controlSocketPath(larkinHome: string): string {
  return path.join(controlSocketRoot(larkinHome), "daemon.sock");
}

export function controlAuthorityPath(larkinHome: string): string {
  return path.join(path.resolve(larkinHome), "daemon-control-auth.json");
}

export function supervisorControlSocketPath(larkinHome: string): string {
  return path.join(controlSocketRoot(larkinHome), "supervisor.sock");
}

function assertSecureRoot(root: string): void {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || !notGroupOrWorldAccessible(stat)) throw new Error("Larkin config root 必须由当前用户拥有且不可被其他用户访问");
}

function removeLegacyResetLedger(larkinHome: string): void {
  const file = path.join(path.resolve(larkinHome), "daemon-control-operations.json");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || !notGroupOrWorldAccessible(stat)) {
    throw new Error("legacy daemon control operation ledger 不安全");
  }
  fs.unlinkSync(file);
}

function parseRequest(line: string): AgentControlRequest {
  const value = JSON.parse(line) as Partial<AgentUpsertRequest & SessionResetControlRequest>;
  if (!AGENT_ID.test(String(value.agentId || "")) || !AUTHORIZATION.test(String(value.authorization || ""))) {
    throw new Error("invalid agent control request");
  }
  if (value.operation === "session-reset") {
    if (value.waitReadyMs !== undefined && (!Number.isSafeInteger(value.waitReadyMs) || value.waitReadyMs < 0 || value.waitReadyMs > 300_000)) {
      throw new Error("invalid session reset waitReadyMs");
    }
    if (Object.keys(value).some((key) => !["agentId", "authorization", "operation", "waitReadyMs"].includes(key))) {
      throw new Error("session reset control request 包含未知字段");
    }
    return value as SessionResetControlRequest;
  }
  if (value.operation !== undefined || !OPERATION_ID.test(String(value.operationId || ""))) {
    throw new Error("invalid agent upsert request");
  }
  if (value.waitReadyMs !== undefined) {
    throw new Error("invalid session reset waitReadyMs");
  }
  if (Object.keys(value).some((key) => !["operationId", "agentId", "authorization"].includes(key))) {
    throw new Error("agent control request 包含未知字段");
  }
  return value as AgentUpsertRequest;
}

function atomicWritePrivateJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

function secureAuthority(larkinHome: string): ControlAuthority {
  assertSecureRoot(larkinHome);
  const file = controlAuthorityPath(larkinHome);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || !notGroupOrWorldAccessible(stat)) throw new Error("daemon control authority 不安全");
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ControlAuthority>;
  const validBinding = (binding: ProcessBinding | undefined): binding is ProcessBinding =>
    !!binding && Number.isSafeInteger(binding.pid) && binding.pid > 0
      && typeof binding.processStartToken === "string" && binding.processStartToken.length > 0;
  const validSocketBinding = (binding: SocketBinding | undefined): binding is SocketBinding =>
    !!binding && /^\d+$/.test(binding.device) && /^\d+$/.test(binding.inode)
      && /^\d+$/.test(binding.owner) && /^\d+$/.test(binding.changeTimeNs);
  const socketRoot = String(value.socketRoot || "");
  const supervisorSocket = String(value.supervisorSocketPath || "");
  const daemonSocket = String(value.daemonSocketPath || "");
  const validSocketPaths = path.isAbsolute(socketRoot)
    && path.resolve(socketRoot) === socketRoot
    && socketPathsFit(socketRoot)
    && path.dirname(supervisorSocket) === socketRoot && path.basename(supervisorSocket) === "supervisor.sock"
    && path.dirname(daemonSocket) === socketRoot && path.basename(daemonSocket) === "daemon.sock";
  if (value.version !== 2 || !AUTHORIZATION.test(String(value.token || "")) || !validBinding(value.supervisor)
      || !validSocketPaths
      || (value.supervisorSocket !== undefined && !validSocketBinding(value.supervisorSocket))
      || (value.daemon !== undefined && !validBinding(value.daemon))
      || (value.daemonSocket !== undefined && (!value.daemon || !validSocketBinding(value.daemonSocket)))) {
    throw new Error("daemon control authority 无效");
  }
  return value as ControlAuthority;
}

// The authority file is the single trust anchor between supervisor and daemon.
// If it goes missing while the supervisor stays up (e.g. a crashed restart
// cycle deleted it), the daemon re-establishes it from the supervisor's process
// state instead of dying at startup and crash-looping. Only a missing file is
// healed; a token mismatch stays fail-closed.
function secureAuthorityOrRecover(larkinHome: string, authorityToken: string): ControlAuthority {
  try {
    return secureAuthority(larkinHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // The real trust anchor is the supervisor identity: recovery only proceeds
    // when supervisor-status.json describes a live, token-carrying supervisor
    // process, and the token written here is the one that supervisor injected
    // into this daemon. The sameSecret check after recovery is a tautology for
    // the missing-file case; the supervisor's own control-server start re-verifies
    // the file against its token, so a forged file still fails closed there.
    const supervisor = readProcessState(larkinHome).supervisor;
    if (supervisor.state !== "owned" || !supervisor.pid || !supervisor.processStartToken) throw error;
    initializeControlAuthority(
      larkinHome,
      { pid: Number(supervisor.pid), processStartToken: supervisor.processStartToken },
      authorityToken,
    );
    return secureAuthority(larkinHome);
  }
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bindingMatches(binding: ProcessBinding, record: { pid?: unknown; processStartToken?: unknown }): boolean {
  return binding.pid === Number(record.pid) && binding.processStartToken === record.processStartToken;
}

function socketBinding(stat: fs.BigIntStats): SocketBinding {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    owner: String(stat.uid),
    changeTimeNs: String(stat.ctimeNs),
  };
}

function socketObjectMatches(binding: SocketBinding, stat: fs.BigIntStats): boolean {
  return binding.device === String(stat.dev) && binding.inode === String(stat.ino)
    && binding.owner === String(stat.uid);
}

function socketBindingMatches(binding: SocketBinding, stat: fs.BigIntStats): boolean {
  return socketObjectMatches(binding, stat) && binding.changeTimeNs === String(stat.ctimeNs);
}

function inspectOwnedSocket(socket: string): { stat: fs.BigIntStats; binding: SocketBinding } {
  const stat = fs.lstatSync(socket, { bigint: true });
  if (!stat.isSocket() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid()))) {
    throw new Error("control socket identity 不安全");
  }
  return { stat, binding: socketBinding(stat) };
}

function assertLiveAuthority(larkinHome: string, expectedToken?: string): ControlAuthority {
  const authority = secureAuthority(larkinHome);
  if (expectedToken && !sameSecret(authority.token, expectedToken)) throw new Error("daemon control authorization 已失效");
  const { supervisor, daemon } = readProcessState(larkinHome);
  if (supervisor.state !== "owned" || !bindingMatches(authority.supervisor, supervisor)) {
    throw new Error("daemon control supervisor identity 已失效");
  }
  if (!authority.daemon || daemon.state !== "owned" || !bindingMatches(authority.daemon, daemon)) {
    throw new Error("daemon control daemon identity 已失效");
  }
  return authority;
}

function assertSupervisorAuthority(larkinHome: string, expectedToken?: string): ControlAuthority {
  const authority = secureAuthority(larkinHome);
  if (expectedToken && !sameSecret(authority.token, expectedToken)) throw new Error("supervisor control authorization 已失效");
  const supervisor = readProcessState(larkinHome).supervisor;
  if (supervisor.state !== "owned" || !bindingMatches(authority.supervisor, supervisor)) {
    throw new Error("supervisor control identity 已失效");
  }
  return authority;
}

function prepareSocket(socket: string): void {
  if (isWindows) {
    // Windows：socket 路径无法 lstat（EACCES）；尽力清除陈旧占用，失败即忽略，
    // 由 listen 的独占语义兜底（见 listenPrivate 的 win32 分支）。
    try { fs.unlinkSync(socket); } catch { /* ignore */ }
    return;
  }
  try {
    const stat = fs.lstatSync(socket);
    if (!stat.isSocket() || stat.isSymbolicLink()
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("control socket 路径被不安全文件占用");
    }
    fs.unlinkSync(socket);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function cleanupSocketRoot(root: string): void {
  try { fs.rmdirSync(root); }
  catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes(String((error as NodeJS.ErrnoException).code || ""))) throw error;
  }
}

async function closePrivateServer(
  server: net.Server,
  socket: string,
  identity: SocketBinding | null,
): Promise<void> {
  if (isWindows) {
    // Windows：socket 无 lstat 身份可比对，直接关服并清理目录（残留由 ENOTEMPTY 忽略）。
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    cleanupSocketRoot(path.dirname(socket));
    return;
  }
  let shield: string | null = null;
  let closeError: unknown;
  try {
    let current: fs.BigIntStats | null = null;
    try { current = fs.lstatSync(socket, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current && (!identity || !socketBindingMatches(identity, current))) {
      // The runtime unlinks its original Unix pathname during server.close(). Move a
      // replacement entry aside so closing the old server cannot delete it.
      shield = `${socket}.replacement-${crypto.randomUUID()}`;
      fs.renameSync(socket, shield);
    }
    if (server.listening) {
      await new Promise<void>((resolve) => server.close((error) => {
        if (error) closeError = error;
        resolve();
      }));
    }
    if (!shield && identity) {
      try {
        const after = fs.lstatSync(socket, { bigint: true });
        if (after.isSocket() && !after.isSymbolicLink() && socketBindingMatches(identity, after)) fs.unlinkSync(socket);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } finally {
    if (shield) {
      try {
        fs.lstatSync(socket);
        throw new Error(`replacement socket 恢复失败，原路径已被再次占用；保留于 ${shield}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") fs.renameSync(shield, socket);
        else throw error;
      }
    }
    cleanupSocketRoot(path.dirname(socket));
  }
  if (closeError) throw closeError;
}

async function listenPrivate(server: net.Server, socket: string): Promise<SocketBinding> {
  if (isWindows) {
    // Windows：bun 的 unix socket 可正常 listen/connect/chmod/close，但 lstatSync(socket)
    // 抛 EACCES（socket 不是普通文件系统节点）。因此跳过 lstat 身份比对，安全边界
    // 由 assertSecureSocketDirectory 收紧的目录 ACL 承担。
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, () => { server.off("error", reject); resolve(); });
      });
      try { fs.chmodSync(socket, 0o600); } catch { /* Windows chmod best-effort */ }
      return WINDOWS_SOCKET_BINDING;
    } catch (error) {
      await closePrivateServer(server, socket, WINDOWS_SOCKET_BINDING);
      throw error;
    }
  }
  let identity: SocketBinding | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => { server.off("error", reject); resolve(); });
    });
    identity = inspectOwnedSocket(socket).binding;
    const deadline = Date.now() + 1_000;
    for (;;) {
      try { fs.chmodSync(socket, 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    }
    const secured = inspectOwnedSocket(socket);
    if (!socketObjectMatches(identity, secured.stat)) {
      throw new Error("control socket 在权限收紧期间被其他 server 替换");
    }
    identity = secured.binding;
    return identity;
  } catch (error) {
    await closePrivateServer(server, socket, identity);
    throw error;
  }
}

function writeControlAuthority(larkinHome: string, authority: ControlAuthority): void {
  atomicWritePrivateJson(controlAuthorityPath(larkinHome), authority);
}

export function initializeControlAuthority(larkinHome: string, supervisor: ProcessBinding, explicitToken?: string): string {
  fs.mkdirSync(larkinHome, { recursive: true, mode: 0o700 });
  assertSecureRoot(larkinHome);
  const socketRoot = ensureSecureSocketRoot(larkinHome);
  const token = explicitToken ?? crypto.randomBytes(32).toString("base64url");
  writeControlAuthority(larkinHome, {
    version: 2,
    token,
    socketRoot,
    supervisorSocketPath: path.join(socketRoot, "supervisor.sock"),
    daemonSocketPath: path.join(socketRoot, "daemon.sock"),
    supervisor,
  });
  return token;
}

export function removeControlAuthority(larkinHome: string, expectedToken: string): void {
  try {
    const authority = secureAuthority(larkinHome);
    if (sameSecret(authority.token, expectedToken)) {
      fs.unlinkSync(controlAuthorityPath(larkinHome));
      cleanupSocketRoot(authority.socketRoot);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function createSupervisorControlServer({
  larkinHome,
  authorityToken,
  ensureDashboard,
}: {
  larkinHome: string;
  authorityToken: string;
  ensureDashboard(): Promise<string> | string;
}): { start(): Promise<void>; close(): Promise<void> } {
  let socket = "";
  let socketRoot = "";
  let socketIdentity: SocketBinding | null = null;
  const completed = new Map<string, DashboardRecoveryResponse>();
  let server: net.Server | null = null;
  return {
    async start(): Promise<void> {
      const authority = assertSupervisorAuthority(larkinHome, authorityToken);
      socketRoot = assertSecureSocketDirectory(authority.socketRoot);
      socket = authority.supervisorSocketPath;
      prepareSocket(socket);
      server = net.createServer((connection) => {
        connection.setEncoding("utf8");
        let input = "";
        connection.on("data", (chunk) => {
          input += chunk;
          if (input.length > 4096) connection.destroy(new Error("control request too large"));
          const newline = input.indexOf("\n");
          if (newline < 0) return;
          const line = input.slice(0, newline);
          input = "";
          void (async () => {
            let request: { operationId: string; operation: string; authorization: string };
            try {
              request = JSON.parse(line) as typeof request;
              if (!OPERATION_ID.test(String(request.operationId || "")) || request.operation !== "ensure-dashboard"
                  || !AUTHORIZATION.test(String(request.authorization || ""))
                  || Object.keys(request).some((key) => !["operationId", "operation", "authorization"].includes(key))) {
                throw new Error("invalid supervisor control request");
              }
              const authority = assertSupervisorAuthority(larkinHome, authorityToken);
              if (!sameSecret(authority.token, request.authorization)) throw new Error("unauthorized supervisor control request");
            } catch {
              connection.end(`${JSON.stringify({ ok: false, operationId: "invalid", error: "unauthorized supervisor control request" })}\n`);
              return;
            }
            const replay = completed.get(request.operationId);
            if (replay) { connection.end(`${JSON.stringify(replay)}\n`); return; }
            let response: DashboardRecoveryResponse;
            try { response = { ok: true, operationId: request.operationId, state: await ensureDashboard() }; }
            catch (error) { response = { ok: false, operationId: request.operationId, error: error instanceof Error ? error.message : String(error) }; }
            completed.set(request.operationId, response);
            while (completed.size > 256) completed.delete(completed.keys().next().value as string);
            connection.end(`${JSON.stringify(response)}\n`);
          })();
        });
      });
      try {
        socketIdentity = await listenPrivate(server, socket);
        const liveAuthority = secureAuthority(larkinHome);
        if (!sameSecret(liveAuthority.token, authorityToken)) throw new Error("supervisor control authorization 已失效");
        atomicWritePrivateJson(controlAuthorityPath(larkinHome), {
          ...liveAuthority,
          supervisorSocket: socketIdentity,
        });
      }
      catch (error) {
        if (server && socketIdentity) await closePrivateServer(server, socket, socketIdentity);
        server = null;
        socketIdentity = null;
        throw error;
      }
    },
    async close(): Promise<void> {
      const active = server;
      server = null;
      if (active && socket) await closePrivateServer(active, socket, socketIdentity);
      else if (socketRoot) cleanupSocketRoot(socketRoot);
      socketIdentity = null;
    },
  };
}

export function createAgentControlServer({
  larkinHome,
  authorityToken,
  upsert,
  resetSession,
  maxRememberedOperations = 256,
}: {
  larkinHome: string;
  authorityToken: string;
  upsert(request: AgentUpsertOperation): Promise<void>;
  resetSession?(request: { agentId: string; waitReadyMs: number }): Promise<SessionResetResponse>;
  maxRememberedOperations?: number;
}): { start(): Promise<void>; close(): Promise<void> } {
  let socket = "";
  let socketRoot = "";
  let socketIdentity: SocketBinding | null = null;
  const completed = new Map<string, AgentUpsertResponse>();
  const inFlight = new Map<string, { agentId: string; response: Promise<AgentUpsertResponse> }>();
  const resetInFlight = new Map<string, Promise<SessionResetResponse>>();
  const agentQueues = new Map<string, Promise<unknown>>();
  const upsertConflict = (operationId: string, agentId: string): AgentUpsertResponse => ({
    ok: false, operationId, agentId, code: "operation_conflict", error: "operationId 已绑定其他 Agent 或操作",
  });
  let server: net.Server | null = null;
  return {
    async start(): Promise<void> {
      fs.mkdirSync(larkinHome, { recursive: true, mode: 0o700 });
      assertSecureRoot(larkinHome);
      removeLegacyResetLedger(larkinHome);
      const authority = secureAuthorityOrRecover(larkinHome, authorityToken);
      if (!sameSecret(authority.token, authorityToken)) throw new Error("daemon control authorization 不匹配");
      const supervisor = readProcessState(larkinHome).supervisor;
      if (supervisor.state !== "owned" || !bindingMatches(authority.supervisor, supervisor)) {
        throw new Error("daemon control supervisor identity 无效");
      }
      const daemonMetadata = currentProcessMetadata(processCommandToken("daemon", "app/runtime-process.mjs"));
      if (!daemonMetadata.processStartToken) throw new Error("daemon control 无法取得 daemon start identity");
      atomicWritePrivateJson(controlAuthorityPath(larkinHome), {
        ...authority,
        daemon: { pid: process.pid, processStartToken: daemonMetadata.processStartToken },
      });
      socketRoot = assertSecureSocketDirectory(authority.socketRoot);
      socket = authority.daemonSocketPath;
      prepareSocket(socket);
      server = net.createServer((connection) => {
        connection.setEncoding("utf8");
        let input = "";
        connection.on("data", (chunk) => {
          input += chunk;
          if (input.length > 4096) connection.destroy(new Error("control request too large"));
          const newline = input.indexOf("\n");
          if (newline < 0) return;
          const line = input.slice(0, newline);
          input = "";
          void (async () => {
            let request: AgentControlRequest;
            try { request = parseRequest(line); }
            catch (error) {
              connection.end(`${JSON.stringify({ ok: false, agentId: "invalid", error: (error as Error).message })}\n`);
              return;
            }
            try {
              const live = assertLiveAuthority(larkinHome, authorityToken);
              if (!sameSecret(live.token, request.authorization)) throw new Error("unauthorized control request");
            } catch {
              connection.end(`${JSON.stringify({ ok: false, ...("operation" in request ? {} : { operationId: request.operationId }),
                agentId: request.agentId, error: "unauthorized control request" })}\n`);
              return;
            }
            if ("operation" in request) {
              const resetRequest = request;
              let operation = resetInFlight.get(resetRequest.agentId);
              if (!operation) {
                const executeReset = async (): Promise<SessionResetResponse> => {
                  try {
                    if (!resetSession) throw new Error("session reset control unavailable");
                    return await resetSession({ agentId: resetRequest.agentId, waitReadyMs: resetRequest.waitReadyMs ?? 30_000 });
                  } catch (error) {
                    const code = typeof (error as { code?: unknown }).code === "string"
                      ? String((error as { code: string }).code)
                      : error instanceof RuntimePrerequisiteError && error.readiness.state === "unavailable"
                        ? "runtime_unavailable" : "reset_refused";
                    const projection = error as Partial<Pick<SessionResetResponse,
                      "turns" | "runtimeReady" | "channelConnected" | "reconnecting" | "pendingCount">>;
                    return { ok: false, agentId: resetRequest.agentId, code,
                      error: error instanceof Error ? error.message : String(error), resetCommitted: false,
                      generationChanged: false, sessionChanged: false,
                      turns: Math.max(0, Number(projection.turns) || 0), runtimeReady: projection.runtimeReady === true,
                      channelConnected: projection.channelConnected === true, reconnecting: projection.reconnecting === true,
                      pendingCount: Math.max(0, Number(projection.pendingCount) || 0),
                      readyForFreshScenario: false, inboundObserved: false,
                      ...(error instanceof RuntimePrerequisiteError ? { readiness: error.readiness } : {}) };
                  }
                };
                const prior = agentQueues.get(resetRequest.agentId) ?? Promise.resolve();
                const executing = prior.catch(() => {}).then(executeReset);
                let queued: Promise<SessionResetResponse>;
                queued = executing.finally(() => {
                  if (agentQueues.get(resetRequest.agentId) === queued) agentQueues.delete(resetRequest.agentId);
                  if (resetInFlight.get(resetRequest.agentId) === queued) resetInFlight.delete(resetRequest.agentId);
                });
                agentQueues.set(resetRequest.agentId, queued);
                resetInFlight.set(resetRequest.agentId, queued);
                operation = queued;
              }
              const response = await operation;
              connection.end(`${JSON.stringify(response)}\n`);
              return;
            }
            const upsertRequest = request;
            const replay = completed.get(upsertRequest.operationId);
            if (replay) {
              connection.end(`${JSON.stringify(replay.agentId === upsertRequest.agentId
                ? replay : upsertConflict(upsertRequest.operationId, upsertRequest.agentId))}\n`);
              return;
            }
            const existing = inFlight.get(upsertRequest.operationId);
            if (existing && existing.agentId !== upsertRequest.agentId) {
              connection.end(`${JSON.stringify(upsertConflict(upsertRequest.operationId, upsertRequest.agentId))}\n`);
              return;
            }
            const execute = async (): Promise<AgentUpsertResponse> => {
              try {
                await upsert({ operationId: upsertRequest.operationId, agentId: upsertRequest.agentId });
                return { ok: true, operationId: upsertRequest.operationId, agentId: upsertRequest.agentId };
              } catch (error) {
                return { ok: false, operationId: upsertRequest.operationId, agentId: upsertRequest.agentId,
                  error: error instanceof Error ? error.message : String(error),
                  ...(error instanceof RuntimePrerequisiteError ? { readiness: error.readiness } : {}) };
              }
            };
            let operation = existing?.response;
            if (!operation) {
              const prior = agentQueues.get(upsertRequest.agentId) ?? Promise.resolve();
              operation = prior.catch(() => {}).then(execute);
              const queued = operation.finally(() => {
                if (agentQueues.get(upsertRequest.agentId) === queued) agentQueues.delete(upsertRequest.agentId);
              });
              agentQueues.set(upsertRequest.agentId, queued);
              inFlight.set(upsertRequest.operationId, { agentId: upsertRequest.agentId, response: operation });
            }
            const response = await operation;
            inFlight.delete(upsertRequest.operationId);
            completed.set(upsertRequest.operationId, response);
            while (completed.size > maxRememberedOperations) completed.delete(completed.keys().next().value as string);
            connection.end(`${JSON.stringify(response)}\n`);
          })();
        });
      });
      try {
        socketIdentity = await listenPrivate(server, socket);
        const liveAuthority = secureAuthority(larkinHome);
        if (!sameSecret(liveAuthority.token, authorityToken)) throw new Error("daemon control authorization 已失效");
        atomicWritePrivateJson(controlAuthorityPath(larkinHome), {
          ...liveAuthority,
          daemonSocket: socketIdentity,
        });
      } catch (error) {
        if (server && socketIdentity) await closePrivateServer(server, socket, socketIdentity);
        server = null;
        socketIdentity = null;
        throw error;
      }
    },
    async close(): Promise<void> {
      const active = server;
      server = null;
      if (active && socket) await closePrivateServer(active, socket, socketIdentity);
      else if (socketRoot) cleanupSocketRoot(socketRoot);
      socketIdentity = null;
    },
  };
}

async function sendSupervisorRecovery(larkinHome: string, operationId: string, timeoutMs: number): Promise<DashboardRecoveryResponse> {
  const authority = assertSupervisorAuthority(larkinHome);
  assertSecureSocketDirectory(authority.socketRoot);
  const socket = authority.supervisorSocketPath;
  const stat = fs.lstatSync(socket);
  if (!stat.isSocket() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || !notGroupOrWorldAccessible(stat)) throw new Error("supervisor control socket 不安全");
  return await new Promise<DashboardRecoveryResponse>((resolve, reject) => {
    const client = net.createConnection(socket);
    const timer = setTimeout(() => { client.destroy(); reject(new Error("dashboard recovery control timeout")); }, timeoutMs);
    let input = "";
    client.setEncoding("utf8");
    client.once("error", (error) => { clearTimeout(timer); reject(error); });
    client.once("connect", () => client.write(`${JSON.stringify({
      operationId, operation: "ensure-dashboard", authorization: authority.token,
    })}\n`));
    client.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      client.end();
      try { resolve(JSON.parse(input.slice(0, newline)) as DashboardRecoveryResponse); }
      catch (error) { reject(error); }
    });
  });
}

export async function requestDashboardRecovery({
  larkinHome,
  operationId = crypto.randomUUID(),
  timeoutMs = 30_000,
}: {
  larkinHome: string;
  operationId?: string;
  timeoutMs?: number;
}): Promise<DashboardRecoveryResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { return await sendSupervisorRecovery(larkinHome, operationId, Math.max(100, deadline - Date.now())); }
    catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !["ENOENT", "ECONNREFUSED"].includes(code)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("supervisor control unavailable");
}

async function requestAgentControl<T>({
  larkinHome,
  timeoutMs = 30_000,
  request,
}: {
  larkinHome: string;
  timeoutMs?: number;
  request: AgentControlPayload;
}): Promise<T> {
  const { supervisor, daemon } = readProcessState(larkinHome);
  if (supervisor.state !== "owned") throw new Error(`supervisor control ownership=${supervisor.state}（${supervisor.reason}）`);
  if (daemon.state !== "owned") throw new Error(`daemon control ownership=${daemon.state}（${daemon.reason}）`);
  const authority = assertLiveAuthority(larkinHome);
  assertSecureSocketDirectory(authority.socketRoot);
  const socket = authority.daemonSocketPath;
  const stat = fs.lstatSync(socket);
  if (!stat.isSocket() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || !notGroupOrWorldAccessible(stat)) throw new Error("daemon control socket 不安全");
  return await new Promise<T>((resolve, reject) => {
    const client = net.createConnection(socket);
    const timer = setTimeout(() => { client.destroy(); reject(new Error("agent control timeout")); }, timeoutMs);
    let input = "";
    client.setEncoding("utf8");
    client.once("error", (error) => { clearTimeout(timer); reject(error); });
    client.once("connect", () => client.write(`${JSON.stringify({ ...request, authorization: authority.token })}\n`));
    client.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      client.end();
      try { resolve(JSON.parse(input.slice(0, newline)) as T); }
      catch (error) { reject(error); }
    });
  });
}

export async function requestAgentUpsert(input: {
  larkinHome: string;
  agentId: string;
  operationId?: string;
  timeoutMs?: number;
}): Promise<AgentUpsertResponse> {
  return requestAgentControl<AgentUpsertResponse>({ larkinHome: input.larkinHome, timeoutMs: input.timeoutMs,
    request: { operationId: input.operationId ?? crypto.randomUUID(), agentId: input.agentId } });
}

export async function requestSessionReset({
  larkinHome,
  agentId,
  waitReadyMs = 30_000,
}: {
  larkinHome: string;
  agentId: string;
  waitReadyMs?: number;
}): Promise<SessionResetResponse> {
  return requestAgentControl<SessionResetResponse>({
    larkinHome, timeoutMs: Math.max(1_000, waitReadyMs + 1_000),
    request: { operation: "session-reset", agentId, waitReadyMs },
  });
}

export function cleanupStaleAgentControlSocket(larkinHome: string, expectedToken: string): "removed" | "absent" {
  const authority = secureAuthority(larkinHome);
  if (!sameSecret(authority.token, expectedToken)) throw new Error("daemon control authorization 已失效");
  const root = assertSecureSocketDirectory(authority.socketRoot);
  const socket = authority.daemonSocketPath;
  if (path.dirname(socket) !== root || path.basename(socket) !== "daemon.sock") {
    throw new Error("daemon control socket 路径不属于认证 control root");
  }
  try {
    const stat = fs.lstatSync(socket, { bigint: true });
    if (!stat.isSocket() || stat.isSymbolicLink()
        || (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid()))) {
      throw new Error("拒绝清理不安全的 daemon control socket");
    }
    if (!authority.daemonSocket || !socketBindingMatches(authority.daemonSocket, stat)) {
      throw new Error("拒绝清理已被其他 server 替换的 daemon control socket");
    }
    fs.unlinkSync(socket);
    cleanupSocketRoot(root);
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    cleanupSocketRoot(root);
    return "absent";
  }
}
