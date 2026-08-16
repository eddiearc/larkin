import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { inspectProcess } from "../../dist/platform/process-state.mjs";

export const HOLD_DRIVER_BASENAME = "runtime-agent-interface-v2-hold-host.mjs";
export const HOLD_HOST_COMMAND_TOKEN = "app/runtime-process.mjs";
export const HOLD_TEMP_ROOT_PREFIX = "larkin-runtime-interface-v2-hold-";
export const HOLD_READY_BASENAME = "runtime-interface-v2-hold-host-ready.json";
export const HOLD_TRACE_BASENAME = "runtime-interface-v2-hold-host-boundary.ndjson";
export const HOLD_SENTINEL_BASENAME = ".runtime-interface-v2-hold-host-root.json";
export const HOLD_READY_SCHEMA = "larkin.runtime-agent-interface-v2.hold-host-ready";
export const HOLD_SENTINEL_SCHEMA = "larkin.runtime-agent-interface-v2.hold-host-root";
export const HOLD_READY_MAX_AGE_MS = 120_000;
const SYSTEM_PS = "/bin/ps";
const SYSTEM_WHICH = "/usr/bin/which";
const OUTPUT_SHAPE_BYTE_CAP = 4096;
const OUTPUT_SHAPE_LINE_CAP = 20;
const SAFE_ERROR_TYPES = new Set([
  "api", "api_error", "auth", "auth_error", "authentication", "authorization", "authorization_error",
  "provider", "provider_error", "validation", "validation_error",
]);
const SAFE_ERROR_SUBTYPES = new Set([
  "api", "api_error", "app_scope_not_applied", "auth", "auth_error", "authentication", "authorization",
  "authorization_error", "missing_scope", "provider", "provider_error", "validation", "validation_error",
]);
const SAFE_MISSING_SCOPES = new Set([
  "im:message:readonly",
  "im:chat:readonly",
  "im:chat",
  "im:chat.group_info:readonly",
  "im:chat.members:read",
  "im:message.send_as_user",
  "im:message",
]);
const IDEMPOTENCY_KEY_MAX_BYTES = 50;

export function liveUpdateIdempotencyKey(nonce) {
  if (typeof nonce !== "string" || nonce.length === 0) throw new Error("live update nonce must be a non-empty string");
  const key = `lk-${nonce}`;
  if (Buffer.byteLength(key) > IDEMPOTENCY_KEY_MAX_BYTES) {
    throw new Error(`live update idempotency key must not exceed ${IDEMPOTENCY_KEY_MAX_BYTES} bytes`);
  }
  return key;
}

function redactedStreamShape(value) {
  const output = typeof value === "string" ? value : String(value ?? "");
  const byteLength = Buffer.byteLength(output);
  const lineCount = output.length === 0 ? 0 : output.split(/\r?\n/).length;
  return {
    present: byteLength > 0,
    byteLength: Math.min(byteLength, OUTPUT_SHAPE_BYTE_CAP),
    byteLengthCapped: byteLength > OUTPUT_SHAPE_BYTE_CAP,
    lineCount: Math.min(lineCount, OUTPUT_SHAPE_LINE_CAP),
    lineCountCapped: lineCount > OUTPUT_SHAPE_LINE_CAP,
  };
}

export function redactedProcessOutputShape(result) {
  return {
    stdout: redactedStreamShape(result?.stdout),
    stderr: redactedStreamShape(result?.stderr),
  };
}

function parseJsonObject(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function safeCategory(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function safeScopes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((scope) => typeof scope === "string" && SAFE_MISSING_SCOPES.has(scope)))];
}

