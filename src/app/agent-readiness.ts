import type { OwnedProcessRecord } from "../platform/process-state.js";
import { daemonHasAgent } from "../platform/process-state.js";

export interface AgentReadinessStatus {
  connectedAt?: string;
  connectedVia?: string;
  inboundVerifiedAt?: string;
  reconnectingAt?: string | null;
  reconnectedAt?: string | null;
  runtimeReadiness?: { state?: "missing" | "unauthenticated" | "incompatible" | "ready" | "unavailable"; observedAt?: string };
  session?: { startedAt?: string; id?: string | null; [key: string]: unknown };
}

function timestamp(value: unknown): number | null {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function isRuntimeReadinessCurrent(
  readiness: AgentReadinessStatus["runtimeReadiness"] | null | undefined,
  daemonStartedAt: unknown,
): boolean {
  if (readiness?.state !== "ready") return false;
  const observedAt = timestamp(readiness.observedAt);
  const epoch = timestamp(daemonStartedAt);
  return observedAt !== null && epoch !== null && observedAt >= epoch;
}

export function isCurrentOwnedDaemon(daemon: OwnedProcessRecord | null | undefined): boolean {
  return daemon?.state === "owned"
    && Number(daemon.pid) > 0
    && typeof daemon.processStartToken === "string" && daemon.processStartToken.length > 0
    && timestamp(daemon.startedAt) !== null;
}

export function isChannelReconnecting(status?: AgentReadinessStatus | null): boolean {
  const reconnectingAt = timestamp(status?.reconnectingAt);
  const connectedAt = timestamp(status?.connectedAt);
  const reconnectedAt = timestamp(status?.reconnectedAt);
  const latestConnectedAt = Math.max(connectedAt ?? Number.NEGATIVE_INFINITY, reconnectedAt ?? Number.NEGATIVE_INFINITY);
  return reconnectingAt !== null && reconnectingAt > latestConnectedAt;
}

export function projectAgentReadiness(input: {
  agentId: string;
  daemon: OwnedProcessRecord;
  status?: AgentReadinessStatus | null;
}): {
  ready: boolean;
  readiness: {
    daemon_owned: boolean;
    runtime_ready: boolean;
    channel_connected: boolean;
    channel_not_reconnecting: boolean;
  };
  channel: { connected_at: string | null; connected_via: string | null; inbound_verified_at: string | null };
} {
  const status = input.status ?? null;
  const daemonOwned = isCurrentOwnedDaemon(input.daemon) && daemonHasAgent(input.daemon, input.agentId);
  const daemonStartedAt = timestamp(input.daemon.startedAt);
  const connectedAt = timestamp(status?.connectedAt);
  const sessionStartedAt = timestamp(status?.session?.startedAt);
  const sessionCurrent = daemonStartedAt !== null && sessionStartedAt !== null && sessionStartedAt >= daemonStartedAt;
  const channelConnected = daemonOwned
    && status?.connectedVia === "channel"
    && daemonStartedAt !== null
    && connectedAt !== null
    && connectedAt >= daemonStartedAt;
  const readiness = {
    daemon_owned: daemonOwned,
    runtime_ready: daemonOwned && sessionCurrent && isRuntimeReadinessCurrent(status?.runtimeReadiness, input.daemon.startedAt),
    channel_connected: channelConnected,
    channel_not_reconnecting: !isChannelReconnecting(status),
  };
  return {
    ready: Object.values(readiness).every(Boolean),
    readiness,
    channel: {
      connected_at: connectedAt === null ? null : status?.connectedAt ?? null,
      connected_via: status?.connectedVia || null,
      inbound_verified_at: timestamp(status?.inboundVerifiedAt) === null ? null : status?.inboundVerifiedAt ?? null,
    },
  };
}