export function redactedProcessFailureDiagnostic(result) {
  const payloads = [result?.stdout, result?.stderr].map(parseJsonObject).filter((value) => value !== null);
  if (payloads.length === 0) return { outputShape: redactedProcessOutputShape(result) };

  const diagnostic = {};
  for (const payload of payloads) {
    const sourceError = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
      ? payload.error : {};
    const error = {};
    const type = safeCategory(sourceError.type, SAFE_ERROR_TYPES);
    const subtype = safeCategory(sourceError.subtype, SAFE_ERROR_SUBTYPES);
    if (type !== undefined) error.type = type;
    if (subtype !== undefined) error.subtype = subtype;
    if (Object.keys(error).length > 0) {
      diagnostic.error ||= {};
      for (const [key, value] of Object.entries(error)) {
        if (diagnostic.error[key] === undefined) diagnostic.error[key] = value;
      }
    }

    const scopes = safeScopes(sourceError.missing_scopes ?? payload.missing_scopes);
    if (scopes.length > 0) diagnostic.missing_scopes = [
      ...new Set([...(diagnostic.missing_scopes || []), ...scopes]),
    ];
    if ((payload.identity === "user" || payload.identity === "bot") && diagnostic.identity === undefined) {
      diagnostic.identity = payload.identity;
    }
  }
  return Object.keys(diagnostic).length > 0
    ? diagnostic
    : { outputShape: redactedProcessOutputShape(result) };
}

function owned(stat) {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function rootIdentity(stat) {
  return { device: String(stat.dev), inode: String(stat.ino) };
}

export function writePrivateJson(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function assertProductionInspectUsesTrustedPs(env = process.env) {
  const resolved = spawnSync(SYSTEM_WHICH, ["ps"], { env, encoding: "utf8" });
  if (resolved.error || resolved.status !== 0
      || fs.realpathSync(String(resolved.stdout || "").trim()) !== fs.realpathSync(SYSTEM_PS)) {
    throw new Error("production process inspection would not resolve the trusted system ps binary");
  }
}

export function readPrivateJson(file, label) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !owned(stat) || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) {
      throw new Error(`${label} must be an owned 0600 regular file`);
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`${label} must not be a symlink`);
    if (error instanceof SyntaxError) throw new Error(`${label} must contain valid JSON`);
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function assertSafeClaimRoot(targetRoot, expectedIdentity) {
  const stat = fs.lstatSync(targetRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o777) !== 0o700) {
    throw new Error("hold-host root must remain an owned 0700 non-symlink directory");
  }
  const real = fs.realpathSync(targetRoot);
  const temp = fs.realpathSync(os.tmpdir());
  if (real !== targetRoot || path.dirname(real) !== temp || !path.basename(real).startsWith(HOLD_TEMP_ROOT_PREFIX)) {
    throw new Error("hold-host root path is no longer the claimed system-temp child");
  }
  const observed = rootIdentity(stat);
  if (expectedIdentity && (observed.device !== expectedIdentity.device || observed.inode !== expectedIdentity.inode)) {
    throw new Error("hold-host root inode identity changed");
  }
  return { stat, identity: observed };
}

export function claimHoldHostRoot(targetInput, { nonce = crypto.randomUUID(), ownerPid = process.pid } = {}) {
  if (!path.isAbsolute(targetInput)) throw new Error("isolated root must be absolute");
  const targetRoot = fs.realpathSync(targetInput);
  const { identity } = assertSafeClaimRoot(targetRoot);
  if (fs.readdirSync(targetRoot).length !== 0) throw new Error("isolated root must be empty before it is claimed");
  const sentinelFile = path.join(targetRoot, HOLD_SENTINEL_BASENAME);
  const readyFile = path.join(targetRoot, HOLD_READY_BASENAME);
  const sentinel = {
    schema: HOLD_SENTINEL_SCHEMA,
    version: 1,
    nonce,
    targetRoot,
    rootIdentity: identity,
    ownerPid,
  };
  writePrivateJson(sentinelFile, sentinel);
  return Object.freeze({ targetRoot, sentinelFile, readyFile, sentinel: Object.freeze(sentinel) });
}

function assertSentinel(claim) {
  assertSafeClaimRoot(claim.targetRoot, claim.sentinel.rootIdentity);
  const sentinel = readPrivateJson(claim.sentinelFile, "hold-host root sentinel");
  if (sentinel.schema !== HOLD_SENTINEL_SCHEMA || sentinel.version !== 1
      || sentinel.nonce !== claim.sentinel.nonce || sentinel.targetRoot !== claim.targetRoot
      || sentinel.ownerPid !== claim.sentinel.ownerPid
      || sentinel.rootIdentity?.device !== claim.sentinel.rootIdentity.device
      || sentinel.rootIdentity?.inode !== claim.sentinel.rootIdentity.inode) {
    throw new Error("hold-host root sentinel identity changed");
  }
  return sentinel;
}

export function cleanupClaimedHoldHostRoot(claim) {
  assertSentinel(claim);
  fs.rmSync(claim.targetRoot, { recursive: true, force: false, maxRetries: 2 });
  if (fs.existsSync(claim.targetRoot)) throw new Error("hold-host root cleanup left the root present");
}

function assertFresh(value, nowMs, label) {
  const observed = Date.parse(String(value || ""));
  if (!Number.isFinite(observed) || observed > nowMs + 5_000 || nowMs - observed > HOLD_READY_MAX_AGE_MS) {
    throw new Error(`${label} is missing or stale`);
  }
  return observed;
}

export function readyProofFor(claim, { agentId, identity, connectedAt, daemonStartedAt = connectedAt, boundaryAt = connectedAt }) {
  return {
    schema: HOLD_READY_SCHEMA,
    version: 2,
    ready: true,
    pid: identity.pid,
    processStartToken: identity.processStartToken,
    commandToken: identity.commandToken,
    driverCommandToken: HOLD_DRIVER_BASENAME,
    agentId,
    targetRoot: claim.targetRoot,
    rootIdentity: {
      ...claim.sentinel.rootIdentity,
      sentinelNonce: claim.sentinel.nonce,
    },
    connectedAt,
    daemonStartedAt,
    boundaryAt,
    agentCount: 1,
    runtimeDelivery: "always-deferred",
  };
}

export function validateLiveHoldHostReady(configDir, agentId, { nowMs = Date.now(), inspect = inspectProcess } = {}) {
  assertProductionInspectUsesTrustedPs();
  const targetRoot = fs.realpathSync(configDir);
  const { identity: observedRoot } = assertSafeClaimRoot(targetRoot);
  const readyFile = path.join(targetRoot, HOLD_READY_BASENAME);
  const sentinelFile = path.join(targetRoot, HOLD_SENTINEL_BASENAME);
  const ready = readPrivateJson(readyFile, "hold-host ready proof");
  const sentinel = readPrivateJson(sentinelFile, "hold-host root sentinel");
  if (ready.schema !== HOLD_READY_SCHEMA || ready.version !== 2 || ready.ready !== true
      || ready.agentId !== agentId || ready.targetRoot !== targetRoot
      || ready.agentCount !== 1 || ready.runtimeDelivery !== "always-deferred"
      || ready.commandToken !== HOLD_HOST_COMMAND_TOKEN || ready.driverCommandToken !== HOLD_DRIVER_BASENAME) {
    throw new Error("hold-host ready proof schema or fixed identity is invalid");
  }
  if (sentinel.schema !== HOLD_SENTINEL_SCHEMA || sentinel.version !== 1
      || sentinel.targetRoot !== targetRoot || sentinel.ownerPid !== ready.pid
      || ready.rootIdentity?.device !== observedRoot.device || ready.rootIdentity?.inode !== observedRoot.inode
      || sentinel.rootIdentity?.device !== observedRoot.device || sentinel.rootIdentity?.inode !== observedRoot.inode
      || ready.rootIdentity?.sentinelNonce !== sentinel.nonce) {
    throw new Error("hold-host ready proof is not bound to the claimed root sentinel/inode");
  }
  const pid = Number(ready.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("hold-host ready PID is invalid");
  const inspected = inspect(pid);
  if (!inspected?.ok || inspected.dead || inspected.startToken !== ready.processStartToken
      || typeof inspected.command !== "string" || !inspected.command.includes(HOLD_DRIVER_BASENAME)
      || !inspected.command.includes(HOLD_HOST_COMMAND_TOKEN)) {
    throw new Error("hold-host ready process identity is not live and exact");
  }
  assertFresh(ready.connectedAt, nowMs, "hold-host ready connectedAt");

  const config = readPrivateJson(path.join(targetRoot, "config.json"), "isolated config");
  const configuredAgents = config?.agents && typeof config.agents === "object" && !Array.isArray(config.agents)
    ? Object.keys(config.agents) : [];
  if (configuredAgents.length !== 1 || configuredAgents[0] !== agentId || config.activeAgent !== agentId) {
    throw new Error("isolated config is not exact single-Agent state");
  }
  const daemon = readPrivateJson(path.join(targetRoot, "daemon-status.json"), "hold-host daemon status");
  if (daemon.pid !== pid || daemon.processStartToken !== ready.processStartToken
      || daemon.commandToken !== HOLD_HOST_COMMAND_TOKEN
      || !Array.isArray(daemon.agents) || daemon.agents.length !== 1 || daemon.agents[0] !== agentId
      || daemon.startedAt !== ready.daemonStartedAt) {
    throw new Error("hold-host daemon status does not match ready proof");
  }
  const daemonStarted = assertFresh(daemon.startedAt, nowMs, "hold-host current daemon startedAt");
  const readyDaemonStarted = assertFresh(ready.daemonStartedAt, nowMs, "hold-host ready daemon epoch");
  if (readyDaemonStarted !== daemonStarted) throw new Error("hold-host daemon epoch changed");
  const statusFile = path.join(targetRoot, "state", "agents", agentId, "status.json");
  const status = readPrivateJson(statusFile, "hold-host channel status");
  const statusConnected = assertFresh(status.connectedAt, nowMs, "hold-host current channel connectedAt");
  const readinessObserved = assertFresh(status.runtimeReadiness?.observedAt, nowMs, "hold-host current Runtime readiness observedAt");
  const sessionStarted = assertFresh(status.session?.startedAt, nowMs, "hold-host current session startedAt");
  const readyConnected = Date.parse(ready.connectedAt);
  if (status.connectedVia !== "channel" || statusConnected < daemonStarted || readinessObserved < daemonStarted
      || sessionStarted < daemonStarted || statusConnected < readyConnected || status.reconnectingAt
      || fs.statSync(statusFile).mtimeMs < daemonStarted) {
    throw new Error("hold-host channel, Runtime, session, or status boundary is not current");
  }
  if (status.runtimeReadiness?.state !== "ready") throw new Error("hold-host Runtime readiness is not ready");
  const traceFile = path.join(targetRoot, HOLD_TRACE_BASENAME);
  const traceStat = fs.lstatSync(traceFile);
  if (!traceStat.isFile() || traceStat.isSymbolicLink() || (traceStat.mode & 0o777) !== 0o600) throw new Error("hold-host trace boundary is unsafe");
  const boundary = fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((entry) =>
    entry.phase === "hold-host:ready-boundary" && entry.pid === pid && Date.parse(String(entry.at || "")) >= daemonStarted);
  if (!boundary) throw new Error("hold-host log-or-trace boundary is missing or stale");
  assertFresh(ready.boundaryAt, nowMs, "hold-host ready boundary");
  if (Date.parse(String(ready.boundaryAt)) < daemonStarted) throw new Error("hold-host ready boundary predates daemon epoch");
  const channelFailed = (Array.isArray(status.recentErrors) ? status.recentErrors : []).some((entry) =>
    entry?.text === "channel ws 连接错误" && Date.parse(String(entry.at || "")) >= statusConnected);
  if (channelFailed) throw new Error("hold-host channel reported a websocket error after connecting");
  return { ready, status, inspected, daemon, boundary };
}

export function runProviderWithLiveHoldReady(
  configDir,
  agentId,
  providerRunner,
  { stage = "provider command", validate = validateLiveHoldHostReady } = {},
) {
  try {
    validate(configDir, agentId);
    // The first proof authorizes the stage; the second is deliberately adjacent
    // to the provider call so epoch/status changes cannot pass a stale preflight.
    validate(configDir, agentId);
  }
  catch (error) {
    throw new Error(`${stage} blocked because live hold-host proof failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return providerRunner();
}
